import fs from 'node:fs/promises';
import path from 'node:path';

export const CAMPAIGN_MODES = {
  IMAGE_ONLY: 'IMAGE_ONLY',
  BLOG_MIXED: 'BLOG_MIXED',
  VIDEO_ONLY: 'VIDEO_ONLY',
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
  if (['VIDEO', 'VIDEO_ONLY', 'VIDEO_CAMPAIGN', 'VIDEO_ONLY_CAMPAIGN'].includes(normalized)) {
    return CAMPAIGN_MODES.VIDEO_ONLY;
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
  dateFormat = 'MMDD',
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
  throw new Error(`Unsupported DATE_FORMAT: ${dateFormat}. Use MMDD or YYYYMMDD.`);
}

export function buildBlogAdsetName(adsetIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_ADSET_NAME_PREFIX || 'f_i_b_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  return `${prefix}_${today}_${adsetIndex}`;
}

export function buildBlogImageAdName(adIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_IMAGE_AD_NAME_PREFIX || 'f_i_b_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function buildBlogVideoAdName(adIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_VIDEO_AD_NAME_PREFIX || 'f_v_b_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function buildVideoOnlyAdName(adIndex, env = process.env, date = new Date()) {
  const prefix = env.VIDEO_ONLY_AD_NAME_PREFIX || 'f_v_o_l';
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function buildVideoOnlyAdsetName(adsetIndex, env = process.env, date = new Date()) {
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  const includeIndex = String(env.VIDEO_ONLY_ADSET_NAME_INCLUDE_INDEX || 'true').trim().toLowerCase() !== 'false';
  return includeIndex ? `${today} 직접랜딩 광고세트 -${adsetIndex}` : `${today} 직접랜딩 광고세트`;
}

export function getVideoOnlyLandingUrl(adName) {
  return `https://repurely.com/surl/P/100?utm_source=f&utm_medium=f&utm_campaign=${adName}`;
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

export function isPerAdImageOnlyUploadMode(env = process.env) {
  return String(env.IMAGE_ONLY_UPLOAD_MODE || 'PER_AD').trim().toUpperCase() !== 'LEGACY';
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
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
    .sort(naturalCompare);
}

async function listFilesFromDirTree(dir, extensionPattern, maxDepth = 1) {
  const files = await listFilesFromDir(dir, extensionPattern).catch(() => []);
  if (maxDepth <= 0) return files;

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort(naturalCompare);

  for (const directory of directories) {
    files.push(...await listFilesFromDirTree(directory, extensionPattern, maxDepth - 1));
  }

  return files.sort(naturalCompare);
}

function extractImageOnlyAdsetFolderIndex(folderName) {
  const normalized = String(folderName || '').trim();
  const patterns = [
    /메타\s*리타겟\s*소재\s*-\s*(\d+)\s*번\s*세트/i,
    /(\d+)\s*번\s*세트/i,
    /(\d+)\s*번\s*광고세트/i,
    /adset[_\-\s]*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return Number(match[1]);
  }

  return Number.POSITIVE_INFINITY;
}

async function listImageOnlyAdsetFolders(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(rootPath, entry.name),
      index: extractImageOnlyAdsetFolderIndex(entry.name),
    }))
    .sort((a, b) => (a.index - b.index) || naturalCompare(a.name, b.name));
}

async function pathExists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

function getTodayMMDD(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

function getTodayYYMMDD(date = new Date()) {
  const year = String(date.getFullYear()).slice(-2);
  return `${year}${getTodayMMDD(date)}`;
}

async function findBlogAdsetFolderFromRoot(rootPath, adsetIndex, options = {}) {
  if (!rootPath || !(await pathExists(rootPath))) return '';

  const mmdd = options.mmdd || getTodayMMDD(options.date || new Date());
  const preferredPrefix = `${mmdd} ${adsetIndex}번 광고세트`;
  const fallbackToken = `${adsetIndex}번 광고세트`;
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(rootPath, entry.name),
    }));

  const preferred = directories.find((entry) => entry.name.startsWith(preferredPrefix));
  if (preferred) return preferred.fullPath;

  const fallback = directories.find((entry) => entry.name.includes(fallbackToken));
  return fallback?.fullPath || '';
}

async function findVideoOnlyAssetRoot(rootPath, options = {}) {
  if (!rootPath || !(await pathExists(rootPath))) return '';

  const yymmdd = options.yymmdd || getTodayYYMMDD(options.date || new Date());
  const preferredPrefix = `${yymmdd} 올레놀샷 틱톡세팅`;
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(rootPath, entry.name),
    }))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const preferred = directories.find((entry) => entry.name.startsWith(preferredPrefix));
  if (preferred) return preferred.fullPath;

  const fallback = directories.find((entry) => entry.name.includes('올레놀샷') && entry.name.includes('틱톡세팅'));
  return fallback?.fullPath || '';
}

async function resolveBlogAssetDir(adsetIndex, env, options, kind) {
  const baseDir = options.baseDir || process.cwd();
  const rootDir = env.BLOG_ASSET_ROOT ? resolveAssetPath(env.BLOG_ASSET_ROOT, baseDir) : '';
  const configuredDir = env[`BLOG_ADSET_${adsetIndex}_${kind}_DIR`];
  if (configuredDir) return resolveAssetPath(configuredDir, baseDir);
  if (!rootDir) return '';

  const conventionalDir = path.join(rootDir, `adset_${adsetIndex}`, kind.toLowerCase() === 'image' ? 'images' : 'videos');
  if (await pathExists(conventionalDir)) return conventionalDir;

  return findBlogAdsetFolderFromRoot(rootDir, adsetIndex, options);
}

export async function getImageAssetsForAdset(adsetIndex, env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const explicitList = splitAssetList(env[`BLOG_ADSET_${adsetIndex}_IMAGE_ASSETS`])
    .map((assetPath) => resolveAssetPath(assetPath, baseDir));
  if (explicitList.length) return explicitList;

  const imageDir = await resolveBlogAssetDir(adsetIndex, env, options, 'IMAGE');
  if (!imageDir) return [];
  if (!(await pathExists(imageDir))) return [];
  return listFilesFromDir(imageDir, IMAGE_EXTENSIONS);
}

export async function getVideoAssetsForAdset(adsetIndex, env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const explicitAsset = String(env[`BLOG_ADSET_${adsetIndex}_VIDEO_ASSET`] || '').trim();
  if (explicitAsset) return [resolveAssetPath(explicitAsset, baseDir)];

  const videoDir = await resolveBlogAssetDir(adsetIndex, env, options, 'VIDEO');
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
    const adIndexBase = (adsetIndex - 1) * totalAdsPerAdset;
    for (let imageIndex = 1; imageIndex <= imageAdsPerAdset; imageIndex += 1) {
      const globalAdIndex = adIndexBase + imageIndex;
      ads.push({
        type: 'image',
        index: globalAdIndex,
        adsetLocalIndex: imageIndex,
        name: buildBlogImageAdName(globalAdIndex, env, date),
        assetPath: imageAssets[imageIndex - 1],
        landingUrl,
        creativePayload: buildImageCreativePayload({
          imageAsset: imageAssets[imageIndex - 1],
          landingUrl,
        }),
      });
    }

    const videoAdIndex = adIndexBase + totalAdsPerAdset;
    ads.push({
      type: 'video',
      index: videoAdIndex,
      adsetLocalIndex: totalAdsPerAdset,
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

export async function getImageOnlyAssets(env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const assetRoot = String(env.IMAGE_ONLY_ASSET_ROOT || env.MEDIA_FOLDER_PATH || '').trim();
  const resolvedRoot = assetRoot ? resolveAssetPath(assetRoot, baseDir) : '';
  const explicitAssets = splitAssetList(env.IMAGE_ONLY_ASSETS)
    .map((assetPath) => {
      if (path.isAbsolute(assetPath)) return assetPath;
      return resolveAssetPath(assetPath, resolvedRoot || baseDir);
    });
  if (explicitAssets.length) return explicitAssets;

  if (!assetRoot) return [];
  if (!(await pathExists(resolvedRoot))) {
    throw new Error(`IMAGE_ONLY asset root does not exist: ${resolvedRoot}`);
  }

  const directImages = await listFilesFromDir(resolvedRoot, IMAGE_EXTENSIONS);
  if (directImages.length) return directImages;

  const adsetFolders = await listImageOnlyAdsetFolders(resolvedRoot);
  const nestedImages = [];
  for (const folder of adsetFolders) {
    const images = await listFilesFromDir(folder.fullPath, IMAGE_EXTENSIONS);
    nestedImages.push(...images);
  }

  return nestedImages;
}

export function getImageOnlyAssetBySequence(assets, sequence) {
  return assets[sequence - 1] || '';
}

export async function getVideoOnlyAssets(env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const assetRoot = String(env.VIDEO_ONLY_ASSET_ROOT || env.MEDIA_FOLDER_PATH || '').trim();
  const resolvedRoot = assetRoot ? resolveAssetPath(assetRoot, baseDir) : '';
  const explicitAssets = splitAssetList(env.VIDEO_ONLY_ASSETS)
    .map((assetPath) => {
      if (path.isAbsolute(assetPath)) return assetPath;
      return resolveAssetPath(assetPath, resolvedRoot || baseDir);
    });
  if (explicitAssets.length) return explicitAssets;

  if (!assetRoot) return [];
  if (!(await pathExists(resolvedRoot))) {
    throw new Error(`VIDEO_ONLY asset root does not exist: ${resolvedRoot}`);
  }

  const directVideos = await listFilesFromDir(resolvedRoot, VIDEO_EXTENSIONS);
  if (directVideos.length) return directVideos;

  const detectedRoot = await findVideoOnlyAssetRoot(resolvedRoot, options);
  if (detectedRoot) {
    const detectedVideos = await listFilesFromDirTree(detectedRoot, VIDEO_EXTENSIONS, 2);
    if (detectedVideos.length) return detectedVideos;
  }

  return listFilesFromDirTree(resolvedRoot, VIDEO_EXTENSIONS, 2);
}

export function getVideoOnlyAssetBySequence(assets, sequence) {
  return assets[sequence - 1] || '';
}

export async function buildVideoOnlyPlan(env = process.env, options = {}) {
  const date = options.date || new Date();
  const adsetDuplicateCount = readIntegerEnv(env, 'ADSET_COUNT', 1);
  const adCreativeDuplicateCount = readIntegerEnv(env, 'AD_CREATIVE_COUNT', readIntegerEnv(env, 'VIDEO_AD_COUNT', readIntegerEnv(env, 'ADSET_CREATIVE_COUNT', 1)));
  const effectiveAdsetCount = adsetDuplicateCount + 1;
  const effectiveCreativeCount = adCreativeDuplicateCount + 1;
  const requiredAssetCount = effectiveAdsetCount * effectiveCreativeCount;
  const videoAssets = await getVideoOnlyAssets(env, options);

  if (videoAssets.length < requiredAssetCount) {
    throw new Error(`VIDEO_ONLY requires at least ${requiredAssetCount} video assets. Found ${videoAssets.length}.`);
  }

  for (const asset of videoAssets.slice(0, requiredAssetCount)) {
    if (!VIDEO_EXTENSIONS.test(asset)) {
      throw new Error(`Invalid VIDEO_ONLY asset: ${asset}. Allowed: mp4, mov, m4v, webm.`);
    }
    if (!(await pathExists(asset))) {
      throw new Error(`VIDEO_ONLY asset does not exist: ${asset}`);
    }
  }

  const adsets = [];
  for (let adsetIndex = 1; adsetIndex <= effectiveAdsetCount; adsetIndex += 1) {
    const ads = [];
    const adIndexBase = (adsetIndex - 1) * effectiveCreativeCount;
    for (let videoIndex = 1; videoIndex <= effectiveCreativeCount; videoIndex += 1) {
      const globalAdIndex = adIndexBase + videoIndex;
      const adName = buildVideoOnlyAdName(globalAdIndex, env, date);
      const assetPath = videoAssets[globalAdIndex - 1];
      const landingUrl = getVideoOnlyLandingUrl(adName);
      ads.push({
        type: 'video',
        index: globalAdIndex,
        adsetLocalIndex: videoIndex,
        name: adName,
        assetPath,
        landingUrl,
        creativePayload: buildVideoCreativePayload({
          videoAsset: assetPath,
          thumbnailAsset: env.VIDEO_ONLY_THUMBNAIL || '',
          landingUrl,
        }),
      });
    }

    adsets.push({
      index: adsetIndex,
      name: buildVideoOnlyAdsetName(adsetIndex, env, date),
      landingUrl: ads[0]?.landingUrl || '',
      ads,
    });
  }

  return {
    mode: CAMPAIGN_MODES.VIDEO_ONLY,
    campaignName: env.CAMPAIGN_NAME || '',
    adsetCount: effectiveAdsetCount,
    videoAdsPerAdset: effectiveCreativeCount,
    totalAdsPerAdset: effectiveCreativeCount,
    totalAds: requiredAssetCount,
    videoAssets: videoAssets.slice(0, requiredAssetCount),
    adsets,
  };
}

export function getVideoOnlyAdPlanBySequence(plan, sequence) {
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
    const adsetDuplicateCount = readIntegerEnv(env, 'ADSET_COUNT', 1);
    const adCreativeDuplicateCount = readIntegerEnv(env, 'AD_CREATIVE_COUNT', readIntegerEnv(env, 'ADSET_CREATIVE_COUNT', 5));
    if (!isPerAdImageOnlyUploadMode(env)) return { mode, plan: null };

    const imageAssets = await getImageOnlyAssets(env, options);
    const effectiveAdsetCount = adsetDuplicateCount + 1;
    const effectiveCreativeCount = adCreativeDuplicateCount + 1;
    const requiredAssetCount = effectiveAdsetCount * effectiveCreativeCount;
    if (imageAssets.length < requiredAssetCount) {
      throw new Error(`IMAGE_ONLY per-ad upload requires at least ${requiredAssetCount} image assets. Found ${imageAssets.length}. Set IMAGE_ONLY_UPLOAD_MODE=LEGACY to use the old bulk upload/search flow.`);
    }

    for (const asset of imageAssets.slice(0, requiredAssetCount)) {
      if (!IMAGE_EXTENSIONS.test(asset)) {
        throw new Error(`Invalid IMAGE_ONLY asset: ${asset}. Allowed: png, jpg, jpeg, webp, gif.`);
      }
      if (!(await pathExists(asset))) {
        throw new Error(`IMAGE_ONLY asset does not exist: ${asset}`);
      }
    }

    return {
      mode,
      plan: {
        mode,
        campaignName: env.CAMPAIGN_NAME || '',
        uploadMode: 'PER_AD',
        adsetCount: effectiveAdsetCount,
        creativeCount: effectiveCreativeCount,
        totalAds: requiredAssetCount,
        imageAssets: imageAssets.slice(0, requiredAssetCount),
      },
    };
  }

  if (mode === CAMPAIGN_MODES.VIDEO_ONLY) {
    const plan = await buildVideoOnlyPlan(env, options);
    return { mode, plan };
  }

  const plan = await buildBlogMixedPlan(env, options);
  return { mode, plan };
}
