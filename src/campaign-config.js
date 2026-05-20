import fs from 'node:fs/promises';
import path from 'node:path';

export const CAMPAIGN_MODES = {
  IMAGE_ONLY: 'IMAGE_ONLY',
  BLOG_MIXED: 'BLOG_MIXED',
};

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm)$/i;

export function parseBoolean(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function normalizeCampaignMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['BLOG', 'BLOG_CAMPAIGN', 'BLOG_MIXED', 'BLOG_MIXED_CAMPAIGN'].includes(normalized)) {
    return CAMPAIGN_MODES.BLOG_MIXED;
  }
  return CAMPAIGN_MODES.IMAGE_ONLY;
}

export function isBlogMixedMode(mode) {
  return normalizeCampaignMode(mode) === CAMPAIGN_MODES.BLOG_MIXED;
}

export function readIntegerEnv(env, key, defaultValue) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer. Received: ${raw}`);
  }
  return value;
}

export function getTodayString({
  date = new Date(),
  timezone = 'Asia/Seoul',
  dateFormat = 'YYYYMMDD',
} = {}) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const yyyymmdd = `${values.year}${values.month}${values.day}`;
  if (dateFormat === 'YYYYMMDD') return yyyymmdd;
  if (dateFormat === 'MMDD') return `${values.month}${values.day}`;
  throw new Error(`Unsupported DATE_FORMAT: ${dateFormat}. Use YYYYMMDD.`);
}

export function buildBlogAdsetName(adsetIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_ADSET_NAME_PREFIX || 'f_i_b_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'YYYYMMDD',
  });
  return `${prefix}_${today}_${adsetIndex}`;
}

export function buildBlogImageAdName(adIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_IMAGE_AD_NAME_PREFIX || 'f_i_b_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'YYYYMMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function buildBlogVideoAdName(adIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_VIDEO_AD_NAME_PREFIX || 'f_v_b_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'YYYYMMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function getLandingUrlForAdset(adsetIndex, env = process.env) {
  const key = `BLOG_LANDING_URL_${adsetIndex}`;
  const value = String(env[key] || '').trim();
  if (!value) {
    throw new Error(`Missing ${key}. BLOG_MIXED mode requires one landing URL per adset.`);
  }
  return value;
}

function splitAssetList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAssetPath(assetPath, baseDir = process.cwd()) {
  return path.isAbsolute(assetPath) ? assetPath : path.resolve(baseDir, assetPath);
}

async function listFilesFromDir(dir, extensionPattern) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter((filePath) => extensionPattern.test(filePath))
    .sort((a, b) => a.localeCompare(b));
}

async function pathExists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

export async function getImageAssetsForAdset(adsetIndex, env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const explicitList = splitAssetList(env[`BLOG_ADSET_${adsetIndex}_IMAGE_ASSETS`])
    .map((assetPath) => resolveAssetPath(assetPath, baseDir));
  if (explicitList.length) return explicitList;

  const configuredDir = env[`BLOG_ADSET_${adsetIndex}_IMAGE_DIR`];
  const rootDir = env.BLOG_ASSET_ROOT;
  const imageDir = configuredDir
    ? resolveAssetPath(configuredDir, baseDir)
    : rootDir
      ? path.join(resolveAssetPath(rootDir, baseDir), `adset_${adsetIndex}`, 'images')
      : '';

  if (!imageDir) return [];
  if (!(await pathExists(imageDir))) return [];
  return listFilesFromDir(imageDir, IMAGE_EXTENSIONS);
}

export async function getVideoAssetsForAdset(adsetIndex, env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const explicitAsset = String(env[`BLOG_ADSET_${adsetIndex}_VIDEO_ASSET`] || '').trim();
  if (explicitAsset) return [resolveAssetPath(explicitAsset, baseDir)];

  const configuredDir = env[`BLOG_ADSET_${adsetIndex}_VIDEO_DIR`];
  const rootDir = env.BLOG_ASSET_ROOT;
  const videoDir = configuredDir
    ? resolveAssetPath(configuredDir, baseDir)
    : rootDir
      ? path.join(resolveAssetPath(rootDir, baseDir), `adset_${adsetIndex}`, 'videos')
      : '';

  if (!videoDir) return [];
  if (!(await pathExists(videoDir))) return [];
  return listFilesFromDir(videoDir, VIDEO_EXTENSIONS);
}

export async function getVideoAssetForAdset(adsetIndex, env = process.env, options = {}) {
  const videos = await getVideoAssetsForAdset(adsetIndex, env, options);
  return videos[0] || '';
}

export function buildImageCreativePayload({
  pageId,
  instagramActorId,
  imageAsset,
  landingUrl,
  message,
  headline,
  description,
  callToActionType,
}) {
  return {
    type: 'image',
    pageId,
    instagramActorId,
    imageAsset,
    landingUrl,
    message,
    headline,
    description,
    callToActionType,
  };
}

export function buildVideoCreativePayload({
  pageId,
  instagramActorId,
  videoAsset,
  thumbnailAsset,
  landingUrl,
  message,
  headline,
  description,
  callToActionType,
}) {
  return {
    type: 'video',
    pageId,
    instagramActorId,
    videoAsset,
    thumbnailAsset,
    landingUrl,
    message,
    headline,
    description,
    callToActionType,
  };
}

export async function buildBlogMixedPlan(env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const date = options.date || new Date();
  const adsetCount = readIntegerEnv(env, 'ADSET_COUNT', 1);
  const imageAdsPerAdset = readIntegerEnv(env, 'BLOG_IMAGE_ADS_PER_ADSET', 4);
  const videoAdsPerAdset = readIntegerEnv(env, 'BLOG_VIDEO_ADS_PER_ADSET', 1);
  const totalAdsPerAdset = readIntegerEnv(env, 'BLOG_TOTAL_ADS_PER_ADSET', imageAdsPerAdset + videoAdsPerAdset);

  if (adsetCount < 1) throw new Error('ADSET_COUNT must be >= 1.');
  if (imageAdsPerAdset !== 4) throw new Error('BLOG_MIXED requires BLOG_IMAGE_ADS_PER_ADSET=4.');
  if (videoAdsPerAdset !== 1) throw new Error('BLOG_MIXED requires BLOG_VIDEO_ADS_PER_ADSET=1.');
  if (totalAdsPerAdset !== 5) throw new Error('BLOG_MIXED requires BLOG_TOTAL_ADS_PER_ADSET=5.');

  const adsets = [];
  for (let adsetIndex = 1; adsetIndex <= adsetCount; adsetIndex += 1) {
    const landingUrl = getLandingUrlForAdset(adsetIndex, env);
    const imageAssets = await getImageAssetsForAdset(adsetIndex, env, { baseDir });
    const videoAssets = await getVideoAssetsForAdset(adsetIndex, env, { baseDir });
    const videoAsset = videoAssets[0] || '';

    if (imageAssets.length !== 4) {
      throw new Error(`BLOG_MIXED requires exactly 4 image assets for adset ${adsetIndex}. Found ${imageAssets.length}.`);
    }

    const invalidImage = imageAssets.find((assetPath) => !IMAGE_EXTENSIONS.test(assetPath));
    if (invalidImage) {
      throw new Error(`Invalid image asset for adset ${adsetIndex}: ${invalidImage}. Allowed: png, jpg, jpeg, webp, gif.`);
    }
    for (const imageAsset of imageAssets) {
      if (!(await pathExists(imageAsset))) {
        throw new Error(`Image asset does not exist for adset ${adsetIndex}: ${imageAsset}`);
      }
    }

    if (videoAssets.length !== 1) {
      throw new Error(`BLOG_MIXED requires exactly 1 video asset for adset ${adsetIndex}. Found ${videoAssets.length}.`);
    }
    if (!VIDEO_EXTENSIONS.test(videoAsset)) {
      throw new Error(`Invalid video asset for adset ${adsetIndex}: ${videoAsset}. Allowed: mp4, mov, m4v, webm.`);
    }
    if (!(await pathExists(videoAsset))) {
      throw new Error(`Video asset does not exist for adset ${adsetIndex}: ${videoAsset}`);
    }

    const ads = [];
    for (let imageIndex = 1; imageIndex <= imageAdsPerAdset; imageIndex += 1) {
      ads.push({
        type: 'image',
        index: imageIndex,
        name: buildBlogImageAdName(imageIndex, env, date),
        assetPath: imageAssets[imageIndex - 1],
        landingUrl,
        creativePayload: buildImageCreativePayload({
          imageAsset: imageAssets[imageIndex - 1],
          landingUrl,
        }),
      });
    }

    const videoAdIndex = totalAdsPerAdset;
    ads.push({
      type: 'video',
      index: videoAdIndex,
      name: buildBlogVideoAdName(videoAdIndex, env, date),
      assetPath: videoAsset,
      landingUrl,
      creativePayload: buildVideoCreativePayload({
        videoAsset,
        thumbnailAsset: env[`BLOG_ADSET_${adsetIndex}_VIDEO_THUMBNAIL`] || env.BLOG_VIDEO_THUMBNAIL || '',
        landingUrl,
      }),
    });

    adsets.push({
      index: adsetIndex,
      name: buildBlogAdsetName(adsetIndex, env, date),
      landingUrl,
      imageAssets,
      videoAsset,
      ads,
    });
  }

  return {
    mode: CAMPAIGN_MODES.BLOG_MIXED,
    campaignName: env.CAMPAIGN_NAME || '',
    adsetCount,
    imageAdsPerAdset,
    videoAdsPerAdset,
    totalAdsPerAdset,
    adsets,
  };
}

export function getBlogAdPlanBySequence(plan, sequence) {
  const zeroBased = sequence - 1;
  const adsetOffset = Math.floor(zeroBased / plan.totalAdsPerAdset);
  const adOffset = zeroBased % plan.totalAdsPerAdset;
  const adset = plan.adsets[adsetOffset];
  if (!adset) return null;
  const ad = adset.ads[adOffset];
  if (!ad) return null;
  return {
    adsetIndex: adset.index,
    adsetName: adset.name,
    landingUrl: adset.landingUrl,
    ...ad,
  };
}

export function formatDryRunPlan(plan) {
  const lines = [
    '[DRY RUN] Meta Ads Automation plan',
    `campaign mode: ${plan.mode}`,
    `campaign name: ${plan.campaignName}`,
    `adset count: ${plan.adsetCount}`,
  ];

  for (const adset of plan.adsets) {
    lines.push('');
    lines.push(`adset ${adset.index}: ${adset.name}`);
    lines.push(`landing URL: ${adset.landingUrl}`);
    for (const ad of adset.ads) {
      lines.push(`- ${ad.type} creative | ad name: ${ad.name} | asset: ${ad.assetPath}`);
    }
  }

  return lines.join('\n');
}

export async function validateCampaignConfig(env = process.env, options = {}) {
  const mode = normalizeCampaignMode(env.CAMPAIGN_MODE);
  if (mode === CAMPAIGN_MODES.IMAGE_ONLY) {
    readIntegerEnv(env, 'ADSET_COUNT', 1);
    return { mode, plan: null };
  }

  const plan = await buildBlogMixedPlan(env, options);
  return { mode, plan };
}
