import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CAMPAIGN_MODES,
  buildBlogAdsetName,
  buildBlogImageAdName,
  buildBlogMixedPlan,
  buildBlogVideoAdName,
  formatDryRunPlan,
  getLandingUrlForAdset,
  normalizeCampaignMode,
  validateCampaignConfig,
} from '../src/campaign-config.js';

const fixedDate = new Date('2026-05-19T16:00:00.000Z'); // 2026-05-20 in Asia/Seoul

async function createBlogAssets(root, adsetCount = 5, imageCount = 4, includeVideo = true) {
  for (let adsetIndex = 1; adsetIndex <= adsetCount; adsetIndex += 1) {
    const imageDir = path.join(root, 'assets', 'blog', `adset_${adsetIndex}`, 'images');
    const videoDir = path.join(root, 'assets', 'blog', `adset_${adsetIndex}`, 'videos');
    await fs.mkdir(imageDir, { recursive: true });
    await fs.mkdir(videoDir, { recursive: true });
    for (let imageIndex = 1; imageIndex <= imageCount; imageIndex += 1) {
      await fs.writeFile(path.join(imageDir, `image${imageIndex}.jpg`), '');
    }
    if (includeVideo) {
      await fs.writeFile(path.join(videoDir, 'video1.mp4'), '');
    }
  }
}

async function createKoreanBlogAssets(root, adsetCount = 2, imageCount = 4, includeVideo = true) {
  for (let adsetIndex = 1; adsetIndex <= adsetCount; adsetIndex += 1) {
    const adsetDir = path.join(root, 'assets', 'blog', `0520 ${adsetIndex}번 광고세트-일예산 30만원-이미지 4개 + 영상 1개-익일 05시`);
    await fs.mkdir(adsetDir, { recursive: true });
    for (let imageIndex = 1; imageIndex <= imageCount; imageIndex += 1) {
      await fs.writeFile(path.join(adsetDir, `image${imageIndex}.jpg`), '');
    }
    if (includeVideo) {
      await fs.writeFile(path.join(adsetDir, 'video1.mp4'), '');
    }
  }
}

function blogEnv(root, overrides = {}) {
  return {
    CAMPAIGN_MODE: 'BLOG_MIXED',
    CAMPAIGN_NAME: 'Blog campaign',
    ADSET_COUNT: '5',
    BLOG_IMAGE_ADS_PER_ADSET: '4',
    BLOG_VIDEO_ADS_PER_ADSET: '1',
    BLOG_TOTAL_ADS_PER_ADSET: '5',
    BLOG_ADSET_NAME_PREFIX: 'f_i_b_o_l',
    BLOG_IMAGE_AD_NAME_PREFIX: 'f_i_b_o_l',
    BLOG_VIDEO_AD_NAME_PREFIX: 'f_v_b_o_l',
    TIMEZONE: 'Asia/Seoul',
    DATE_FORMAT: 'MMDD',
    BLOG_LANDING_URL_1: 'https://example.com/landing-1',
    BLOG_LANDING_URL_2: 'https://example.com/landing-2',
    BLOG_LANDING_URL_3: 'https://example.com/landing-3',
    BLOG_LANDING_URL_4: 'https://example.com/landing-4',
    BLOG_LANDING_URL_5: 'https://example.com/landing-5',
    BLOG_ASSET_ROOT: './assets/blog',
    ...overrides,
  };
}

test('BLOG_LANDING_URL_N maps by adset index', () => {
  const env = blogEnv(process.cwd());
  assert.equal(getLandingUrlForAdset(3, env), 'https://example.com/landing-3');
});

test('BLOG_MIXED naming uses Asia/Seoul MMDD', () => {
  const env = blogEnv(process.cwd());
  assert.equal(buildBlogAdsetName(1, env, fixedDate), 'f_i_b_o_l_0520_1');
  assert.equal(buildBlogImageAdName(4, env, fixedDate), 'f_i_b_o_l_0520_4');
  assert.equal(buildBlogVideoAdName(5, env, fixedDate), 'f_v_b_o_l_0520_5');
});

test('missing landing URL fails when ADSET_COUNT requires it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 5);
  const env = blogEnv(root);
  delete env.BLOG_LANDING_URL_4;
  await assert.rejects(
    () => buildBlogMixedPlan(env, { baseDir: root, date: fixedDate }),
    /Missing BLOG_LANDING_URL_4/,
  );
});

test('image asset count must be exactly 4', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 5, 3);
  await assert.rejects(
    () => buildBlogMixedPlan(blogEnv(root), { baseDir: root, date: fixedDate }),
    /exactly 4 image assets for adset 1/,
  );
});

test('video asset must exist exactly once by folder convention', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 5, 4, false);
  await assert.rejects(
    () => buildBlogMixedPlan(blogEnv(root), { baseDir: root, date: fixedDate }),
    /requires exactly 1 video asset for adset 1. Found 0/,
  );
});

test('video asset count above 1 fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 5);
  await fs.writeFile(path.join(root, 'assets', 'blog', 'adset_1', 'videos', 'video2.mp4'), '');
  await assert.rejects(
    () => buildBlogMixedPlan(blogEnv(root), { baseDir: root, date: fixedDate }),
    /requires exactly 1 video asset for adset 1. Found 2/,
  );
});

test('BLOG_ASSET_ROOT detects Korean adset folders with mixed media in one folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createKoreanBlogAssets(root, 2);
  const env = blogEnv(root, {
    ADSET_COUNT: '2',
    BLOG_ASSET_ROOT: './assets/blog',
  });
  const plan = await buildBlogMixedPlan(env, { baseDir: root, date: fixedDate, mmdd: '0520' });
  assert.equal(plan.adsets.length, 2);
  assert.equal(plan.adsets[0].imageAssets.length, 4);
  assert.match(plan.adsets[0].videoAsset, /video1\.mp4$/);
  assert.match(plan.adsets[1].imageAssets[0], /0520 2번 광고세트/);
});

test('IMAGE_ONLY mode validation stays lightweight', async () => {
  const result = await validateCampaignConfig({ CAMPAIGN_MODE: 'IMAGE_ONLY', ADSET_COUNT: '9' });
  assert.equal(result.mode, CAMPAIGN_MODES.IMAGE_ONLY);
  assert.equal(result.plan, null);
  assert.equal(normalizeCampaignMode(''), CAMPAIGN_MODES.IMAGE_ONLY);
});

test('dry-run plan lists image and video creatives without API calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 5);
  const plan = await buildBlogMixedPlan(blogEnv(root), { baseDir: root, date: fixedDate });
  const output = formatDryRunPlan(plan);
  assert.match(output, /campaign mode: BLOG_MIXED/);
  assert.match(output, /adset 1: f_i_b_o_l_0520_1/);
  assert.match(output, /image creative \| ad name: f_i_b_o_l_0520_1/);
  assert.match(output, /video creative \| ad name: f_v_b_o_l_0520_5/);
});
