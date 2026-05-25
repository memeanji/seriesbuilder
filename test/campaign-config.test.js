import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAdsetPreview,
  getAdMediaType,
  renderTemplate,
  validateCampaignModel,
} from '../src/campaign-model.js';
import {
  CAMPAIGN_MODES,
  buildBlogAdsetName,
  buildBlogImageAdName,
  buildBlogMixedPlan,
  buildBlogVideoAdName,
  buildImageOnlyCboPlan,
  buildVideoOnlyAdName,
  buildVideoOnlyAdsetName,
  buildVideoOnlyCboPlan,
  buildVideoOnlyPlan,
  findImageFileByAdName,
  findVideoFileByAdName,
  formatBudgetForMetaInput,
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

test('renderTemplate replaces naming tokens and rejects unknown tokens', () => {
  assert.equal(renderTemplate('f_i_o_l_{MMDD}_{idx}', { MMDD: '0520', idx: 1 }), 'f_i_o_l_0520_1');
  assert.throws(() => renderTemplate('x_{missing}', {}), /Unknown template variable/);
});

test('campaign model mixed media puts only the final ad as video', () => {
  const adset = { mediaType: 'mixed', adCount: 5 };
  assert.equal(getAdMediaType(adset, 1), 'image');
  assert.equal(getAdMediaType(adset, 4), 'image');
  assert.equal(getAdMediaType(adset, 5), 'video');
});

test('campaign model validates mixed and URL modes', () => {
  const base = {
    adAccountId: '123',
    dailyBudget: 100000,
    scheduleTime: '05:00',
    dryRun: true,
    createNewCampaign: false,
    namingTemplate: { adset: 'f_i_o_l_{MMDD}_{idx}', ad: '{adset_name}_{ad_idx}' },
    repurelyBaseUrl: 'https://repurely.com/surl/P',
    adsets: [{
      index: 1,
      mediaType: 'mixed',
      adCount: 1,
      imageFolder: './images',
      videoFolder: './videos',
      urlMode: 'per_ad_auto',
      pathNumbers: [100],
    }],
  };
  assert.match(validateCampaignModel(base).join('\n'), /mixed adCount must be >= 2/);
  assert.match(validateCampaignModel({
    ...base,
    adsets: [{ ...base.adsets[0], adCount: 3, pathNumbers: [100] }],
  }).join('\n'), /pathNumbers length must match adCount/);
  assert.match(validateCampaignModel({
    ...base,
    adsets: [{ ...base.adsets[0], adCount: 3, urlMode: 'shared_manual', sharedLandingUrl: '' }],
  }).join('\n'), /sharedLandingUrl is required/);
});

test('campaign model preview builds shared manual URLs without UTM', () => {
  const config = {
    namingTemplate: { adset: 'f_i_o_l_{MMDD}_{idx}', ad: '{adset_name}_{ad_idx}' },
    repurelyBaseUrl: 'https://repurely.com/surl/P',
  };
  const preview = buildAdsetPreview(config, {
    index: 1,
    mediaType: 'mixed',
    adCount: 3,
    urlMode: 'shared_manual',
    sharedLandingUrl: 'https://blog.naver.com/seriesbuilder/123',
  }, fixedDate);
  assert.equal(preview.adsetName, 'f_i_o_l_0520_1');
  assert.equal(preview.ads[0].mediaType, 'image');
  assert.equal(preview.ads[2].mediaType, 'video');
  assert.equal(preview.ads[2].url, 'https://blog.naver.com/seriesbuilder/123');
});

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

async function createBlogVideoAssets(root, adsetCount = 2, videoCount = 3) {
  for (let adsetIndex = 1; adsetIndex <= adsetCount; adsetIndex += 1) {
    const videoDir = path.join(root, 'assets', 'blog', `adset_${adsetIndex}`, 'videos');
    await fs.mkdir(videoDir, { recursive: true });
    for (let videoIndex = 1; videoIndex <= videoCount; videoIndex += 1) {
      await fs.writeFile(path.join(videoDir, `video${videoIndex}.mp4`), '');
    }
  }
}

async function createFlatBlogVideoAssets(root, videoCount = 6) {
  const blogRoot = path.join(root, 'assets', 'blog');
  await fs.mkdir(blogRoot, { recursive: true });
  for (let videoIndex = 1; videoIndex <= videoCount; videoIndex += 1) {
    await fs.writeFile(path.join(blogRoot, `f_v_b_o_l_0520_${videoIndex}.mp4`), '');
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
    AD_CREATIVE_COUNT: '4',
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

test('BLOG_VIDEO normalizes and defaults adset names to video prefix', () => {
  const env = blogEnv(process.cwd(), {
    CAMPAIGN_MODE: 'BLOG_VIDEO',
    BLOG_ADSET_NAME_PREFIX: '',
  });
  assert.equal(normalizeCampaignMode('BLOG_VIDEO'), CAMPAIGN_MODES.BLOG_VIDEO);
  assert.equal(buildBlogAdsetName(1, env, fixedDate), 'f_v_b_o_l_0520_1');
});

test('BLOG adset name template changes only index/date tokens', () => {
  const env = blogEnv(process.cwd(), {
    CAMPAIGN_MODE: 'BLOG_VIDEO',
    BLOG_ADSET_NAME_TEMPLATE: '블로그 영상 {mmdd} 세트 {index}',
  });
  assert.equal(buildBlogAdsetName(3, env, fixedDate), '블로그 영상 0520 세트 3');
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

test('BLOG_MIXED uses AD_CREATIVE_COUNT plus one and puts video last', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-plan-'));
  await createBlogAssets(root, 2, 3);
  const plan = await buildBlogMixedPlan(blogEnv(root, { ADSET_COUNT: '2', AD_CREATIVE_COUNT: '3' }), { baseDir: root, date: fixedDate });

  assert.equal(plan.totalAdsPerAdset, 4);
  assert.equal(plan.imageAdsPerAdset, 3);
  assert.equal(plan.videoAdsPerAdset, 1);
  assert.deepEqual(plan.adsets[0].ads.map((ad) => `${ad.type}:${ad.name}`), [
    'image:f_i_b_o_l_0520_1',
    'image:f_i_b_o_l_0520_2',
    'image:f_i_b_o_l_0520_3',
    'video:f_v_b_o_l_0520_4',
  ]);
  assert.deepEqual(plan.adsets[1].ads.map((ad) => `${ad.type}:${ad.name}`), [
    'image:f_i_b_o_l_0520_5',
    'image:f_i_b_o_l_0520_6',
    'image:f_i_b_o_l_0520_7',
    'video:f_v_b_o_l_0520_8',
  ]);
});

test('BLOG_MIXED keeps image/video prefix names instead of adset_name suffix template', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-mixed-name-rule-'));
  await createBlogAssets(root, 1, 2);
  const plan = await buildBlogMixedPlan(blogEnv(root, {
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '2',
    BLOG_IMAGE_ADS_PER_ADSET: '2',
    BLOG_TOTAL_ADS_PER_ADSET: '3',
    NAMING_AD_TEMPLATE: '{adset_name}_{ad_idx}',
  }), { baseDir: root, date: fixedDate });
  assert.equal(plan.adsets[0].name, 'f_i_b_o_l_0520_1');
  assert.deepEqual(plan.adsets[0].ads.map((ad) => ad.name), [
    'f_i_b_o_l_0520_1',
    'f_i_b_o_l_0520_2',
    'f_v_b_o_l_0520_3',
  ]);
});

test('BLOG_VIDEO uses AD_CREATIVE_COUNT plus one and makes every creative video', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-video-plan-'));
  await createBlogVideoAssets(root, 2, 3);
  const plan = await buildBlogMixedPlan(blogEnv(root, {
    CAMPAIGN_MODE: 'BLOG_VIDEO',
    ADSET_COUNT: '2',
    AD_CREATIVE_COUNT: '2',
    BLOG_IMAGE_ADS_PER_ADSET: '0',
    BLOG_VIDEO_ADS_PER_ADSET: '3',
    BLOG_TOTAL_ADS_PER_ADSET: '3',
    BLOG_ADSET_NAME_PREFIX: '',
  }), { baseDir: root, date: fixedDate });

  assert.equal(plan.mode, CAMPAIGN_MODES.BLOG_VIDEO);
  assert.equal(plan.totalAdsPerAdset, 3);
  assert.equal(plan.imageAdsPerAdset, 0);
  assert.equal(plan.videoAdsPerAdset, 3);
  assert.equal(plan.adsets[0].name, 'f_v_b_o_l_0520_1');
  assert.deepEqual(plan.adsets[0].ads.map((ad) => `${ad.type}:${ad.name}`), [
    'video:f_v_b_o_l_0520_1',
    'video:f_v_b_o_l_0520_2',
    'video:f_v_b_o_l_0520_3',
  ]);
  assert.deepEqual(plan.adsets[1].ads.map((ad) => `${ad.type}:${ad.name}`), [
    'video:f_v_b_o_l_0520_4',
    'video:f_v_b_o_l_0520_5',
    'video:f_v_b_o_l_0520_6',
  ]);
});

test('BLOG_VIDEO can split flat root videos sequentially by adset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-video-flat-plan-'));
  await createFlatBlogVideoAssets(root, 6);
  const plan = await buildBlogMixedPlan(blogEnv(root, {
    CAMPAIGN_MODE: 'BLOG_VIDEO',
    ADSET_COUNT: '2',
    AD_CREATIVE_COUNT: '2',
    BLOG_IMAGE_ADS_PER_ADSET: '0',
    BLOG_VIDEO_ADS_PER_ADSET: '3',
    BLOG_TOTAL_ADS_PER_ADSET: '3',
    BLOG_ADSET_NAME_PREFIX: '',
  }), { baseDir: root, date: fixedDate });

  assert.deepEqual(plan.adsets[0].ads.map((ad) => path.basename(ad.assetPath)), [
    'f_v_b_o_l_0520_1.mp4',
    'f_v_b_o_l_0520_2.mp4',
    'f_v_b_o_l_0520_3.mp4',
  ]);
  assert.deepEqual(plan.adsets[1].ads.map((ad) => path.basename(ad.assetPath)), [
    'f_v_b_o_l_0520_4.mp4',
    'f_v_b_o_l_0520_5.mp4',
    'f_v_b_o_l_0520_6.mp4',
  ]);
});

test('BLOG_VIDEO allows AD_CREATIVE_COUNT zero for one video creative per adset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-video-one-plan-'));
  await createFlatBlogVideoAssets(root, 2);
  const plan = await buildBlogMixedPlan(blogEnv(root, {
    CAMPAIGN_MODE: 'BLOG_VIDEO',
    ADSET_COUNT: '2',
    AD_CREATIVE_COUNT: '0',
    BLOG_IMAGE_ADS_PER_ADSET: '0',
    BLOG_VIDEO_ADS_PER_ADSET: '1',
    BLOG_TOTAL_ADS_PER_ADSET: '1',
    BLOG_ADSET_NAME_TEMPLATE: '블로그 영상 {index}번',
  }), { baseDir: root, date: fixedDate });

  assert.equal(plan.totalAdsPerAdset, 1);
  assert.equal(plan.videoAdsPerAdset, 1);
  assert.equal(plan.adsets[0].name, '블로그 영상 1번');
  assert.deepEqual(plan.adsets[0].ads.map((ad) => `${ad.type}:${ad.name}`), [
    'video:f_v_b_o_l_0520_1',
  ]);
  assert.deepEqual(plan.adsets[1].ads.map((ad) => `${ad.type}:${ad.name}`), [
    'video:f_v_b_o_l_0520_2',
  ]);
});

test('BLOG_VIDEO_DIRECT generates landing URLs from f_v_o_l ad names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-video-direct-plan-'));
  await createFlatBlogVideoAssets(root, 2);
  const plan = await buildBlogMixedPlan(blogEnv(root, {
    CAMPAIGN_MODE: 'BLOG_VIDEO_DIRECT',
    ADSET_COUNT: '2',
    AD_CREATIVE_COUNT: '0',
    BLOG_IMAGE_ADS_PER_ADSET: '0',
    BLOG_VIDEO_ADS_PER_ADSET: '1',
    BLOG_TOTAL_ADS_PER_ADSET: '1',
    BLOG_ADSET_NAME_TEMPLATE: '직접 영상 {index}번',
    LANDING_PATH_NUMBER: '99',
    BLOG_LANDING_URL_1: '',
    BLOG_LANDING_URL_2: '',
  }), { baseDir: root, date: fixedDate });

  assert.equal(normalizeCampaignMode('BLOG_VIDEO_DIRECT'), CAMPAIGN_MODES.BLOG_VIDEO_DIRECT);
  assert.equal(plan.mode, CAMPAIGN_MODES.BLOG_VIDEO_DIRECT);
  assert.equal(plan.adsets[0].landingUrl, '(auto per ad)');
  assert.equal(plan.adsets[0].ads[0].name, 'f_v_o_l_0520_1');
  assert.equal(
    plan.adsets[0].ads[0].landingUrl,
    'https://repurely.com/surl/P/99?utm_source=f&utm_medium=f&utm_campaign=f_v_o_l_0520_1',
  );
  assert.equal(
    plan.adsets[1].ads[0].landingUrl,
    'https://repurely.com/surl/P/99?utm_source=f&utm_medium=f&utm_campaign=f_v_o_l_0520_2',
  );
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
  assert.equal(
    getVideoOnlyLandingUrl('f_v_o_l_0520_3', { LANDING_PATH_NUMBER: '99' }),
    'https://repurely.com/surl/P/99?utm_source=f&utm_medium=f&utm_campaign=f_v_o_l_0520_3',
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
    LANDING_PATH_NUMBER: '67',
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
  assert.equal(plan.adsets[1].ads[1].landingUrl, 'https://repurely.com/surl/P/67?utm_source=f&utm_medium=f&utm_campaign=f_v_o_l_0520_4');
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

test('VIDEO_ONLY prefers adset folder and matches video file by ad name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-only-adset-folder-'));
  const assetRoot = path.join(root, 'desktop', '260520 올레놀샷 틱톡세팅');
  const adset1 = path.join(assetRoot, '0520 직접랜딩 광고세트 -1');
  const adset2 = path.join(assetRoot, '0520 직접랜딩 광고세트 -2');
  await fs.mkdir(adset1, { recursive: true });
  await fs.mkdir(adset2, { recursive: true });
  for (let index = 1; index <= 6; index += 1) {
    await fs.writeFile(path.join(adset1, `F_V_O_L_0520_${index}.mp4`), '');
  }
  for (let index = 7; index <= 12; index += 1) {
    await fs.writeFile(path.join(adset2, `F_V_O_L_0520_${index}.mov`), '');
  }

  const env = {
    CAMPAIGN_MODE: 'VIDEO_ONLY',
    ADSET_COUNT: '1',
    AD_CREATIVE_COUNT: '5',
    VIDEO_ONLY_ASSET_ROOT: './desktop',
  };

  const plan = await buildVideoOnlyPlan(env, { baseDir: root, date: fixedDate });
  assert.equal(plan.adsets.length, 2);
  assert.deepEqual(plan.adsets[0].ads.map((ad) => path.basename(ad.assetPath)), [
    'F_V_O_L_0520_1.mp4',
    'F_V_O_L_0520_2.mp4',
    'F_V_O_L_0520_3.mp4',
    'F_V_O_L_0520_4.mp4',
    'F_V_O_L_0520_5.mp4',
    'F_V_O_L_0520_6.mp4',
  ]);
  assert.deepEqual(plan.adsets[1].ads.map((ad) => path.basename(ad.assetPath)), [
    'F_V_O_L_0520_7.mov',
    'F_V_O_L_0520_8.mov',
    'F_V_O_L_0520_9.mov',
    'F_V_O_L_0520_10.mov',
    'F_V_O_L_0520_11.mov',
    'F_V_O_L_0520_12.mov',
  ]);
  assert.match(plan.adsets[1].ads[0].assetPath, /직접랜딩 광고세트 -2/);
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

test('VIDEO_ONLY_CBO validates campaign name and formats campaign budget', async () => {
  assert.equal(normalizeCampaignMode('VIDEO_ONLY_CBO_CAMPAIGN'), CAMPAIGN_MODES.VIDEO_ONLY_CBO);
  assert.equal(formatBudgetForMetaInput('25000'), '25,000');
  assert.equal(formatBudgetForMetaInput('25,000'), '25,000');
  await assert.rejects(
    () => buildVideoOnlyCboPlan({
      CAMPAIGN_MODE: 'VIDEO_ONLY_CBO',
      CAMPAIGN_BUDGET: '25000',
      VIDEO_ONLY_CBO_VIDEO_FOLDER: './videos',
    }),
    /CAMPAIGN_NAME is required/,
  );
  assert.throws(() => formatBudgetForMetaInput('0'), /greater than 0/);
});

test('VIDEO_ONLY_CBO matches exact video filename by ad name and supported extension order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cbo-match-'));
  const folder = path.join(root, 'videos');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'f_v_b_o_l_0520_1.mov'), '');
  await fs.writeFile(path.join(folder, 'f_v_b_o_l_0520_2.m4v'), '');

  assert.equal(path.basename(await findVideoFileByAdName('f_v_b_o_l_0520_1', './videos', { baseDir: root })), 'f_v_b_o_l_0520_1.mov');
  assert.equal(path.basename(await findVideoFileByAdName('f_v_b_o_l_0520_2', './videos', { baseDir: root })), 'f_v_b_o_l_0520_2.m4v');
  await assert.rejects(
    () => findVideoFileByAdName('f_v_b_o_l_0520_3', './videos', { baseDir: root }),
    /Video file not found for ad name: f_v_b_o_l_0520_3.*f_v_b_o_l_0520_3\.mp4.*f_v_b_o_l_0520_3\.mov.*f_v_b_o_l_0520_3\.m4v/,
  );
});

test('VIDEO_ONLY_CBO plan requires exact video files and landing URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cbo-plan-'));
  const folder = path.join(root, 'videos');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'f_v_b_o_l_0520_1.mp4'), '');
  await fs.writeFile(path.join(folder, 'f_v_b_o_l_0520_2.mov'), '');

  await assert.rejects(
    () => buildVideoOnlyCboPlan({
      CAMPAIGN_MODE: 'VIDEO_ONLY_CBO',
      CAMPAIGN_NAME: '0520 CBO campaign',
      CAMPAIGN_BUDGET: '25000',
      ADSET_COUNT: '0',
      AD_CREATIVE_COUNT: '1',
      VIDEO_ONLY_CBO_VIDEO_FOLDER: './videos',
      VIDEO_ONLY_CBO_LANDING_URL_1: 'https://example.com/1',
    }, { baseDir: root, date: fixedDate }),
    /Missing VIDEO_ONLY_CBO_LANDING_URL_2/,
  );

  const plan = await buildVideoOnlyCboPlan({
    CAMPAIGN_MODE: 'VIDEO_ONLY_CBO',
    CAMPAIGN_NAME: '0520 CBO campaign',
    CAMPAIGN_BUDGET: '25000',
    ADSET_COUNT: '9',
    AD_CREATIVE_COUNT: '1',
    VIDEO_ONLY_CBO_VIDEO_FOLDER: './videos',
    VIDEO_ONLY_CBO_LANDING_URL_1: 'https://example.com/1',
    VIDEO_ONLY_CBO_LANDING_URL_2: 'https://example.com/2',
  }, { baseDir: root, date: fixedDate });

  assert.equal(plan.mode, CAMPAIGN_MODES.VIDEO_ONLY_CBO);
  assert.equal(plan.campaignBudget, '25,000');
  assert.equal(plan.adsetCount, 1);
  assert.equal(plan.totalAds, 2);
  assert.equal(plan.adsets[0].ads[0].name, 'f_v_b_o_l_0520_1');
  assert.equal(path.basename(plan.adsets[0].ads[1].assetPath), 'f_v_b_o_l_0520_2.mov');
  assert.equal(plan.adsets[0].ads[1].landingUrl, 'https://example.com/2');
});

test('VIDEO_ONLY_CBO uses explicit campaign, adset, and ad names from env', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cbo-explicit-'));
  const folder = path.join(root, 'videos');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'custom_ad_1.mp4'), '');

  const plan = await buildVideoOnlyCboPlan({
    CAMPAIGN_MODE: 'VIDEO_ONLY_CBO',
    CAMPAIGN_NAME: 'My exact campaign name',
    CAMPAIGN_BUDGET: '25000',
    ADSET_COUNT: '0',
    AD_CREATIVE_COUNT: '0',
    VIDEO_ONLY_CBO_VIDEO_FOLDER: './videos',
    VIDEO_ONLY_CBO_ADSET_NAME_1: 'My exact adset name',
    VIDEO_ONLY_CBO_AD_NAME_1: 'custom_ad_1',
    VIDEO_ONLY_CBO_LANDING_URL_1: 'https://example.com/custom',
  }, { baseDir: root, date: fixedDate });

  assert.equal(plan.campaignName, 'My exact campaign name');
  assert.equal(plan.adsets[0].name, 'My exact adset name');
  assert.equal(plan.adsets[0].ads[0].name, 'custom_ad_1');
  assert.equal(path.basename(plan.adsets[0].ads[0].assetPath), 'custom_ad_1.mp4');
});

test('IMAGE_ONLY_CBO matches exact image filename and builds image CBO plan', async () => {
  assert.equal(normalizeCampaignMode('IMAGE_ONLY_CBO_CAMPAIGN'), CAMPAIGN_MODES.IMAGE_ONLY_CBO);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-cbo-plan-'));
  const folder = path.join(root, 'images');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'f_i_b_o_l_0520_1.webp'), '');
  await fs.writeFile(path.join(folder, 'f_i_b_o_l_0520_2.jpg'), '');

  assert.equal(path.basename(await findImageFileByAdName('f_i_b_o_l_0520_1', './images', { baseDir: root })), 'f_i_b_o_l_0520_1.webp');

  const plan = await buildImageOnlyCboPlan({
    CAMPAIGN_MODE: 'IMAGE_ONLY_CBO',
    CAMPAIGN_NAME: '0520 image CBO campaign',
    CAMPAIGN_BUDGET: '25000',
    ADSET_COUNT: '9',
    AD_CREATIVE_COUNT: '1',
    IMAGE_ONLY_CBO_IMAGE_FOLDER: './images',
    IMAGE_ONLY_CBO_LANDING_URL_1: 'https://example.com/1',
    IMAGE_ONLY_CBO_LANDING_URL_2: 'https://example.com/2',
  }, { baseDir: root, date: fixedDate });

  assert.equal(plan.mode, CAMPAIGN_MODES.IMAGE_ONLY_CBO);
  assert.equal(plan.campaignBudget, '25,000');
  assert.equal(plan.adsetCount, 1);
  assert.equal(plan.totalAds, 2);
  assert.equal(plan.adsets[0].ads[0].type, 'image');
  assert.equal(plan.adsets[0].ads[0].name, 'f_i_b_o_l_0520_1');
  assert.equal(path.basename(plan.adsets[0].ads[1].assetPath), 'f_i_b_o_l_0520_2.jpg');
  assert.equal(plan.adsets[0].ads[1].landingUrl, 'https://example.com/2');
});

test('IMAGE_ONLY validation is not blocked by VIDEO_ONLY_CBO requirements', async () => {
  const result = await validateCampaignConfig({
    CAMPAIGN_MODE: 'IMAGE_ONLY',
    IMAGE_ONLY_UPLOAD_MODE: 'LEGACY',
    CAMPAIGN_BUDGET: '',
    VIDEO_ONLY_CBO_VIDEO_FOLDER: '',
  });
  assert.equal(result.mode, CAMPAIGN_MODES.IMAGE_ONLY);
  assert.equal(result.plan, null);
});
