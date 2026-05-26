import fs from 'node:fs/promises';
import path from 'node:path';

export const CAMPAIGN_MODES = {
  IMAGE_ONLY: 'IMAGE_ONLY',
  BLOG_MIXED: 'BLOG_MIXED',
  BLOG_VIDEO: 'BLOG_VIDEO',
  BLOG_VIDEO_DIRECT: 'BLOG_VIDEO_DIRECT',
  VIDEO_ONLY: 'VIDEO_ONLY',
  VIDEO_ONLY_CBO: 'VIDEO_ONLY_CBO',
  IMAGE_ONLY_CBO: 'IMAGE_ONLY_CBO',
};

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm)$/i;
const VIDEO_ONLY_CBO_EXTENSIONS = ['.mp4', '.mov', '.m4v'];
const IMAGE_ONLY_CBO_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

export function parseBoolean(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function normalizeCampaignMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['BLOG', 'BLOG_CAMPAIGN', 'BLOG_MIXED', 'BLOG_MIXED_CAMPAIGN'].includes(normalized)) {
    return CAMPAIGN_MODES.BLOG_MIXED;
  }
  if (['BLOG_VIDEO', 'BLOG_VIDEO_CAMPAIGN', 'BLOG_VIDEO_ONLY', 'BLOG_ONLY_VIDEO'].includes(normalized)) {
    return CAMPAIGN_MODES.BLOG_VIDEO;
  }
  if (['BLOG_VIDEO_DIRECT', 'BLOG_VIDEO_DIRECT_CAMPAIGN', 'BLOG_DIRECT_VIDEO', 'VIDEO_BLOG_DIRECT'].includes(normalized)) {
    return CAMPAIGN_MODES.BLOG_VIDEO_DIRECT;
  }
  if (['VIDEO', 'VIDEO_ONLY', 'VIDEO_CAMPAIGN', 'VIDEO_ONLY_CAMPAIGN'].includes(normalized)) {
    return CAMPAIGN_MODES.VIDEO_ONLY;
  }
  if (['VIDEO_ONLY_CBO', 'VIDEO_ONLY_CBO_CAMPAIGN', 'VIDEO_CBO', 'CBO_VIDEO_ONLY'].includes(normalized)) {
    return CAMPAIGN_MODES.VIDEO_ONLY_CBO;
  }
  if (['IMAGE_ONLY_CBO', 'IMAGE_ONLY_CBO_CAMPAIGN', 'IMAGE_CBO', 'CBO_IMAGE_ONLY'].includes(normalized)) {
    return CAMPAIGN_MODES.IMAGE_ONLY_CBO;
  }
  return CAMPAIGN_MODES.IMAGE_ONLY;
}

export function isBlogMixedMode(mode) {
  return normalizeCampaignMode(mode) === CAMPAIGN_MODES.BLOG_MIXED;
}

export function isBlogVideoMode(mode) {
  return [CAMPAIGN_MODES.BLOG_VIDEO, CAMPAIGN_MODES.BLOG_VIDEO_DIRECT].includes(normalizeCampaignMode(mode));
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

function renderNameTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    if (key === 'mmdd') return vars.MMDD;
    if (key === 'date') return vars.MMDD;
    if (key === 'index') return vars.idx;
    if (!(key in vars)) {
      throw new Error(`Unknown template variable: {${key}}`);
    }
    return String(vars[key]);
  });
}

function dateTokensForTemplate(date, env = process.env) {
  const mmdd = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: 'MMDD',
  });
  const yyyymmdd = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: 'YYYYMMDD',
  });
  return {
    MMDD: mmdd,
    YYMMDD: yyyymmdd.slice(2),
  };
}

export function buildBlogAdsetName(adsetIndex, env = process.env, date = new Date()) {
  const prefix = env.BLOG_ADSET_NAME_PREFIX || (isBlogVideoMode(env.CAMPAIGN_MODE) ? 'f_v_b_o_l' : 'f_i_b_o_l');
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  const template = String(env.BLOG_ADSET_NAME_TEMPLATE || '').trim();
  if (template) {
    return renderNameTemplate(template, {
      MMDD: today,
      YYMMDD: getTodayString({ date, timezone: env.TIMEZONE || 'Asia/Seoul', dateFormat: 'YYYYMMDD' }).slice(2),
      idx: adsetIndex,
    });
  }
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
  const prefix = normalizeCampaignMode(env.CAMPAIGN_MODE) === CAMPAIGN_MODES.BLOG_VIDEO_DIRECT
    ? (env.BLOG_VIDEO_DIRECT_AD_NAME_PREFIX || env.BLOG_VIDEO_AD_NAME_PREFIX_DIRECT || 'f_v_o_l')
    : (env.BLOG_VIDEO_AD_NAME_PREFIX || 'f_v_b_o_l');
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

export function buildVideoOnlyCboAdName(adIndex, env = process.env, date = new Date()) {
  const explicitName = String(env[`VIDEO_ONLY_CBO_AD_NAME_${adIndex}`] || env[`AD_NAME_${adIndex}`] || '').trim();
  if (explicitName) return explicitName;
  const prefix = env.VIDEO_ONLY_CBO_AD_NAME_PREFIX || 'f_v_b_o_l';
  const today = String(env.VIDEO_ONLY_CBO_AD_DATE || env.AD_NAME_DATE_OVERRIDE || '').trim() || getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function buildImageOnlyCboAdName(adIndex, env = process.env, date = new Date()) {
  const explicitName = String(env[`IMAGE_ONLY_CBO_AD_NAME_${adIndex}`] || env[`AD_NAME_${adIndex}`] || '').trim();
  if (explicitName) return explicitName;
  const prefix = env.IMAGE_ONLY_CBO_AD_NAME_PREFIX || 'f_i_b_o_l';
  const today = String(env.IMAGE_ONLY_CBO_AD_DATE || env.AD_NAME_DATE_OVERRIDE || '').trim() || getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  return `${prefix}_${today}_${adIndex}`;
}

export function buildVideoOnlyCboAdsetName(adsetIndex, env = process.env, date = new Date()) {
  const explicitName = String(env[`VIDEO_ONLY_CBO_ADSET_NAME_${adsetIndex}`] || env[`ADSET_NAME_${adsetIndex}`] || '').trim();
  if (explicitName) return explicitName;
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  const prefix = env.VIDEO_ONLY_CBO_ADSET_NAME_PREFIX || `${today} CBO 광고세트`;
  return `${prefix} -${adsetIndex}`;
}

export function buildImageOnlyCboAdsetName(adsetIndex, env = process.env, date = new Date()) {
  const explicitName = String(env[`IMAGE_ONLY_CBO_ADSET_NAME_${adsetIndex}`] || env[`ADSET_NAME_${adsetIndex}`] || '').trim();
  if (explicitName) return explicitName;
  const today = getTodayString({
    date,
    timezone: env.TIMEZONE || 'Asia/Seoul',
    dateFormat: env.DATE_FORMAT || 'MMDD',
  });
  const prefix = env.IMAGE_ONLY_CBO_ADSET_NAME_PREFIX || `${today} CBO 광고세트`;
  return `${prefix} -${adsetIndex}`;
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

function getLandingPathNumber(env = process.env) {
  const value = String(env.LANDING_PATH_NUMBER || env.REPURELY_PATH_NUMBER || '100').trim();
  return /^\d+$/.test(value) ? value : '100';
}

export function getVideoOnlyLandingUrl(adName, env = process.env) {
  const baseUrl = String(env.REPURELY_BASE_URL || 'https://repurely.com/surl/P').replace(/\/$/, '');
  return `${baseUrl}/${getLandingPathNumber(env)}?utm_source=f&utm_medium=f&utm_campaign=${adName}`;
}

export function getVideoOnlyCboLandingUrl(adIndex, adName, env = process.env) {
  const value = String(
    env[`VIDEO_ONLY_CBO_LANDING_URL_${adIndex}`] ||
    env[`VIDEO_ONLY_CBO_AD_LANDING_URL_${adIndex}`] ||
    env[`LANDING_URL_${adIndex}`] ||
    ''
  ).trim();
  if (value) return value;
  if (parseBoolean(env.VIDEO_ONLY_CBO_AUTO_LANDING_URL)) return getVideoOnlyLandingUrl(adName, env);
  throw new Error(`Missing VIDEO_ONLY_CBO_LANDING_URL_${adIndex}. VIDEO_ONLY_CBO requires one landing URL per ad.`);
}

export function getImageOnlyCboLandingUrl(adIndex, adName, env = process.env) {
  const value = String(
    env[`IMAGE_ONLY_CBO_LANDING_URL_${adIndex}`] ||
    env[`IMAGE_ONLY_CBO_AD_LANDING_URL_${adIndex}`] ||
    env[`LANDING_URL_${adIndex}`] ||
    ''
  ).trim();
  if (value) return value;
  if (parseBoolean(env.IMAGE_ONLY_CBO_AUTO_LANDING_URL)) return getVideoOnlyLandingUrl(adName, env);
  throw new Error(`Missing IMAGE_ONLY_CBO_LANDING_URL_${adIndex}. IMAGE_ONLY_CBO requires one landing URL per ad.`);
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

function normalizeFolderName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeAssetStem(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveAssetPath(assetPath, baseDir = process.cwd()) {
  return path.isAbsolute(assetPath) ? assetPath : path.resolve(baseDir, assetPath);
}

export function formatBudgetForMetaInput(value) {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`CAMPAIGN_BUDGET must be a positive integer. Received: ${value}`);
  }
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`CAMPAIGN_BUDGET must be greater than 0. Received: ${value}`);
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(numeric);
}

export function validateCampaignName(value) {
  const campaignName = String(value || '').trim();
  if (!campaignName) throw new Error('CAMPAIGN_NAME is required for CBO campaign mode.');
  return campaignName;
}

export async function findVideoFileByAdName(adName, videoFolder, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const folder = resolveAssetPath(String(videoFolder || '').trim(), baseDir);
  if (!String(videoFolder || '').trim()) {
    throw new Error('VIDEO_ONLY_CBO_VIDEO_FOLDER is required.');
  }
  if (!(await pathExists(folder))) {
    throw new Error(`VIDEO_ONLY_CBO video folder does not exist: ${folder}`);
  }

  const expected = VIDEO_ONLY_CBO_EXTENSIONS.map((ext) => `${adName}${ext}`);
  for (const filename of expected) {
    const candidate = path.join(folder, filename);
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error(`Video file not found for ad name: ${adName}. Expected one of: ${expected.join(', ')}`);
}

export async function findImageFileByAdName(adName, imageFolder, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const folder = resolveAssetPath(String(imageFolder || '').trim(), baseDir);
  if (!String(imageFolder || '').trim()) {
    throw new Error('IMAGE_ONLY_CBO_IMAGE_FOLDER is required.');
  }
  if (!(await pathExists(folder))) {
    throw new Error(`IMAGE_ONLY_CBO image folder does not exist: ${folder}`);
  }

  const expected = IMAGE_ONLY_CBO_EXTENSIONS.map((ext) => `${adName}${ext}`);
  for (const filename of expected) {
    const candidate = path.join(folder, filename);
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error(`Image file not found for ad name: ${adName}. Expected one of: ${expected.join(', ')}`);
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
    }))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const preferred = directories.find((entry) => entry.name.startsWith(preferredPrefix));
  if (preferred) return preferred.fullPath;

  const fallback = directories.find((entry) => entry.name.includes(fallbackToken));
  if (fallback) return fallback.fullPath;

  const loosePattern = new RegExp(`(^|\\D)${adsetIndex}\\s*번\\s*광고\\s*세트`, 'i');
  const loose = directories.find((entry) => loosePattern.test(entry.name));
  return loose?.fullPath || '';
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

async function findVideoOnlyCampaignFolder(rootPath, campaignName) {
  const normalizedCampaignName = normalizeFolderName(campaignName);
  if (!rootPath || !normalizedCampaignName || !(await pathExists(rootPath))) return '';

  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(rootPath, entry.name),
    }))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const exact = directories.find((entry) => normalizeFolderName(entry.name) === normalizedCampaignName);
  return exact?.fullPath || '';
}

function findVideoAssetByAdName(assets, adName) {
  const normalizedAdName = normalizeAssetStem(adName);
  return assets.find((assetPath) => {
    const stem = path.basename(assetPath).replace(/\.[^.]+$/, '');
    return normalizeAssetStem(stem) === normalizedAdName;
  }) || '';
}

function findAssetByAdName(assets, adName) {
  const normalizedAdName = normalizeAssetStem(adName);
  return assets.find((assetPath) => {
    const stem = path.basename(assetPath).replace(/\.[^.]+$/, '');
    return normalizeAssetStem(stem) === normalizedAdName;
  }) || '';
}

function shouldRequireExactBlogAssetNames(env = process.env) {
  return String(env.BLOG_ASSET_MATCH_MODE || env.BLOG_REQUIRE_EXACT_ASSET_NAMES || 'legacy')
    .trim()
    .toLowerCase() !== 'legacy';
}

function resolveBlogAssetForAdName(assets, adName, fallbackAsset, kind, adsetIndex, env = process.env) {
  const exactAsset = findAssetByAdName(assets, adName);
  if (exactAsset) return exactAsset;
  if (!shouldRequireExactBlogAssetNames(env) && fallbackAsset) return fallbackAsset;

  const extensions = kind === 'video'
    ? ['.mp4', '.mov', '.m4v', '.webm']
    : ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  throw new Error(
    `BLOG_${kind.toUpperCase()} asset not found for ad name: ${adName} in adset ${adsetIndex}. Expected one of: ${extensions.map((ext) => `${adName}${ext}`).join(', ')}`,
  );
}

async function resolveBlogAssetDir(adsetIndex, env, options, kind) {
  const baseDir = options.baseDir || process.cwd();
  const rootDir = env.BLOG_ASSET_ROOT ? resolveAssetPath(env.BLOG_ASSET_ROOT, baseDir) : '';
  const configuredDir = env[`BLOG_ADSET_${adsetIndex}_${kind}_DIR`];
  if (configuredDir) return resolveAssetPath(configuredDir, baseDir);
  if (!rootDir) return '';

  const expectedAdsetName = String(options.expectedAdsetName || '').trim();
  if (expectedAdsetName) {
    const namedDir = path.join(rootDir, expectedAdsetName);
    if (await pathExists(namedDir)) return namedDir;
  }

  const conventionalDir = path.join(rootDir, `adset_${adsetIndex}`, kind.toLowerCase() === 'image' ? 'images' : 'videos');
  if (await pathExists(conventionalDir)) return conventionalDir;

  return findBlogAdsetFolderFromRoot(rootDir, adsetIndex, options);
}

function resolveBlogAssetRoot(env = process.env, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  return env.BLOG_ASSET_ROOT ? resolveAssetPath(env.BLOG_ASSET_ROOT, baseDir) : '';
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

async function getFlatBlogVideoAssets(env = process.env, options = {}) {
  const rootDir = resolveBlogAssetRoot(env, options);
  if (!rootDir || !(await pathExists(rootDir))) return [];
  return listFilesFromDir(rootDir, VIDEO_EXTENSIONS).catch(() => []);
}

async function getBlogVideoAssetsForAdset(adsetIndex, totalAdsPerAdset, env = process.env, options = {}) {
  const startIndex = (adsetIndex - 1) * totalAdsPerAdset;
  const expectedAdsetName = options.expectedAdsetName || buildBlogVideoAdName(startIndex + 1, env, options.date || new Date());
  const folderAssets = await getVideoAssetsForAdset(adsetIndex, env, { ...options, expectedAdsetName });
  if (folderAssets.length) return folderAssets;

  const flatAssets = await getFlatBlogVideoAssets(env, options);
  if (!flatAssets.length) return [];
  return flatAssets.slice(startIndex, startIndex + totalAdsPerAdset);
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
  const mode = normalizeCampaignMode(env.CAMPAIGN_MODE);
  const isBlogVideo = [CAMPAIGN_MODES.BLOG_VIDEO, CAMPAIGN_MODES.BLOG_VIDEO_DIRECT].includes(mode);
  const isBlogVideoDirect = mode === CAMPAIGN_MODES.BLOG_VIDEO_DIRECT;
  const adsetCount = readIntegerEnv(env, 'ADSET_COUNT', 1);
  const fallbackTotalAdsPerAdset = readIntegerEnv(
    env,
    'BLOG_TOTAL_ADS_PER_ADSET',
    isBlogVideo
      ? readIntegerEnv(env, 'BLOG_VIDEO_ADS_PER_ADSET', readIntegerEnv(env, 'AD_CREATIVE_COUNT', 4) + 1)
      : readIntegerEnv(env, 'BLOG_IMAGE_ADS_PER_ADSET', 4) + readIntegerEnv(env, 'BLOG_VIDEO_ADS_PER_ADSET', 1),
  );
  const adCreativeDuplicateCount = readIntegerEnv(
    env,
    'AD_CREATIVE_COUNT',
    readIntegerEnv(env, 'ADSET_CREATIVE_COUNT', Math.max(fallbackTotalAdsPerAdset - 1, 1)),
  );
  const totalAdsPerAdset = adCreativeDuplicateCount + 1;
  const videoAdsPerAdset = isBlogVideo ? totalAdsPerAdset : 1;
  const imageAdsPerAdset = totalAdsPerAdset - videoAdsPerAdset;

  if (adsetCount < 1) throw new Error('ADSET_COUNT must be >= 1.');
  if (!isBlogVideo && adCreativeDuplicateCount < 1) throw new Error('AD_CREATIVE_COUNT must be >= 1 for BLOG_MIXED.');
  if (isBlogVideo && adCreativeDuplicateCount < 0) throw new Error('AD_CREATIVE_COUNT must be >= 0 for BLOG_VIDEO.');
  if (!isBlogVideo && imageAdsPerAdset < 1) throw new Error('BLOG_MIXED requires at least 1 image ad before the final video ad.');

  const adsets = [];
  for (let adsetIndex = 1; adsetIndex <= adsetCount; adsetIndex += 1) {
    const adIndexBase = (adsetIndex - 1) * totalAdsPerAdset;
    const adsetName = isBlogVideo
      ? buildBlogVideoAdName(adIndexBase + 1, env, date)
      : buildBlogAdsetName(adsetIndex, env, date);
    const landingUrl = isBlogVideoDirect ? '' : getLandingUrlForAdset(adsetIndex, env);
    const imageAssets = await getImageAssetsForAdset(adsetIndex, env, { baseDir });
    const videoAssets = isBlogVideo
      ? await getBlogVideoAssetsForAdset(adsetIndex, totalAdsPerAdset, env, { baseDir, date, expectedAdsetName: adsetName })
      : await getVideoAssetsForAdset(adsetIndex, env, { baseDir });
    const videoAsset = videoAssets[0] || '';
    const exactBlogAssetNames = shouldRequireExactBlogAssetNames(env);

    if (!exactBlogAssetNames && !isBlogVideo && imageAssets.length !== imageAdsPerAdset) {
      throw new Error(`BLOG_MIXED requires exactly ${imageAdsPerAdset} image assets for adset ${adsetIndex}. Found ${imageAssets.length}.`);
    }

    const invalidImage = imageAssets.slice(0, imageAdsPerAdset).find((assetPath) => !IMAGE_EXTENSIONS.test(assetPath));
    if (invalidImage) {
      throw new Error(`Invalid image asset for adset ${adsetIndex}: ${invalidImage}. Allowed: png, jpg, jpeg, webp, gif.`);
    }
    for (const imageAsset of imageAssets.slice(0, imageAdsPerAdset)) {
      if (!(await pathExists(imageAsset))) {
        throw new Error(`Image asset does not exist for adset ${adsetIndex}: ${imageAsset}`);
      }
    }

    if (!exactBlogAssetNames && videoAssets.length !== videoAdsPerAdset) {
      const videoAssetLabel = videoAdsPerAdset === 1 ? 'video asset' : 'video assets';
      throw new Error(`${isBlogVideo ? 'BLOG_VIDEO' : 'BLOG_MIXED'} requires exactly ${videoAdsPerAdset} ${videoAssetLabel} for adset ${adsetIndex}. Found ${videoAssets.length}.`);
    }
    for (const assetPath of videoAssets) {
      if (!VIDEO_EXTENSIONS.test(assetPath)) {
        throw new Error(`Invalid video asset for adset ${adsetIndex}: ${assetPath}. Allowed: mp4, mov, m4v, webm.`);
      }
      if (!(await pathExists(assetPath))) {
        throw new Error(`Video asset does not exist for adset ${adsetIndex}: ${assetPath}`);
      }
    }

    const ads = [];
    for (let imageIndex = 1; imageIndex <= imageAdsPerAdset; imageIndex += 1) {
      const globalAdIndex = adIndexBase + imageIndex;
      const defaultImageAdName = buildBlogImageAdName(globalAdIndex, env, date);
      const imageAdName = defaultImageAdName;
      const imageAsset = resolveBlogAssetForAdName(
        imageAssets,
        imageAdName,
        imageAssets[imageIndex - 1],
        'image',
        adsetIndex,
        env,
      );
      ads.push({
        type: 'image',
        index: globalAdIndex,
        adsetLocalIndex: imageIndex,
        name: imageAdName,
        assetPath: imageAsset,
        landingUrl,
        creativePayload: buildImageCreativePayload({
          imageAsset,
          landingUrl,
        }),
      });
    }

    for (let videoIndex = 1; videoIndex <= videoAdsPerAdset; videoIndex += 1) {
      const videoAdIndex = adIndexBase + imageAdsPerAdset + videoIndex;
      const defaultVideoAdName = buildBlogVideoAdName(videoAdIndex, env, date);
      const videoAdName = defaultVideoAdName;
      const currentVideoAsset = resolveBlogAssetForAdName(
        videoAssets,
        videoAdName,
        videoAssets[videoIndex - 1],
        'video',
        adsetIndex,
        env,
      );
      const videoLandingUrl = isBlogVideoDirect ? getVideoOnlyLandingUrl(videoAdName, env) : landingUrl;
      ads.push({
        type: 'video',
        index: videoAdIndex,
        adsetLocalIndex: imageAdsPerAdset + videoIndex,
        name: videoAdName,
        assetPath: currentVideoAsset,
        landingUrl: videoLandingUrl,
        creativePayload: buildVideoCreativePayload({
          videoAsset: currentVideoAsset,
          thumbnailAsset: env[`BLOG_ADSET_${adsetIndex}_VIDEO_THUMBNAIL`] || env.BLOG_VIDEO_THUMBNAIL || '',
          landingUrl: videoLandingUrl,
        }),
      });
    }

    adsets.push({
      index: adsetIndex,
      name: adsetName,
      landingUrl: isBlogVideoDirect ? '(auto per ad)' : landingUrl,
      imageAssets,
      videoAsset,
      videoAssets,
      ads,
    });
  }

  return {
    mode,
    campaignName: env.CAMPAIGN_NAME || '',
    adsetCount,
    adCreativeDuplicateCount,
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

async function getVideoOnlyAssetsForFolderName(env = process.env, options = {}, folderName = '') {
  const baseDir = options.baseDir || process.cwd();
  const assetRoot = String(env.VIDEO_ONLY_ASSET_ROOT || env.MEDIA_FOLDER_PATH || '').trim();
  const resolvedRoot = assetRoot ? resolveAssetPath(assetRoot, baseDir) : '';
  if (!assetRoot || !(await pathExists(resolvedRoot))) return [];

  const roots = [];
  const detectedRoot = await findVideoOnlyAssetRoot(resolvedRoot, options);
  if (detectedRoot) roots.push(detectedRoot);
  roots.push(resolvedRoot);

  for (const root of [...new Set(roots)]) {
    const matchedFolder = await findVideoOnlyCampaignFolder(root, folderName);
    if (matchedFolder) {
      return listFilesFromDirTree(matchedFolder, VIDEO_EXTENSIONS, 1);
    }
  }

  return [];
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
  const plannedAssets = [];
  for (let adsetIndex = 1; adsetIndex <= effectiveAdsetCount; adsetIndex += 1) {
    const adsetName = buildVideoOnlyAdsetName(adsetIndex, env, date);
    const adsetFolderAssets = await getVideoOnlyAssetsForFolderName(env, options, adsetName);
    const ads = [];
    const adIndexBase = (adsetIndex - 1) * effectiveCreativeCount;
    for (let videoIndex = 1; videoIndex <= effectiveCreativeCount; videoIndex += 1) {
      const globalAdIndex = adIndexBase + videoIndex;
      const adName = buildVideoOnlyAdName(globalAdIndex, env, date);
      const assetPath = findVideoAssetByAdName(adsetFolderAssets, adName)
        || findVideoAssetByAdName(videoAssets, adName)
        || videoAssets[globalAdIndex - 1];
      if (!assetPath) {
        throw new Error(`VIDEO_ONLY asset not found for ad ${adName}. Expected a video file named ${adName}.mp4/.mov/.m4v/.webm.`);
      }
      plannedAssets.push(assetPath);
      const landingUrl = getVideoOnlyLandingUrl(adName, env);
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
      name: adsetName,
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
    videoAssets: plannedAssets,
    adsets,
  };
}

export async function buildVideoOnlyCboPlan(env = process.env, options = {}) {
  const date = options.date || new Date();
  const campaignName = validateCampaignName(env.CAMPAIGN_NAME);
  const campaignBudget = formatBudgetForMetaInput(env.CAMPAIGN_BUDGET || env.VIDEO_ONLY_CBO_CAMPAIGN_BUDGET || '');
  const videoFolder = env.VIDEO_ONLY_CBO_VIDEO_FOLDER || env.VIDEO_ONLY_ASSET_ROOT || env.MEDIA_FOLDER_PATH || '';
  const adCreativeDuplicateCount = readIntegerEnv(env, 'AD_CREATIVE_COUNT', readIntegerEnv(env, 'VIDEO_AD_COUNT', readIntegerEnv(env, 'ADSET_CREATIVE_COUNT', 0)));
  const effectiveAdsetCount = 1;
  const effectiveCreativeCount = adCreativeDuplicateCount + 1;
  const requiredAssetCount = effectiveAdsetCount * effectiveCreativeCount;
  const seenNames = new Set();
  const seenAssets = new Set();
  const adsets = [];
  const videoAssets = [];

  for (let adsetIndex = 1; adsetIndex <= effectiveAdsetCount; adsetIndex += 1) {
    const adsetName = buildVideoOnlyCboAdsetName(adsetIndex, env, date);
    const ads = [];
    const adIndexBase = (adsetIndex - 1) * effectiveCreativeCount;
    for (let videoIndex = 1; videoIndex <= effectiveCreativeCount; videoIndex += 1) {
      const globalAdIndex = adIndexBase + videoIndex;
      const adName = buildVideoOnlyCboAdName(globalAdIndex, env, date);
      if (seenNames.has(adName)) throw new Error(`Duplicate VIDEO_ONLY_CBO ad name: ${adName}`);
      seenNames.add(adName);

      const assetPath = await findVideoFileByAdName(adName, videoFolder, options);
      if (seenAssets.has(assetPath)) throw new Error(`Duplicate VIDEO_ONLY_CBO video asset path: ${assetPath}`);
      seenAssets.add(assetPath);
      videoAssets.push(assetPath);

      const landingUrl = getVideoOnlyCboLandingUrl(globalAdIndex, adName, env);
      if (!landingUrl) throw new Error(`Missing landing URL for ad name: ${adName}`);
      ads.push({
        type: 'video',
        index: globalAdIndex,
        adsetLocalIndex: videoIndex,
        name: adName,
        assetPath,
        landingUrl,
        creativePayload: buildVideoCreativePayload({
          videoAsset: assetPath,
          thumbnailAsset: env.VIDEO_ONLY_CBO_THUMBNAIL || '',
          landingUrl,
        }),
      });
    }

    adsets.push({
      index: adsetIndex,
      name: adsetName,
      landingUrl: ads[0]?.landingUrl || '',
      ads,
    });
  }

  if (videoAssets.length !== requiredAssetCount) {
    throw new Error(`VIDEO_ONLY_CBO requires exactly ${requiredAssetCount} video files. Found ${videoAssets.length}.`);
  }

  return {
    mode: CAMPAIGN_MODES.VIDEO_ONLY_CBO,
    campaignName,
    campaignBudget,
    rawCampaignBudget: String(env.CAMPAIGN_BUDGET || env.VIDEO_ONLY_CBO_CAMPAIGN_BUDGET || '').trim(),
    videoFolder: resolveAssetPath(videoFolder, options.baseDir || process.cwd()),
    adsetCount: effectiveAdsetCount,
    videoAdsPerAdset: effectiveCreativeCount,
    totalAdsPerAdset: effectiveCreativeCount,
    totalAds: requiredAssetCount,
    videoAssets,
    adsets,
  };
}

export async function buildImageOnlyCboPlan(env = process.env, options = {}) {
  const date = options.date || new Date();
  const campaignName = validateCampaignName(env.CAMPAIGN_NAME);
  const campaignBudget = formatBudgetForMetaInput(env.CAMPAIGN_BUDGET || env.IMAGE_ONLY_CBO_CAMPAIGN_BUDGET || '');
  const imageFolder = env.IMAGE_ONLY_CBO_IMAGE_FOLDER || env.IMAGE_ONLY_ASSET_ROOT || env.MEDIA_FOLDER_PATH || '';
  const adCreativeDuplicateCount = readIntegerEnv(env, 'AD_CREATIVE_COUNT', readIntegerEnv(env, 'IMAGE_AD_COUNT', readIntegerEnv(env, 'ADSET_CREATIVE_COUNT', 0)));
  const effectiveAdsetCount = 1;
  const effectiveCreativeCount = adCreativeDuplicateCount + 1;
  const requiredAssetCount = effectiveAdsetCount * effectiveCreativeCount;
  const seenNames = new Set();
  const seenAssets = new Set();
  const adsets = [];
  const imageAssets = [];

  for (let adsetIndex = 1; adsetIndex <= effectiveAdsetCount; adsetIndex += 1) {
    const adsetName = buildImageOnlyCboAdsetName(adsetIndex, env, date);
    const ads = [];
    const adIndexBase = (adsetIndex - 1) * effectiveCreativeCount;
    for (let imageIndex = 1; imageIndex <= effectiveCreativeCount; imageIndex += 1) {
      const globalAdIndex = adIndexBase + imageIndex;
      const adName = buildImageOnlyCboAdName(globalAdIndex, env, date);
      if (seenNames.has(adName)) throw new Error(`Duplicate IMAGE_ONLY_CBO ad name: ${adName}`);
      seenNames.add(adName);

      const assetPath = await findImageFileByAdName(adName, imageFolder, options);
      if (seenAssets.has(assetPath)) throw new Error(`Duplicate IMAGE_ONLY_CBO image asset path: ${assetPath}`);
      seenAssets.add(assetPath);
      imageAssets.push(assetPath);

      const landingUrl = getImageOnlyCboLandingUrl(globalAdIndex, adName, env);
      if (!landingUrl) throw new Error(`Missing landing URL for ad name: ${adName}`);
      ads.push({
        type: 'image',
        index: globalAdIndex,
        adsetLocalIndex: imageIndex,
        name: adName,
        assetPath,
        landingUrl,
        creativePayload: buildImageCreativePayload({
          imageAsset: assetPath,
          landingUrl,
        }),
      });
    }

    adsets.push({
      index: adsetIndex,
      name: adsetName,
      landingUrl: ads[0]?.landingUrl || '',
      ads,
    });
  }

  if (imageAssets.length !== requiredAssetCount) {
    throw new Error(`IMAGE_ONLY_CBO requires exactly ${requiredAssetCount} image files. Found ${imageAssets.length}.`);
  }

  return {
    mode: CAMPAIGN_MODES.IMAGE_ONLY_CBO,
    campaignName,
    campaignBudget,
    rawCampaignBudget: String(env.CAMPAIGN_BUDGET || env.IMAGE_ONLY_CBO_CAMPAIGN_BUDGET || '').trim(),
    imageFolder: resolveAssetPath(imageFolder, options.baseDir || process.cwd()),
    adsetCount: effectiveAdsetCount,
    imageAdsPerAdset: effectiveCreativeCount,
    totalAdsPerAdset: effectiveCreativeCount,
    totalAds: requiredAssetCount,
    imageAssets,
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

export function getVideoOnlyCboAdPlanBySequence(plan, sequence) {
  return getVideoOnlyAdPlanBySequence(plan, sequence);
}

export function getImageOnlyCboAdPlanBySequence(plan, sequence) {
  return getVideoOnlyAdPlanBySequence(plan, sequence);
}

export function formatDryRunPlan(plan) {
  const lines = [
    '[DRY RUN] Meta Ads Automation plan',
    `campaign mode: ${plan.mode}`,
    `campaign name: ${plan.campaignName}`,
    ...(plan.campaignBudget ? [`campaign budget: ${plan.campaignBudget}`] : []),
    ...(plan.videoFolder ? [`video folder: ${plan.videoFolder}`] : []),
    ...(plan.imageFolder ? [`image folder: ${plan.imageFolder}`] : []),
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

  if (mode === CAMPAIGN_MODES.VIDEO_ONLY_CBO) {
    const plan = await buildVideoOnlyCboPlan(env, options);
    return { mode, plan };
  }

  if (mode === CAMPAIGN_MODES.IMAGE_ONLY_CBO) {
    const plan = await buildImageOnlyCboPlan(env, options);
    return { mode, plan };
  }

  const plan = await buildBlogMixedPlan(env, options);
  return { mode, plan };
}
