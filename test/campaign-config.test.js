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
  buildVideoOnlyAdName,
  buildVideoOnlyAdsetName,
  buildVideoOnlyPlan,
  formatDryRunPlan,
  getImageOnlyAssetBySequence,
  getImageOnlyAssets,
  getLandingUrlForAdset,
  getVideoOnlyAssets,
  getVideoOnlyLandingUrl,
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

test('IMAGE_ONLY LEGACY mode validation stays lightweight', async () => {
  const result = await validateCampaignConfig({ CAMPAIGN_MODE: 'IMAGE_ONLY', IMAGE_ONLY_UPLOAD_MODE: 'LEGACY', ADSET_COUNT: '9' });
  assert.equal(result.mode, CAMPAIGN_MODES.IMAGE_ONLY);
  assert.equal(result.plan, null);
  assert.equal(normalizeCampaignMode(''), CAMPAIGN_MODES.IMAGE_ONLY);
});

test('IMAGE_ONLY PER_AD mode maps sorted image assets by ad sequence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-only-plan-'));
  const assetRoot = path.join(root, 'images');
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(assetRoot, 'image10.jpg'), '');
  await fs.writeFile(path.join(assetRoot, 'image2.jpg'), '');
  await fs.writeFile(path.join(assetRoot, 'image1.jpg'), '');
  await fs.writeFile(path.join(assetRoot, 'image3.png'), '');

  const env = {
    CAMPAIGN_MODE: 'IMAGE_ONLY',
    IMAGE_ONLY_UPLOAD_MODE: 'PER_AD',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '1',
    IMAGE_ONLY_ASSET_ROOT: './images',
  };
  const assets = await getImageOnlyAssets(env, { baseDir: root });
  assert.deepEqual(assets.map((asset) => path.basename(asset)), ['image1.jpg', 'image2.jpg', 'image3.png', 'image10.jpg']);
  assert.equal(path.basename(getImageOnlyAssetBySequence(assets, 2)), 'image2.jpg');

  const result = await validateCampaignConfig(env, { baseDir: root });
  assert.equal(result.mode, CAMPAIGN_MODES.IMAGE_ONLY);
  assert.equal(result.plan.uploadMode, 'PER_AD');
  assert.equal(result.plan.totalAds, 4);
});

test('IMAGE_ONLY defaults to per-ad upload mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-only-default-'));
  const assetRoot = path.join(root, 'images');
  await fs.mkdir(assetRoot, { recursive: true });
  for (let index = 1; index <= 4; index += 1) {
    await fs.writeFile(path.join(assetRoot, `image${index}.jpg`), '');
  }

  const result = await validateCampaignConfig({
    CAMPAIGN_MODE: 'IMAGE_ONLY',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '1',
    MEDIA_FOLDER_PATH: './images',
  }, { baseDir: root });

  assert.equal(result.mode, CAMPAIGN_MODES.IMAGE_ONLY);
  assert.equal(result.plan.uploadMode, 'PER_AD');
  assert.equal(result.plan.totalAds, 4);
});

test('IMAGE_ONLY allows ADSET_COUNT=0 as one actual adset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-only-zero-adset-'));
  const assetRoot = path.join(root, 'images');
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(assetRoot, 'image1.jpg'), '');
  await fs.writeFile(path.join(assetRoot, 'image2.jpg'), '');

  const result = await validateCampaignConfig({
    CAMPAIGN_MODE: 'IMAGE_ONLY',
    ADSET_COUNT: '0',
    AD_CREATIVE_COUNT: '1',
    IMAGE_ONLY_ASSET_ROOT: './images',
  }, { baseDir: root });

  assert.equal(result.plan.adsetCount, 1);
  assert.equal(result.plan.totalAds, 2);
});

test('IMAGE_ONLY PER_AD mode reads images from adset child folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-only-folders-'));
  const assetRoot = path.join(root, 'F_I_O_L_0520');
  const adset2 = path.join(assetRoot, '메타 리타겟 소재-2번 세트-일예산 10만원_익일 05시 세팅');
  const adset1 = path.join(assetRoot, '메타 리타겟 소재-1번 세트-일예산 10만원_익일 05시 세팅');
  await fs.mkdir(adset2, { recursive: true });
  await fs.mkdir(adset1, { recursive: true });
  await fs.writeFile(path.join(adset2, 'image2.jpg'), '');
  await fs.writeFile(path.join(adset2, 'image1.jpg'), '');
  await fs.writeFile(path.join(adset1, 'image2.jpg'), '');
  await fs.writeFile(path.join(adset1, 'image1.jpg'), '');

  const env = {
    CAMPAIGN_MODE: 'IMAGE_ONLY',
    IMAGE_ONLY_UPLOAD_MODE: 'PER_AD',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '1',
    IMAGE_ONLY_ASSET_ROOT: './F_I_O_L_0520',
  };
  const assets = await getImageOnlyAssets(env, { baseDir: root });

  assert.match(assets[0], /1번 세트.*image1\.jpg$/);
  assert.match(assets[1], /1번 세트.*image2\.jpg$/);
  assert.match(assets[2], /2번 세트.*image1\.jpg$/);
  assert.match(assets[3], /2번 세트.*image2\.jpg$/);
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

test('BLOG_MIXED ad names continue across adsets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 2);
  const plan = await buildBlogMixedPlan(blogEnv(root, { ADSET_COUNT: '2' }), { baseDir: root, date: fixedDate });

  assert.equal(plan.adsets[0].name, 'f_i_b_o_l_0520_1');
  assert.deepEqual(plan.adsets[0].ads.map((ad) => ad.name), [
    'f_i_b_o_l_0520_1',
    'f_i_b_o_l_0520_2',
    'f_i_b_o_l_0520_3',
    'f_i_b_o_l_0520_4',
    'f_v_b_o_l_0520_5',
  ]);
  assert.equal(plan.adsets[1].name, 'f_i_b_o_l_0520_2');
  assert.deepEqual(plan.adsets[1].ads.map((ad) => ad.name), [
    'f_i_b_o_l_0520_6',
    'f_i_b_o_l_0520_7',
    'f_i_b_o_l_0520_8',
    'f_i_b_o_l_0520_9',
    'f_v_b_o_l_0520_10',
  ]);
});

test('VIDEO_ONLY naming and landing URL use MMDD ad index', () => {
  const env = {
    CAMPAIGN_MODE: 'VIDEO_ONLY',
    DATE_FORMAT: 'MMDD',
    VIDEO_ONLY_AD_NAME_PREFIX: 'f_v_o_l',
  };

  assert.equal(normalizeCampaignMode('VIDEO_ONLY'), CAMPAIGN_MODES.VIDEO_ONLY);
  assert.equal(buildVideoOnlyAdsetName(1, env, fixedDate), '0520 직접랜딩 광고세트 -1');
  assert.equal(buildVideoOnlyAdName(3, env, fixedDate), 'f_v_o_l_0520_3');
  assert.equal(
    getVideoOnlyLandingUrl('f_v_o_l_0520_3'),
    'https://repurely.com/surl/P/100?utm_source=f&utm_medium=f&utm_campaign=f_v_o_l_0520_3',
  );
});

test('VIDEO_ONLY plan reads videos from YYMMDD TikTok folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-only-plan-'));
  const assetRoot = path.join(root, 'desktop');
  const tiktokDir = path.join(assetRoot, '260520 올레놀샷 틱톡세팅');
  await fs.mkdir(tiktokDir, { recursive: true });
  for (let index = 1; index <= 4; index += 1) {
    await fs.writeFile(path.join(tiktokDir, `F_V_O_L_0520_${index}.mp4`), '');
  }

  const env = {
    CAMPAIGN_MODE: 'VIDEO_ONLY',
    CAMPAIGN_NAME: 'Video campaign',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '1',
    DATE_FORMAT: 'MMDD',
    VIDEO_ONLY_ASSET_ROOT: './desktop',
  };

  const assets = await getVideoOnlyAssets(env, { baseDir: root, date: fixedDate });
  assert.deepEqual(assets.map((asset) => path.basename(asset)), [
    'F_V_O_L_0520_1.mp4',
    'F_V_O_L_0520_2.mp4',
    'F_V_O_L_0520_3.mp4',
    'F_V_O_L_0520_4.mp4',
  ]);

  const plan = await buildVideoOnlyPlan(env, { baseDir: root, date: fixedDate });
  assert.equal(plan.mode, CAMPAIGN_MODES.VIDEO_ONLY);
  assert.equal(plan.adsets.length, 2);
  assert.equal(plan.totalAds, 4);
  assert.equal(plan.adsets[0].name, '0520 직접랜딩 광고세트 -1');
  assert.deepEqual(plan.adsets[0].ads.map((ad) => ad.name), ['f_v_o_l_0520_1', 'f_v_o_l_0520_2']);
  assert.deepEqual(plan.adsets[1].ads.map((ad) => ad.name), ['f_v_o_l_0520_3', 'f_v_o_l_0520_4']);
  assert.equal(plan.adsets[1].ads[1].landingUrl, 'https://repurely.com/surl/P/100?utm_source=f&utm_medium=f&utm_campaign=f_v_o_l_0520_4');
});

test('VIDEO_ONLY plan reads videos from CBO child folder inside TikTok folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-only-nested-'));
  const assetRoot = path.join(root, 'desktop');
  const cboDir = path.join(assetRoot, '260520 올레놀샷 틱톡세팅', '0520 올레놀샷 CBO 캠페인-1');
  await fs.mkdir(cboDir, { recursive: true });
  for (let index = 1; index <= 4; index += 1) {
    await fs.writeFile(path.join(cboDir, `F_V_O_L_0520_${index}.mov`), '');
  }

  const env = {
    CAMPAIGN_MODE: 'VIDEO_ONLY',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '1',
    VIDEO_ONLY_ASSET_ROOT: './desktop',
  };

  const assets = await getVideoOnlyAssets(env, { baseDir: root, date: fixedDate });
  assert.deepEqual(assets.map((asset) => path.basename(asset)), [
    'F_V_O_L_0520_1.mov',
    'F_V_O_L_0520_2.mov',
    'F_V_O_L_0520_3.mov',
    'F_V_O_L_0520_4.mov',
  ]);

  const plan = await buildVideoOnlyPlan(env, { baseDir: root, date: fixedDate });
  assert.match(plan.adsets[0].ads[0].assetPath, /0520 올레놀샷 CBO 캠페인-1/);
});

test('VIDEO_ONLY prefers CBO child folder matching CAMPAIGN_NAME', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-only-campaign-folder-'));
  const assetRoot = path.join(root, 'desktop', '260520 올레놀샷 틱톡세팅');
  const campaign1 = path.join(assetRoot, '0520 올레놀샷 CBO 캠페인-1');
  const campaign2 = path.join(assetRoot, '0520 올레놀샷 CBO 캠페인-2');
  await fs.mkdir(campaign1, { recursive: true });
  await fs.mkdir(campaign2, { recursive: true });
  for (let index = 1; index <= 4; index += 1) {
    await fs.writeFile(path.join(campaign1, `F_V_O_L_0520_campaign1_${index}.mp4`), '');
    await fs.writeFile(path.join(campaign2, `F_V_O_L_0520_${index}.mp4`), '');
  }

  const env = {
    CAMPAIGN_MODE: 'VIDEO_ONLY',
    CAMPAIGN_NAME: '0520 올레놀샷  CBO 캠페인-2',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '1',
    VIDEO_ONLY_ASSET_ROOT: './desktop',
  };

  const assets = await getVideoOnlyAssets(env, { baseDir: root, date: fixedDate });
  assert.deepEqual(assets.map((asset) => path.basename(asset)), [
    'F_V_O_L_0520_1.mp4',
    'F_V_O_L_0520_2.mp4',
    'F_V_O_L_0520_3.mp4',
    'F_V_O_L_0520_4.mp4',
  ]);

  const plan = await buildVideoOnlyPlan(env, { baseDir: root, date: fixedDate });
  assert.match(plan.adsets[0].ads[0].assetPath, /CBO 캠페인-2/);
});

test('VIDEO_ONLY fails when there are not enough video assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-only-plan-'));
  const assetRoot = path.join(root, 'desktop', '260520 올레놀샷 틱톡세팅');
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(assetRoot, 'F_V_O_L_0520_1.mov'), '');

  await assert.rejects(
    () => buildVideoOnlyPlan({
      CAMPAIGN_MODE: 'VIDEO_ONLY',
      ADSET_COUNT: '1',
      AD_CREATIVE_COUNT: '1',
      VIDEO_ONLY_ASSET_ROOT: './desktop',
    }, { baseDir: root, date: fixedDate }),
    /VIDEO_ONLY requires at least 4 video assets. Found 1./,
  );
});

test('VIDEO_ONLY allows ADSET_COUNT=0 as one actual adset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-only-zero-adset-'));
  const assetRoot = path.join(root, 'desktop', '260520 올레놀샷 틱톡세팅');
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(assetRoot, 'F_V_O_L_0520_1.mp4'), '');
  await fs.writeFile(path.join(assetRoot, 'F_V_O_L_0520_2.mp4'), '');

  const plan = await buildVideoOnlyPlan({
    CAMPAIGN_MODE: 'VIDEO_ONLY',
    ADSET_COUNT: '0',
    AD_CREATIVE_COUNT: '1',
    VIDEO_ONLY_ASSET_ROOT: './desktop',
  }, { baseDir: root, date: fixedDate });

  assert.equal(plan.adsetCount, 1);
  assert.equal(plan.totalAds, 2);
  assert.deepEqual(plan.adsets[0].ads.map((ad) => ad.name), ['f_v_o_l_0520_1', 'f_v_o_l_0520_2']);
});
