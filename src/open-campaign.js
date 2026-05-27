import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  CAMPAIGN_MODES,
  buildBlogAdsetName,
  buildImageOnlyCboAdsetName,
  buildVideoOnlyCboAdsetName,
  buildVideoOnlyAdsetName,
  formatBudgetForMetaInput,
  formatDryRunPlan,
  getBlogAdPlanBySequence,
  getImageOnlyAssetBySequence,
  getImageOnlyCboAdPlanBySequence,
  getImageOnlyAssets,
  getVideoOnlyCboAdPlanBySequence,
  getVideoOnlyAdPlanBySequence,
  getVideoOnlyAssetBySequence,
  getVideoOnlyAssets,
  isPerAdImageOnlyUploadMode,
  normalizeCampaignMode,
  parseBoolean,
  validateCampaignConfig,
} from './campaign-config.js';
import {
  classifyAutomationError,
  notifyError,
  notifyStop,
  notifySuccess,
  notifyVideoUploadTimeout,
} from './notifier.js';

const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME;
const ADSET_INDEX = process.env.ADSET_INDEX;
const ADSET_BASE_NAME = '리타겟';
const ADSET_START_INDEX = Number(process.env.ADSET_START_INDEX || ADSET_INDEX || 1);
const ADSET_COUNT_RAW = process.env.ADSET_COUNT ?? process.env.adset_count;
const ADSET_COUNT = Number(ADSET_COUNT_RAW === undefined || String(ADSET_COUNT_RAW).trim() === '' ? 1 : ADSET_COUNT_RAW);
const AD_CREATIVE_COUNT = Number(process.env.ADSET_CREATIVE_COUNT || process.env.AD_CREATIVE_COUNT || process.env.ADVERTISE_COUNT || 5);
const MEDIA_FOLDER_PATH = process.env.MEDIA_FOLDER_PATH;
const SCHEDULE_TIME = process.env.SCHEDULE_TIME || '05:00';
const ADSET_DAILY_BUDGET = String(process.env.ADSET_DAILY_BUDGET || '').trim();
const AD_FORMAT = normalizeAdFormat(process.env.AD_FORMAT || process.env.AD_CREATIVE_FORMAT || process.env.AD_MEDIA_TYPE || 'image');
const CAMPAIGN_MODE = normalizeCampaignMode(process.env.CAMPAIGN_MODE);
const DRY_RUN = parseBoolean(process.env.DRY_RUN);
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const QUICK_TEST_CREATIVE_STEP = String(process.env.QUICK_TEST_CREATIVE_STEP || '').toLowerCase() === 'true';
const ENABLE_SCREENSHOTS = parseBoolean(process.env.ENABLE_SCREENSHOTS);
const QUICK_TEST_AD_NAME = process.env.QUICK_TEST_AD_NAME || getAdName(1);
const INITIAL_RESUME_FROM_AD_NAME = String(process.env.RESUME_FROM_AD_NAME || '').trim();
const INITIAL_RESUME_FROM_AD_INDEX = Number(process.env.RESUME_FROM_AD_INDEX || 1);
let runtimeResumeFromAdName = INITIAL_RESUME_FROM_AD_NAME;
let runtimeResumeFromAdIndex = INITIAL_RESUME_FROM_AD_INDEX;
const AUTO_RESUME_RECOVERABLE_ERRORS = String(process.env.AUTO_RESUME_RECOVERABLE_ERRORS || 'true').trim().toLowerCase() !== 'false';
const AUTO_RESUME_MAX_ATTEMPTS = Number.isFinite(Number(process.env.AUTO_RESUME_MAX_ATTEMPTS))
  ? Number(process.env.AUTO_RESUME_MAX_ATTEMPTS)
  : 3;
const AUTO_RESUME_WAIT_MS = Number.isFinite(Number(process.env.AUTO_RESUME_WAIT_MS))
  ? Number(process.env.AUTO_RESUME_WAIT_MS)
  : 10_000;
const WAIT_CONFIG = {
  baseRetryCount: Number(process.env.WAIT_BASE_RETRY_COUNT || 5),
  baseRetryIntervalMs: Number(process.env.WAIT_BASE_RETRY_INTERVAL_MS || 1500),
  extendedRetryCount: Number(process.env.WAIT_EXTENDED_RETRY_COUNT || 5),
  extendedRetryIntervalMs: Number(process.env.WAIT_EXTENDED_RETRY_INTERVAL_MS || 7000),
  videoUploadTimeoutMs: Number(process.env.VIDEO_UPLOAD_TIMEOUT_MS || 180_000),
  videoFallbackWaitMs: Number(process.env.VIDEO_UPLOAD_FALLBACK_WAIT_MS || 90_000),
  modeOverrides: {
    [CAMPAIGN_MODES.BLOG_MIXED]: Number(process.env.MODE_01_WAIT_MS || process.env.BLOG_MIXED_WAIT_MS || 10_000),
    [CAMPAIGN_MODES.BLOG_VIDEO]: Number(process.env.MODE_BLOG_VIDEO_WAIT_MS || process.env.BLOG_VIDEO_WAIT_MS || 12_000),
    [CAMPAIGN_MODES.BLOG_VIDEO_DIRECT]: Number(process.env.MODE_BLOG_VIDEO_WAIT_MS || process.env.BLOG_VIDEO_DIRECT_WAIT_MS || process.env.BLOG_VIDEO_WAIT_MS || 12_000),
    [CAMPAIGN_MODES.IMAGE_ONLY]: Number(process.env.MODE_02_WAIT_MS || process.env.IMAGE_ONLY_WAIT_MS || 5_000),
    [CAMPAIGN_MODES.VIDEO_ONLY_CBO]: Number(process.env.MODE_03_WAIT_MS || process.env.VIDEO_ONLY_CBO_WAIT_MS || 12_000),
    [CAMPAIGN_MODES.IMAGE_ONLY_CBO]: Number(process.env.MODE_04_WAIT_MS || process.env.IMAGE_ONLY_CBO_WAIT_MS || 6_000),
  },
};
const VIDEO_UPLOAD_TIMEOUT_MS = WAIT_CONFIG.videoUploadTimeoutMs;

let firstCreativeMediaUploaded = false;
let activeCampaignPlan = null;
let imageOnlyPerAdAssets = [];
let videoOnlyAssets = [];
let videoOnlyCboInitialCreateClicked = false;
const performanceEntries = [];
const waitTimeoutEntries = [];
const runContext = {
  campaign_mode: CAMPAIGN_MODE,
  campaign_name: CAMPAIGN_NAME,
  current_step: 'init',
  current_adset_index: null,
  current_adset_name: '',
  current_ad_index: null,
  current_ad_name: '',
  current_landing_url: '',
  current_video_file: '',
  created_campaign_count: 0,
  created_adset_count: 0,
  created_ad_count: 0,
  started_at: new Date().toISOString(),
  ended_at: '',
  last_screenshot: '',
};

const DIRS = {
  screenshots: path.resolve('screenshots'),
};

const PATHS = {
  step1: path.join(DIRS.screenshots, '03-adsmanager-home.png'),
  step2: path.join(DIRS.screenshots, '04-account-entered.png'),
  step3: path.join(DIRS.screenshots, '05-campaign-found.png'),
  step4: path.join(DIRS.screenshots, '06-campaign-opened.png'),
  step5: path.join(DIRS.screenshots, '07-create-button-clicked.png'),
  step6: path.join(DIRS.screenshots, '08-adset-flow-opened.png'),
  success: path.join(DIRS.screenshots, '09-adset-name-filled.png'),
  error: path.join(DIRS.screenshots, 'error.png'),
};

function updateRunContext(patch) {
  Object.assign(runContext, patch);
}

function currentPerfItem(fallback = '') {
  return fallback || runContext.current_ad_name || runContext.current_video_file || runContext.current_adset_name || runContext.campaign_name || '';
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function startPerfStep(step, item = '') {
  const entry = {
    step,
    item: currentPerfItem(item),
    campaign_mode: CAMPAIGN_MODE,
    campaign_name: runContext.campaign_name || CAMPAIGN_NAME || '',
    adset: runContext.current_adset_name || '',
    started_at: new Date().toISOString(),
    started_ms: Date.now(),
    status: 'running',
  };
  console.log(`[PERF] [${entry.item || '-'}] ${step} started`);
  return (status = 'success', extra = {}) => {
    entry.ended_at = new Date().toISOString();
    entry.duration_ms = Date.now() - entry.started_ms;
    entry.duration_sec = Number((entry.duration_ms / 1000).toFixed(3));
    entry.status = status;
    Object.assign(entry, extra);
    performanceEntries.push(entry);
    console.log(`[PERF] [${entry.item || '-'}] ${step} ${status === 'success' ? 'done' : 'failed'} - ${formatDuration(entry.duration_ms)}`);
    return entry;
  };
}

async function timedStep(step, item, fn) {
  const endPerf = startPerfStep(step, item);
  try {
    const result = await fn();
    endPerf('success');
    return result;
  } catch (error) {
    endPerf('failed', { error: error.message });
    throw error;
  }
}

function getWaitTimeoutLocation() {
  const stack = new Error().stack || '';
  const line = stack
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.includes('open-campaign.js') && !value.includes('getWaitTimeoutLocation') && !value.includes('page.waitForTimeout'));
  return line || '';
}

function classifyWaitTimeout(ms, location = '', nearby = '') {
  const text = `${location} ${nearby}`.toLowerCase();
  if (text.includes('video') || text.includes('upload') || text.includes('media') || ms >= 30000) return 'video_only';
  if (text.includes('locator') || text.includes('button') || text.includes('input') || text.includes('visible') || text.includes('search')) return 'replace_with_locator_wait';
  if (ms <= 700) return 'removable';
  return 'needed';
}

function installWaitForTimeoutProfiler(page) {
  if (page.__metaWaitProfilerInstalled) return;
  const originalWaitForTimeout = page.waitForTimeout.bind(page);
  page.waitForTimeout = async (ms, ...args) => {
    const location = getWaitTimeoutLocation();
    const entry = {
      ms,
      sec: Number((ms / 1000).toFixed(3)),
      classification: classifyWaitTimeout(ms, location),
      location,
      current_step: runContext.current_step,
      item: currentPerfItem(),
      campaign_mode: CAMPAIGN_MODE,
      at: new Date().toISOString(),
    };
    waitTimeoutEntries.push(entry);
    return originalWaitForTimeout(ms, ...args);
  };
  page.__metaWaitProfilerInstalled = true;
}

function getPlanAdsetCount() {
  if (activeCampaignPlan?.adsetCount) return activeCampaignPlan.adsetCount;
  return (isBlogCampaign() || isVideoOnlyCampaign() || isCboCampaign()) ? ADSET_COUNT + 1 : ADSET_COUNT;
}

function getPlanAdCount() {
  if (activeCampaignPlan?.totalAds) return activeCampaignPlan.totalAds;
  if (activeCampaignPlan?.adsets) return activeCampaignPlan.adsets.reduce((sum, adset) => sum + (adset.ads?.length || 0), 0);
  const adsets = getPlanAdsetCount();
  const adsPerAdset = activeCampaignPlan?.totalAdsPerAdset || AD_CREATIVE_COUNT + 1;
  return adsets * adsPerAdset;
}

function getEffectiveResumeAdName() {
  return String(runtimeResumeFromAdName || '').trim();
}

function getEffectiveResumeAdIndex() {
  return Number(runtimeResumeFromAdIndex || 1);
}

function getResumeAdCreativeStartIndex(plan = activeCampaignPlan) {
  const resumeAdName = getEffectiveResumeAdName();
  const resumeAdIndex = getEffectiveResumeAdIndex();
  if (!resumeAdName) {
    if (Number.isFinite(resumeAdIndex) && resumeAdIndex > 1) {
      return Math.floor(resumeAdIndex);
    }
    return 1;
  }
  const normalizedTarget = normalizeText(resumeAdName);
  const plannedAds = (plan?.adsets || []).flatMap((adset) => adset.ads || []);
  const plannedIndex = plannedAds.findIndex((ad) => normalizeText(ad.name || '') === normalizedTarget);
  if (plannedIndex >= 0) return plannedIndex + 1;
  const trailingIndex = resumeAdName.match(/_(\d+)$/)?.[1];
  if (trailingIndex) return Number(trailingIndex);
  if (Number.isFinite(resumeAdIndex) && resumeAdIndex > 1) {
    return Math.floor(resumeAdIndex);
  }
  return 1;
}

function isResumeModeEnabled() {
  return getResumeAdCreativeStartIndex() > 1;
}

function isRecoverableAutomationError(error) {
  const message = String(error?.message || error || '').replace(/\x1b\[[0-9;]*m/g, '');
  const currentStep = String(runContext.current_step || '');
  const hasResumePoint = Boolean(runContext.current_ad_name) && Number(runContext.current_ad_index) > 0;
  if (!hasResumePoint) return false;
  if (/validate_config|campaign_create|duplicate_adsets|duplicate_ads|fill_adset_budget|schedule_adset/i.test(currentStep)) return false;
  if (/requires exactly|must be|asset root does not exist|file not found|Video file not found|Image file not found|CAMPAIGN_NAME|안전 제한|검증/i.test(message)) {
    return false;
  }
  return /Timeout|timed out|찾지 못했습니다|Could not find|button not found|not visible|row not found|Resume target|upload completion|upload timeout|업로드|intercepts pointer events|Sequential adset\/ad rename failed|Next button|Done button|Continue button|다음|계속|완료|업로드/i.test(message);
}

function activateRuntimeResumeFromContext(error, attempt) {
  const resumeIndex = Number(runContext.current_ad_index || 1);
  const resumeName = String(runContext.current_ad_name || '').trim();
  if (!resumeName || !Number.isFinite(resumeIndex) || resumeIndex < 1) return false;
  const previousStep = runContext.current_step;

  runtimeResumeFromAdIndex = resumeIndex;
  runtimeResumeFromAdName = resumeName;
  updateRunContext({
    current_step: 'auto_resume_prepare',
    auto_resume_attempt: attempt,
    auto_resume_from_ad_index: resumeIndex,
    auto_resume_from_ad_name: resumeName,
    last_recoverable_error: String(error?.message || error || '').slice(0, 1000),
  });
  console.log('[AUTO-RESUME] recoverable error detected - will resume from current ad:', {
    attempt,
    resumeIndex,
    resumeName,
    previousStep,
    error: error?.message || String(error),
  });
  return true;
}

function getPlanAdsetForCreativeIndex(creativeIndex, plan = activeCampaignPlan) {
  if (!plan?.adsets?.length || !plan?.totalAdsPerAdset) return null;
  const adsetOffset = Math.floor((creativeIndex - 1) / plan.totalAdsPerAdset);
  return plan.adsets[adsetOffset] || null;
}

function getModeWaitMs() {
  return WAIT_CONFIG.modeOverrides[CAMPAIGN_MODE] || WAIT_CONFIG.baseRetryIntervalMs;
}

function getCreativeStabilizeWaitMs(adFormat = AD_FORMAT) {
  const modeWait = getModeWaitMs();
  return adFormat === 'video'
    ? Math.max(modeWait, 10_000)
    : Math.min(Math.max(modeWait, 2_000), 5_000);
}

function getMediaPreUploadWaitMs(adFormat = AD_FORMAT) {
  const modeWait = getModeWaitMs();
  return adFormat === 'video'
    ? Math.max(modeWait, 12_000)
    : Math.min(Math.max(modeWait, 2_000), 4_000);
}

function getMediaPostUploadWaitMs(adFormat = AD_FORMAT) {
  const modeWait = getModeWaitMs();
  return adFormat === 'video'
    ? Math.max(modeWait, 12_000)
    : Math.min(Math.max(modeWait, 3_000), 5_000);
}

function buildNotificationDetail(extra = {}) {
  const merged = { ...runContext, ...extra };
  const lines = [
    merged.campaign_mode ? `Mode: ${merged.campaign_mode}` : '',
    merged.campaign_name ? `Campaign: ${merged.campaign_name}` : '',
    merged.current_step ? `Step: ${merged.current_step}` : '',
    merged.current_adset_name ? `Adset: ${merged.current_adset_name}` : '',
    merged.current_ad_name ? `Ad: ${merged.current_ad_name}` : '',
    merged.current_landing_url ? `Landing URL: ${merged.current_landing_url}` : '',
    merged.current_video_file ? `Video: ${merged.current_video_file}` : '',
    merged.last_screenshot ? `Screenshot: ${merged.last_screenshot}` : '',
    merged.error_message ? `Error: ${merged.error_message}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function summarizeErrorReason(error) {
  const raw = String(error?.message || error || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const firstMeaningfulLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^Call log:?$/i.test(line) && !/^- /.test(line));
  return firstMeaningfulLine || '자세한 내용은 터미널 로그를 확인해 주세요.';
}

async function safeScreenshot(page, screenshotPath, label, options = {}) {
  if (!ENABLE_SCREENSHOTS) {
    console.log('[STEP] screenshot disabled:', { label, path: screenshotPath });
    return false;
  }
  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: options.fullPage ?? true,
      timeout: options.timeout ?? 15000,
    });
    updateRunContext({ last_screenshot: screenshotPath });
    return true;
  } catch (error) {
    console.warn('[WARN] screenshot skipped:', { label, path: screenshotPath, error: error.message });
    if (options.fallbackViewport !== false) {
      try {
        await page.screenshot({
          path: screenshotPath,
          fullPage: false,
          timeout: 8000,
        });
        updateRunContext({ last_screenshot: screenshotPath });
        console.log('[STEP] viewport screenshot fallback saved:', { label, path: screenshotPath });
        return true;
      } catch (fallbackError) {
        console.warn('[WARN] viewport screenshot fallback skipped:', {
          label,
          path: screenshotPath,
          error: fallbackError.message,
        });
      }
    }
    return false;
  }
}

async function writeRunSummaryLog(status, error = null) {
  runContext.ended_at = new Date().toISOString();
  await fs.mkdir(path.resolve('logs'), { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.resolve('logs', `run-summary-${timestamp}.json`);
  const payload = {
    status,
    context: runContext,
    error: error ? {
      message: error.message,
      stack: error.stack,
      name: error.name,
    } : null,
  };
  await fs.writeFile(logPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await fs.writeFile(path.resolve('logs', 'latest-run-summary.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log('[LOG] run summary saved:', logPath);
  return logPath;
}

function summarizeStepStats(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const current = grouped.get(entry.step) || {
      step: entry.step,
      count: 0,
      success_count: 0,
      failed_count: 0,
      total_ms: 0,
      max_ms: 0,
      max_item: '',
    };
    current.count += 1;
    current.success_count += entry.status === 'success' ? 1 : 0;
    current.failed_count += entry.status === 'failed' ? 1 : 0;
    current.total_ms += entry.duration_ms || 0;
    if ((entry.duration_ms || 0) > current.max_ms) {
      current.max_ms = entry.duration_ms || 0;
      current.max_item = entry.item || '';
    }
    grouped.set(entry.step, current);
  }
  return [...grouped.values()]
    .map((item) => ({
      ...item,
      avg_ms: Math.round(item.total_ms / Math.max(item.count, 1)),
      avg_sec: Number((item.total_ms / Math.max(item.count, 1) / 1000).toFixed(3)),
      max_sec: Number((item.max_ms / 1000).toFixed(3)),
    }))
    .sort((a, b) => b.avg_ms - a.avg_ms);
}

function summarizeSlowItems(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry.item) continue;
    const current = grouped.get(entry.item) || { item: entry.item, total_ms: 0, steps: 0, failed_steps: 0 };
    current.total_ms += entry.duration_ms || 0;
    current.steps += 1;
    current.failed_steps += entry.status === 'failed' ? 1 : 0;
    grouped.set(entry.item, current);
  }
  return [...grouped.values()]
    .map((item) => ({ ...item, total_sec: Number((item.total_ms / 1000).toFixed(3)) }))
    .sort((a, b) => b.total_ms - a.total_ms)
    .slice(0, 5);
}

async function collectWaitForTimeoutAudit() {
  const sourcePath = new URL(import.meta.url);
  const source = await fs.readFile(sourcePath, 'utf-8').catch(() => '');
  const lines = source.split(/\r?\n/);
  const audit = [];
  let currentFunction = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fnMatch = line.match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)/) || line.match(/^async\s+function\s+([A-Za-z0-9_]+)/);
    if (fnMatch) currentFunction = fnMatch[1];
    if (!/\bawait\s+page\.waitForTimeout\s*\(/.test(line)) continue;
    const nearby = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join(' ');
    const msMatch = line.match(/waitForTimeout\(([^)]+)\)/);
    const waitExpression = msMatch?.[1]?.trim() || '';
    audit.push({
      file: 'src/open-campaign.js',
      line: index + 1,
      function: currentFunction,
      wait_expression: waitExpression,
      classification: classifyWaitTimeout(Number(waitExpression) || 0, currentFunction, nearby),
      code: line.trim(),
    });
  }
  return audit;
}

async function writePerformanceReport(status, tracePath = '', error = null) {
  await fs.mkdir(path.resolve('logs'), { recursive: true });
  const reportPath = path.resolve('logs', 'performance_report.json');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const historyPath = path.resolve('logs', `performance-report-${timestamp}.json`);
  const staticWaitAudit = await collectWaitForTimeoutAudit();
  const slowestSteps = [...performanceEntries]
    .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0))
    .slice(0, 5);
  const unnecessaryFixedWaits = staticWaitAudit.filter((item) => ['removable', 'replace_with_locator_wait'].includes(item.classification));
  const payload = {
    status,
    generated_at: new Date().toISOString(),
    campaign_mode: CAMPAIGN_MODE,
    campaign_name: runContext.campaign_name || CAMPAIGN_NAME || '',
    trace_path: tracePath,
    error: error ? { message: error.message, name: error.name } : null,
    step_summary: summarizeStepStats(performanceEntries),
    slowest_items_top5: summarizeSlowItems(performanceEntries),
    slowest_steps_top5: slowestSteps,
    fixed_wait_runtime: waitTimeoutEntries,
    wait_for_timeout_audit: staticWaitAudit,
    unnecessary_fixed_waits: unnecessaryFixedWaits,
    suggestions: [
      'Start with unnecessary_fixed_waits items classified as replace_with_locator_wait.',
      'Keep waits after video upload and Meta save conservative until traces prove they are safe to reduce.',
      'Optimize steps that repeatedly appear in slowest_steps_top5 first.',
      'Open trace_path in Playwright Trace Viewer to inspect the exact slow action.',
    ],
  };
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await fs.writeFile(historyPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log('[LOG] performance report saved:', reportPath);
  return reportPath;
}

function validateEnv() {
  if (!DRY_RUN && !AD_ACCOUNT_ID) throw new Error('AD_ACCOUNT_ID is missing in .env');
  if (!CAMPAIGN_NAME) throw new Error('CAMPAIGN_NAME is missing in .env');
  if (!Number.isFinite(ADSET_START_INDEX)) throw new Error('ADSET_START_INDEX must be a number');
  if (!Number.isFinite(ADSET_COUNT) || ADSET_COUNT < 0) throw new Error('ADSET_COUNT must be >= 0');
  const minCreativeCount = (isCboCampaign() || isBlogVideoCampaign()) ? 0 : 1;
  if (!Number.isFinite(AD_CREATIVE_COUNT) || AD_CREATIVE_COUNT < minCreativeCount) {
    throw new Error(`AD_CREATIVE_COUNT must be >= ${minCreativeCount}`);
  }
  if (ADSET_DAILY_BUDGET && !/^\d+(\.\d+)?$/.test(ADSET_DAILY_BUDGET)) throw new Error('ADSET_DAILY_BUDGET must be a number');
  if (isCboCampaign()) formatBudgetForMetaInput(process.env.CAMPAIGN_BUDGET || '');
}

function isBlogMixedCampaign() {
  return CAMPAIGN_MODE === CAMPAIGN_MODES.BLOG_MIXED;
}

function isBlogVideoCampaign() {
  return [CAMPAIGN_MODES.BLOG_VIDEO, CAMPAIGN_MODES.BLOG_VIDEO_DIRECT].includes(CAMPAIGN_MODE);
}

function isBlogCampaign() {
  return isBlogMixedCampaign() || isBlogVideoCampaign();
}

function isVideoOnlyCampaign() {
  return CAMPAIGN_MODE === CAMPAIGN_MODES.VIDEO_ONLY;
}

function isVideoOnlyCboCampaign() {
  return CAMPAIGN_MODE === CAMPAIGN_MODES.VIDEO_ONLY_CBO;
}

function isImageOnlyCboCampaign() {
  return CAMPAIGN_MODE === CAMPAIGN_MODES.IMAGE_ONLY_CBO;
}

function isCboCampaign() {
  return isVideoOnlyCboCampaign() || isImageOnlyCboCampaign();
}

function normalizeText(value) {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeAdFormat(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['video', 'movie', '동영상', '영상'].includes(normalized)) return 'video';
  if ([CAMPAIGN_MODES.BLOG_VIDEO, CAMPAIGN_MODES.BLOG_VIDEO_DIRECT, CAMPAIGN_MODES.VIDEO_ONLY, CAMPAIGN_MODES.VIDEO_ONLY_CBO].includes(normalizeCampaignMode(process.env.CAMPAIGN_MODE))) return 'video';
  return 'image';
}

function getCreativeFormatLabel(format = AD_FORMAT) {
  return format === 'video' ? '동영상 광고' : '이미지 광고';
}

function getCreativeFormatPattern(format = AD_FORMAT) {
  return format === 'video' ? /동영상\s*광고/ : /이미지\s*광고/;
}

function campaignPatternFromInput(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\s+/g, '\\s*'), 'i');
}

function getTodayMMDD() {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function getAdName(index) {
  return `f_i_o_l_${getTodayMMDD()}_${index}`;
}

function getLandingCampaignName(adName) {
  return String(adName).replace(/_(\d+)$/, (_, index) => `_${Number(index)}`);
}

function getLandingPathNumber() {
  const value = String(process.env.LANDING_PATH_NUMBER || process.env.REPURELY_PATH_NUMBER || '100').trim();
  return /^\d+$/.test(value) ? value : '100';
}

function buildRepurelyLandingUrl(adName) {
  const baseUrl = String(process.env.REPURELY_BASE_URL || 'https://repurely.com/surl/P').replace(/\/$/, '');
  return `${baseUrl}/${getLandingPathNumber()}?utm_source=f&utm_medium=f&utm_campaign=${getLandingCampaignName(adName)}`;
}

function parseScheduleTime(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 5, minute: 0 };
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));
  return { hour, minute };
}

function getAdsetName(index) {
  return `${getTodayMMDD()} ${ADSET_BASE_NAME} ${index}번 광고세트`;
}

function parseAdsetIndexFromDisplayName(text, creativeCountPerAdset = 1) {
  const value = normalizeText(text || '');
  const directPatterns = [
    /\d{4}\s+리타겟\s+(\d+)\s*번\s+광고\s*세트/i,
    /\d{4}\s+직접세팅\s+광고\s*세트\s*-\s*(\d+)/i,
    /\d{4}\s+CBO\s+광고\s*세트\s*-\s*(\d+)/i,
    /(^|\D)(\d+)\s*번\s*(?:블로그|광고|세트|광고세트)/i,
  ];

  for (const pattern of directPatterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const parsed = Number(match[2] || match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const seriesMatch = value.match(/f_[iv]_b?_?o_l_\d{4}_(\d+)/i);
  if (seriesMatch) {
    const firstAdIndex = Number(seriesMatch[1]);
    const count = Math.max(1, Number(creativeCountPerAdset || 1));
    if (Number.isFinite(firstAdIndex) && firstAdIndex > 0) {
      return Math.floor((firstAdIndex - 1) / count) + 1;
    }
  }

  return null;
}

async function ensureDirs() {
  await fs.mkdir(DIRS.screenshots, { recursive: true });
  await fs.mkdir(path.resolve('logs'), { recursive: true });
}


async function pause(page, label, ms = 2000) {
  console.log(`[PAUSE] ${label} - ${ms}ms`);
  const endPerf = startPerfStep(`fixed_wait:${label}`, currentPerfItem());
  await page.waitForTimeout(ms);
  endPerf('success', { wait_ms: ms });
}

async function hasLargeUploadFile(files, limitBytes = 50 * 1024 * 1024) {
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.size > limitBytes) return true;
  }
  return false;
}

function waitForCDPEvent(client, eventName, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.off(eventName, handler);
      resolve(null);
    }, timeoutMs);

    function handler(params) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off(eventName, handler);
      resolve(params);
    }

    client.on(eventName, handler);
  });
}

async function setFilesViaCDP(page, files) {
  const client = await page.context().newCDPSession(page);
  const startedAt = Date.now();
  let result = null;

  while (Date.now() - startedAt < 30000 && !result?.objectId) {
    const response = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const findInput = (root) => {
          const inputs = Array.from(root.querySelectorAll('input[type="file"]'));
          const enabled = inputs.find((input) => !input.disabled) || inputs[0];
          if (enabled) return enabled;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              const nested = findInput(el.shadowRoot);
              if (nested) return nested;
            }
          }
          return null;
        };
        return findInput(document);
      })()`,
      returnByValue: false,
    });
    result = response.result;
    if (!result?.objectId) await page.waitForTimeout(500);
  }

  if (!result?.objectId) {
    throw new Error('file input object not found for CDP upload fallback');
  }

  await client.send('DOM.setFileInputFiles', {
    objectId: result.objectId,
    files,
  });
}

async function uploadFilesViaInterceptedChooser(page, files, triggerUploadClick) {
  const client = await page.context().newCDPSession(page);
  await client.send('Page.enable').catch(() => null);
  await client.send('DOM.enable').catch(() => null);
  await client.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => null);

  const chooserEventPromise = waitForCDPEvent(client, 'Page.fileChooserOpened', 30000);
  await triggerUploadClick();

  const chooserEvent = await chooserEventPromise;
  await client.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => null);

  if (chooserEvent?.backendNodeId) {
    await client.send('DOM.setFileInputFiles', {
      backendNodeId: chooserEvent.backendNodeId,
      files,
    });
    return;
  }

  await setFilesViaCDP(page, files);
}

async function uploadFilesToCurrentPicker(page, fileChooser, files, adFormat) {
  const largeUpload = await hasLargeUploadFile(files);
  const useCdpUpload = adFormat === 'video' || largeUpload;

  if (useCdpUpload) {
    console.log('[STEP] large/video upload detected - using CDP local file path upload:', {
      adFormat,
      largeUpload,
      files,
    });
    await setFilesViaCDP(page, files);
    return;
  }

  if (fileChooser) {
    await fileChooser.setFiles(files);
    return;
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ timeout: 30000 });
  await fileInput.setInputFiles(files);
}

async function debugDump(page, reason) {
  const placeholders = await page.locator('input[placeholder]').evaluateAll((els) => els.map((el) => el.getAttribute('placeholder') || '')).catch(() => []);
  const inputValues = await page.locator('input').evaluateAll((els) => els.map((el) => el.value || '')).catch(() => []);
  const buttonTexts = await page.locator('button, [role="button"], div').evaluateAll((els) => els.map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 50)).catch(() => []);
  const inputCount = await page.locator('input').count().catch(() => 0);
  const bodyText = await page.locator('body').innerText().catch(() => '');

  console.log(`[DEBUG] ${reason} URL:`, page.url());
  console.log(`[DEBUG] ${reason} TITLE:`, await page.title());
  console.log(`[DEBUG] ${reason} input count:`, inputCount);
  console.log(`[DEBUG] ${reason} input placeholders:`, placeholders);
  console.log(`[DEBUG] ${reason} input values:`, inputValues);
  console.log(`[DEBUG] ${reason} button texts(sample):`, buttonTexts);
  console.log(`[DEBUG] ${reason} body text(1000):`, bodyText.slice(0, 1000));
}

async function ensureLoggedInOrThrow(page) {
  const currentUrl = page.url();
  if (/facebook\.com\/(login|checkpoint)/i.test(currentUrl)) {
    throw new Error('Meta login page was detected. Please log in to Meta in Chrome, then run the automation again.');
  }
}

async function ensureCampaignTab(page) {
  const campaignsUrl = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT_ID}`;
  const isCampaignsUrl = () => /\/adsmanager\/manage\/campaigns\b/i.test(page.url());

  if (isCampaignsUrl()) {
    console.log('[STEP] campaign tab confirmed');
    return true;
  }

  const clickCampaignNav = async (attempt) => {
    const exactCampaign = /^캠페인$/;
    const candidates = [
      { name: 'role link exact 캠페인', locator: page.getByRole('link', { name: exactCampaign }).first() },
      { name: 'role button exact 캠페인', locator: page.getByRole('button', { name: exactCampaign }).first() },
      { name: 'text exact 캠페인', locator: page.getByText(exactCampaign).first() },
      { name: 'role link exact Campaigns', locator: page.getByRole('link', { name: /^Campaigns$/i }).first() },
      { name: 'text exact Campaigns', locator: page.getByText(/^Campaigns$/i).first() },
    ];

    for (const candidate of candidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;
      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] campaign tab nav candidate:', { attempt, name: candidate.name, box });
      await candidate.locator.click({ timeout: 5000 }).catch(async () => {
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      return true;
    }
    return false;
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.warn('[WARN] campaign tab not active - forcing campaigns view:', { attempt, url: page.url() });
    const clicked = await clickCampaignNav(attempt);
    if (!clicked) {
      console.log('[STEP] campaign tab nav not found - reopening campaigns URL');
      await page.goto(campaignsUrl, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    await page.waitForURL(/\/adsmanager\/manage\/campaigns\b/i, { timeout: 5000 }).catch(() => null);
    if (isCampaignsUrl()) {
      console.log('[STEP] campaign tab forced successfully');
      return true;
    }
    await page.waitForTimeout(1000);
  }

  await page.goto(campaignsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/adsmanager\/manage\/campaigns\b/i, { timeout: 7000 }).catch(() => null);
  if (isCampaignsUrl()) {
    console.log('[STEP] campaign tab forced by URL');
    return true;
  }

  await debugDump(page, 'campaign tab force failed');
  throw new Error(`캠페인 탭 강제 진입 실패: current URL=${page.url()}`);
}

async function trySearchBox(page, keyword) {
  const searchInput = page
    .locator('input[type="text"], input[type="search"], textarea')
    .filter({ hasNot: page.locator('[type="checkbox"], [role="switch"]') })
    .filter({ hasNot: page.locator('[aria-label*="빠른 보기" i], [aria-label*="검색" i]') })
    .first();

  const visible = await searchInput.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) {
    console.log('[STEP] campaign search box not visible - searching directly from list');
    return false;
  }

  console.log('[STEP] campaign search box detected - entering search keyword');
  await searchInput.click();
  await searchInput.fill('');
  await searchInput.fill(keyword);
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(1000);
  return true;
}

async function logCampaignCandidates(page, limit = 10) {
  const rows = page.getByRole('row');
  const rowCount = await rows.count();
  const candidates = [];
  for (let i = 0; i < rowCount && candidates.length < limit; i += 1) {
    const text = (await rows.nth(i).innerText().catch(() => '')).trim();
    if (text.length >= 2) candidates.push(text.split('\n')[0].trim());
  }
  console.log('[DEBUG] visible campaign candidates (up to 10):');
  candidates.forEach((name, idx) => console.log(`  ${idx + 1}. ${name}`));
}

async function findCampaignTarget(page, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  const regex = campaignPatternFromInput(keyword);

  const tooltipMatch = page.locator('[data-tooltip-content]').filter({ hasText: regex }).first();
  if (await tooltipMatch.isVisible({ timeout: 5000 }).catch(() => false)) return tooltipMatch;

  const spanMatch = page.locator('span._3dfi._3dfj').filter({ hasText: regex }).first();
  if (await spanMatch.isVisible({ timeout: 5000 }).catch(() => false)) return spanMatch;

  const textMatch = page.getByText(regex).first();
  if (await textMatch.isVisible({ timeout: 5000 }).catch(() => false)) return textMatch;

  const rows = page.getByRole('row');
  const rowCount = await rows.count();
  for (let i = 0; i < rowCount; i += 1) {
    const text = await rows.nth(i).innerText().catch(() => '');
    if (normalizeText(text).includes(normalizedKeyword)) return rows.nth(i);
  }
  return null;
}

async function clickRealCreateButton(page) {
  if (isCboCampaign() && videoOnlyCboInitialCreateClicked) {
    console.log('[STEP] CBO initial create already clicked - skipping duplicate create click');
    return;
  }
  const timeoutMs = 10_000;
  const startedAt = Date.now();
  const exactText = /^만들기$/;
  const preferredCandidates = [
    { name: 'role button exact 만들기', locator: page.getByRole('button', { name: exactText }).first() },
    { name: 'text exact 만들기', locator: page.getByText(exactText).first() },
    {
      name: 'fallback class exact 만들기',
      locator: page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
        .filter({ hasText: exactText })
        .first(),
    },
  ];

  for (let attempt = 1; Date.now() - startedAt < timeoutMs; attempt += 1) {
    for (const candidate of preferredCandidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;
      const text = (await candidate.locator.innerText().catch(() => '')).trim();
      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] create campaign button candidate:', { attempt, name: candidate.name, text, box });
      if (text.includes('보기 만들기') || text !== '만들기' || !box) continue;
      await candidate.locator.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      console.log('[STEP] create button clicked');
      return;
    }

    const createCandidates = page.locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli');
    const count = await createCandidates.count();

    for (let i = 0; i < count; i += 1) {
      const candidate = createCandidates.nth(i);
      const text = (await candidate.innerText().catch(() => '')).trim();
      const box = await candidate.boundingBox().catch(() => null);
      console.log('[DEBUG] create button candidate:', { attempt, index: i, text, box });

      if (text !== '만들기') continue;
      if (text.includes('보기 만들기')) continue;
      if (!box) continue;

      if (box.x < 300 && box.y > 150 && box.y < 300) {
        await candidate.click();
        console.log('[STEP] create button clicked');
        return;
      }
    }

    console.log(`[WAIT] 좌측 상단 +만들기 버튼 검색 재시도 ${attempt}`);
    await page.waitForTimeout(500);
  }

  throw new Error('좌측 상단 실제 +만들기 버튼을 찾지 못했습니다.');
}

async function isAdsetCreateOpen(page) {
  const byPlaceholder = await page.locator('input[placeholder="광고 세트 이름 지정"], input[placeholder="여기에 광고 세트 이름을 입력하세요..."]').first().isVisible({ timeout: 1500 }).catch(() => false);
  if (byPlaceholder) return true;

  const textInputs = await page.locator('input[type="text"]').elementHandles();
  for (const input of textInputs) {
    const value = await input.getAttribute('value');
    if (value?.includes('리타겟') || value?.includes('광고세트') || value?.includes('광고 세트')) return true;
  }

  const hasContinue = await page.getByText(/^계속$/).first().isVisible({ timeout: 1200 }).catch(() => false);
  const hasCancel = await page.getByText(/^취소$/).first().isVisible({ timeout: 1200 }).catch(() => false);
  return hasContinue && hasCancel;
}

async function ensureAdsetCreateOpen(page) {
  const isOpen = await isAdsetCreateOpen(page);
  if (isOpen) {
    console.log('[STEP] 광고 세트 생성 화면 확인됨');
    return true;
  }

  console.log('[WARN] 광고 세트 생성 화면이 아님 - +만들기 재진입 시도');
  await clickRealCreateButton(page);
  await pause(page, '광고 세트 생성 재진입 대기', 3000);

  const reopened = await isAdsetCreateOpen(page);
  if (!reopened) {
    await safeScreenshot(page, path.join(DIRS.screenshots, 'adset-create-reopen-failed.png'), 'adset create reopen failed');
    await debugDump(page, 'adset create reopen failed');
    throw new Error('광고 세트 생성 화면 재진입 실패');
  }
  return true;
}

async function findVideoCboAdsetNameInputHandle(page, targetAdsetName) {
  const handle = await page.evaluateHandle(({ targetAdsetName, campaignName }) => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isBudgetLike = (value) => /^[\d,]+$/.test(normalize(value));
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')]
      .filter(visible)
      .map((input) => {
        const box = input.getBoundingClientRect();
        const value = input.value || input.getAttribute('value') || '';
        const placeholder = input.getAttribute('placeholder') || '';
        const ariaLabel = input.getAttribute('aria-label') || '';
        const ariaLabelledBy = input.getAttribute('aria-labelledby') || '';
        const labelText = ariaLabelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ');
        const allText = normalize(`${value} ${placeholder} ${ariaLabel} ${labelText}`);
        return { input, box, value, placeholder, ariaLabel, labelText, allText };
      })
      .filter((item) => {
        if (isBudgetLike(item.value)) return false;
        if (/캠페인/.test(item.allText)) return false;
        if (campaignName && normalize(item.value) === normalize(campaignName)) return false;
        return true;
      });

    const preferred = inputs.find((item) => /광고\s*세트\s*이름/.test(item.allText));
    if (preferred) return preferred.input;

    const defaultName = inputs.find((item) => /새\s*판매\s*광고\s*세트/.test(item.allText));
    if (defaultName) return defaultName.input;

    const exactTarget = inputs.find((item) => targetAdsetName && normalize(item.value) === normalize(targetAdsetName));
    if (exactTarget) return exactTarget.input;

    const rightPanelInput = inputs
      .filter((item) => item.box.left > window.innerWidth * 0.25)
      .sort((a, b) => a.box.top - b.box.top)[0];
    return rightPanelInput?.input || null;
  }, { targetAdsetName, campaignName: activeCampaignPlan?.campaignName || process.env.CAMPAIGN_NAME || '' }).catch(() => null);

  const input = handle?.asElement?.() || null;
  if (input) {
    const meta = await input.evaluate((el) => ({
      value: el.value || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      ariaLabelledBy: el.getAttribute('aria-labelledby') || '',
    })).catch(() => ({}));
    console.log('[DEBUG] VIDEO_ONLY_CBO adset name input candidate:', meta);
  }
  return input;
}

async function fillAdsetNameInAdsetModalOnly(page, adsetName) {
  if (isCboCampaign()) {
    await selectNewSalesAdsetRow(page);
  } else {
    await ensureAdsetCreateOpen(page);
  }
  await pause(page, '광고 세트명 입력 전 대기', 800);

  const broadLocator = page.locator(
    'input[placeholder="광고 세트 이름 지정"], input[placeholder="여기에 광고 세트 이름을 입력하세요..."], input._58al._aghb[type="text"], input[type="text"][value*="리타겟"], input[type="text"][value*="광고세트"], input[type="text"][value*="광고 세트"], input[data-auto-logging-id]'
  );

  const broadCount = await broadLocator.count();
  console.log('[DEBUG] adset input broad candidate count:', broadCount);

  let targetInputHandle = null;
  const deadline = Date.now() + 180000; // 최대 3분
  if (isCboCampaign()) {
    targetInputHandle = await findVideoCboAdsetNameInputHandle(page, adsetName);
  }

  while (Date.now() < deadline && !targetInputHandle) {
    if (isCboCampaign()) {
      await selectNewSalesAdsetRow(page);
      targetInputHandle = await findVideoCboAdsetNameInputHandle(page, adsetName);
      if (targetInputHandle) break;
      console.log('[WAIT] CBO adset name input search retry...');
      await page.waitForTimeout(1500);
      continue;
    }

    const directLocator = page.locator('input[placeholder="광고 세트 이름 지정"], input[placeholder="여기에 광고 세트 이름을 입력하세요..."], input._58al._aghb[type="text"]').first();
    if (await directLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      targetInputHandle = await directLocator.elementHandle();
      break;
    }

    const inputs = await page.locator('input[type="text"]').elementHandles();
    for (const input of inputs) {
      const value = await input.getAttribute('value');
      const placeholder = await input.getAttribute('placeholder');
      const className = await input.getAttribute('class');

      console.log('[DEBUG] input candidate:', { value, placeholder, className });

      if (
        placeholder === '광고 세트 이름 지정' ||
        placeholder === '여기에 광고 세트 이름을 입력하세요...' ||
        value?.includes('리타겟') ||
        value?.includes('광고세트') ||
        value?.includes('광고 세트') ||
        className?.includes('_58al')
      ) {
        targetInputHandle = input;
        break;
      }
    }

    if (!targetInputHandle) {
      console.log('[WAIT] 광고 세트 이름 input 검색 중... (재시도)');
      await page.waitForTimeout(2000);
    }
  }

  if (!targetInputHandle) {
    await debugDump(page, 'adsetNameInput not found after 3min');
    await safeScreenshot(page, path.join(DIRS.screenshots, 'adset-name-input-not-found.png'), 'adset name input not found');
    throw new Error('광고 세트 이름 input을 3분 안에 찾지 못했습니다.');
  }

  let valueCheck = await fastFillInputHandle(page, targetInputHandle, adsetName, 'initial adset name', {
    timeoutMs: 2500,
    typeDelay: 15,
  });
  let actualValue = valueCheck.actual;
  console.log('[DEBUG] actual adset input value:', actualValue);

  if (!valueCheck.ok) {
    console.log('[DEBUG] keyboard.type 미반영 - DOM value fallback 적용');
    await targetInputHandle.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, adsetName);

    valueCheck = await waitForInputHandleValue(targetInputHandle, adsetName, 3000);
    actualValue = valueCheck.actual;
    console.log('[DEBUG] actual adset input value after fallback:', actualValue);
  }

  if (!actualValue.trim().includes(adsetName)) {
    await debugDump(page, 'adsetNameInput fill mismatch');
    throw new Error(`광고 세트명 입력 실패: expected=${adsetName}, actual=${actualValue}`);
  }

  await pause(page, '광고 세트명 입력 후 대기', 1500);
  if (!isCboCampaign()) {
    await clickContinueButtonOnly(page);
    await safeScreenshot(page, path.join(DIRS.screenshots, '08-adset-name-and-continue.png'), 'adset name and continue');
  } else {
    await safeScreenshot(page, path.join(DIRS.screenshots, '08-cbo-adset-name-filled.png'), 'cbo adset name filled');
  }

}


async function updateDateAndTimeBeforeContinue(page) {
  await pause(page, '날짜/시간 영역 이동 전 대기', 3000);
  await page.mouse.wheel(0, 500);
  await pause(page, '스크롤 후 날짜/시간 영역 대기', 3000);

  let dateInput = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const candidate = page.locator('input[placeholder="yyyy-mm-dd"]').first();
    const visible = await candidate.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      dateInput = candidate;
      break;
    }
    console.log(`[WAIT] 날짜 input 검색 재시도 ${attempt}/10`);
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(2000);
  }

  if (!dateInput) {
    console.log('[DEBUG] 날짜 input 미감지 - 스케줄링 단계 미확정');
    await debugDump(page, 'schedule input not found');
    return false;
  }

  const currentDateText = await dateInput.inputValue().catch(() => '');
  console.log('[DEBUG] current date value:', currentDateText);

  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const nextDateText = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  console.log('[DEBUG] schedule date target (today+1):', nextDateText);

  await dateInput.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(nextDateText, { delay: 50 });
  await page.waitForTimeout(2000);
  console.log('[DEBUG] updated date value:', await dateInput.inputValue().catch(() => ''));
  await pause(page, '날짜 변경 반영 대기', 2000);

  const { hour, minute } = parseScheduleTime(SCHEDULE_TIME);
  const targetTimeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const hourSpin = page.locator('input[role="spinbutton"][aria-label*="시간"], input[role="spinbutton"][aria-label*="hour" i]').first();
  const minuteSpin = page.locator('input[role="spinbutton"][aria-label*="분"], input[role="spinbutton"][aria-label*="minute" i]').first();

  const hourVisible = await hourSpin.isVisible({ timeout: 5000 }).catch(() => false);
  if (hourVisible) {
    await hourSpin.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(String(hour), { delay: 80 });
    await page.waitForTimeout(700);

    await hourSpin.evaluate((el, hourVal) => {
      el.setAttribute('aria-valuenow', String(hourVal));
      el.setAttribute('aria-valuemin', '0');
      if ('value' in el) el.value = String(hourVal);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, hour);
  }

  const minuteVisible = await minuteSpin.isVisible({ timeout: 3000 }).catch(() => false);
  if (minuteVisible) {
    await minuteSpin.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(String(minute).padStart(2, '0'), { delay: 80 });
    await page.waitForTimeout(700);
    await minuteSpin.evaluate((el, minuteVal) => {
      el.setAttribute('aria-valuenow', String(minuteVal));
      el.setAttribute('aria-valuemin', '0');
      if ('value' in el) el.value = String(minuteVal).padStart(2, '0');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, minute);
  }

  if (!hourVisible) {
    // fallback: generic time-like input
    const timeInputs = await page.locator('input').elementHandles();
    for (const input of timeInputs) {
      const value = await input.getAttribute('value');
      const placeholder = await input.getAttribute('placeholder');
      const ariaLabel = await input.getAttribute('aria-label');

      console.log('[DEBUG] time input candidate:', { value, placeholder, ariaLabel });
      if (value?.includes(':') || placeholder?.includes('시간') || ariaLabel?.includes('시간') || ariaLabel?.toLowerCase().includes('hour')) {
        await input.click();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(targetTimeText, { delay: 50 });
        await page.waitForTimeout(1500);
        break;
      }
    }
  }

  console.log('[DEBUG] schedule target time applied:', targetTimeText);

  return true;
}

async function fillInputHandle(page, inputHandle, value, label) {
  await inputHandle.asElement().click();
  await page.waitForTimeout(300);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value, { delay: 50 });
  await page.waitForTimeout(800);

  let actualValue = await inputHandle.evaluate((el) => el.value || '').catch(() => '');
  if (actualValue !== value) {
    await inputHandle.evaluate((el, nextValue) => {
      el.focus();
      el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(800);
    actualValue = await inputHandle.evaluate((el) => el.value || '').catch(() => '');
  }

  console.log(`[DEBUG] ${label} input value:`, { expected: value, actual: actualValue });
  return actualValue === value;
}

async function waitForInputHandleValue(inputHandle, expectedValue, timeoutMs = 3000) {
  const startedAt = Date.now();
  const expected = String(expectedValue || '');
  let actual = '';
  while (Date.now() - startedAt < timeoutMs) {
    actual = await inputHandle.evaluate((el) => el.value || '').catch(() => '');
    if (actual === expected || normalizeText(actual).includes(normalizeText(expected))) {
      return { ok: true, actual };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return { ok: false, actual };
}

async function fastFillInputHandle(page, inputHandle, value, label = 'input', options = {}) {
  const expected = String(value || '');
  const verify = options.verify || 'includes';
  const timeoutMs = Number(options.timeoutMs || 2500);
  const element = typeof inputHandle?.asElement === 'function' ? inputHandle.asElement() : inputHandle;
  const isMatch = (actual) => verify === 'exact'
    ? String(actual || '') === expected
    : normalizeText(actual || '').includes(normalizeText(expected));
  const readActual = async () => element.evaluate((el) => el.value || '').catch(() => '');

  await element.click({ force: true }).catch(async () => {
    await element.scrollIntoViewIfNeeded().catch(() => null);
    await element.click({ force: true });
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
  await page.keyboard.press('Backspace').catch(() => null);

  const fillStartedAt = Date.now();
  try {
    if (typeof element.fill === 'function') {
      await element.fill(expected, { timeout: 5000 });
    } else {
      await page.keyboard.insertText(expected);
    }
  } catch (error) {
    console.log(`[WARN] ${label} fast fill failed - trying insertText:`, error.message);
    await page.keyboard.insertText(expected).catch(() => null);
  }

  let actual = '';
  const verifyStartedAt = Date.now();
  while (Date.now() - verifyStartedAt < timeoutMs) {
    actual = await readActual();
    if (isMatch(actual)) {
      console.log(`[DEBUG] ${label} fast fill ok:`, {
        method: 'fill/insertText',
        elapsedMs: Date.now() - fillStartedAt,
      });
      return { ok: true, actual, method: 'fill/insertText' };
    }
    await page.waitForTimeout(100);
  }

  console.log(`[DEBUG] ${label} fast fill mismatch - applying native value fallback:`, { expected, actual });
  await element.evaluate((el, nextValue) => {
    el.focus();
    const prototype = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, expected).catch(async () => {
    await element.evaluate((el, nextValue) => {
      el.focus();
      el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, expected);
  });
  await page.waitForTimeout(700);
  actual = await readActual();
  if (isMatch(actual)) {
    console.log(`[DEBUG] ${label} native value fallback ok`);
    return { ok: true, actual, method: 'native-value' };
  }

  console.log(`[WARN] ${label} native fallback mismatch - using keyboard.type fallback:`, { expected, actual });
  await element.click({ force: true }).catch(() => null);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
  await page.keyboard.press('Backspace').catch(() => null);
  await page.keyboard.type(expected, { delay: Number(options.typeDelay || 10) });
  await page.waitForTimeout(800);
  actual = await readActual();
  return { ok: isMatch(actual), actual, method: 'keyboard.type' };
}

async function fillCurrencyInputHandle(page, inputHandle, formattedValue, label) {
  const rawDigits = String(formattedValue || '').replace(/[^\d]/g, '');
  const attempts = [rawDigits, formattedValue].filter(Boolean);
  let actualValue = '';

  for (const attemptValue of attempts) {
    await inputHandle.asElement().click();
    await page.waitForTimeout(2500);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(attemptValue, { delay: 60 });
    await page.keyboard.press('Tab').catch(() => null);
    await page.waitForTimeout(1800);

    actualValue = await inputHandle.evaluate((el) => el.value || '').catch(() => '');
    console.log(`[DEBUG] ${label} currency input value:`, {
      attempted: attemptValue,
      expected: formattedValue,
      actual: actualValue,
    });
    if (actualValue === formattedValue || actualValue.replace(/[^\d]/g, '') === rawDigits) {
      return { ok: true, actual: actualValue };
    }
  }

  return { ok: false, actual: actualValue };
}

async function findBudgetInputHandle(page) {
  const placeholderInput = page.locator('input[placeholder="금액을 입력하세요"], input[placeholder*="금액"]').first();
  if (await placeholderInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    return placeholderInput.elementHandle();
  }

  const labelledInput = page.locator('input[aria-labelledby="js_dte js_dtr"]').first();
  if (await labelledInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    return labelledInput.elementHandle();
  }

  const inputs = await page.locator('input').elementHandles();
  for (const input of inputs) {
    const placeholder = await input.getAttribute('placeholder').catch(() => '');
    const ariaLabelledBy = await input.getAttribute('aria-labelledby').catch(() => '');
    const value = await input.getAttribute('value').catch(() => '');
    console.log('[DEBUG] budget input candidate:', { placeholder, ariaLabelledBy, value });

    if (placeholder === '금액을 입력하세요' || placeholder?.includes('금액') || ariaLabelledBy === 'js_dte js_dtr') {
      return input;
    }
  }

  return null;
}

async function fillAdsetDailyBudgetAfterSchedule(page) {
  if (isCboCampaign()) {
    console.log('[STEP] CBO mode - adset daily budget skipped; campaign budget is used');
    return true;
  }
  if (!ADSET_DAILY_BUDGET) {
    console.log('[STEP] ADSET_DAILY_BUDGET empty - budget input skipped');
    return true;
  }

  await pause(page, 'schedule applied before budget input', 3000);

  const budgetStrategyLabel = page
    .locator('span.x1vvvo52.x1fvot60.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.x117nqv4.xeuugli')
    .filter({ hasText: /예산\s*전략/ })
    .first()
    .or(page.getByText(/예산\s*전략/).first());

  const budgetStrategyVisible = await budgetStrategyLabel.isVisible({ timeout: 3000 }).catch(() => false);
  console.log('[DEBUG] budget strategy label visible:', budgetStrategyVisible);

  const budgetInputHandle = await findBudgetInputHandle(page);
  if (!budgetInputHandle) {
    console.log('[WARN] ADSET_DAILY_BUDGET input not found after schedule step - budget input skipped');
    return true;
  }

  const formattedBudget = formatBudgetForMetaInput(ADSET_DAILY_BUDGET);
  const filled = await fillCurrencyInputHandle(page, budgetInputHandle, formattedBudget, 'daily budget');
  if (!filled.ok) {
    await debugDump(page, 'daily budget input fill mismatch');
    throw new Error(`ADSET_DAILY_BUDGET fill failed: expected=${formattedBudget}, actual=${filled.actual}`);
  }

  await pause(page, 'daily budget input applied', 2000);
  return true;
}




async function ensureCampaignStructureRoot(page) {
  console.log('[STEP] campaign structure tree 검색');

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const visible = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };
      const root = document.querySelector('#campaign_structure_tree_root');
      if (isVisible(root)) return { ok: true, source: 'campaign_structure_tree_root' };
      const editorTree = [...document.querySelectorAll('[data-surface*="editor_tree"], [id^="ads_campaign_structure_item_"], [role="rowheader"][aria-label*="광고"], [role="row"]')]
        .find((el) => isVisible(el) && /광고|campaign|adset|adgroup|f_[iv]_/i.test(el.textContent || el.getAttribute('aria-label') || ''));
      if (editorTree) {
        return {
          ok: true,
          source: editorTree.id || editorTree.getAttribute('data-surface') || editorTree.getAttribute('aria-label') || editorTree.getAttribute('role') || 'tree-row-fallback',
        };
      }
      return { ok: false, source: '' };
    }).catch(() => ({ ok: false, source: '' }));

    console.log(`[DEBUG] campaign structure visible attempt ${attempt}/12:`, visible);
    if (visible.ok) {
      await pause(page, 'campaign structure 확인 후 안정화 대기', attempt <= 2 ? 1500 : 3000);
      return true;
    }

    const openButton = page.getByText(/^열기$/).first();
    const openVisible = await openButton.isVisible({ timeout: 1000 }).catch(() => false);
    if (openVisible) {
      console.log('[STEP] campaign structure 열기 버튼 클릭 시도');
      await openButton.click({ force: true }).catch(() => null);
    }
    await page.waitForTimeout(attempt <= 4 ? 2000 : 4000);
  }

  await debugDump(page, 'campaign structure tree not found');
  throw new Error('Could not find campaign structure tree.');
}

async function scrollCampaignStructureTree(page, deltaY = 700) {
  const scrolled = await page.evaluate((amount) => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    };
    const rows = [...document.querySelectorAll('[data-surface*="editor_tree"], [id^="ads_campaign_structure_item_"], [role="rowheader"][aria-label*="광고"], [role="row"]')]
      .filter(isVisible);
    const seed = rows[0] || document.querySelector('#campaign_structure_tree_root');
    let node = seed;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 20) {
        node.scrollTop += amount;
        return {
          ok: true,
          tag: node.tagName,
          id: node.id || '',
          className: String(node.className || '').slice(0, 120),
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        };
      }
      node = node.parentElement;
    }
    window.scrollBy(0, amount);
    return { ok: false, tag: 'window' };
  }, deltaY).catch((error) => ({ ok: false, error: error.message }));
  console.log('[DEBUG] campaign structure tree scroll:', scrolled);
  return scrolled;
}

async function openCorrectAdActionMenu(page, adsetName) {
  console.log('[STEP] row 기준 작업 메뉴 검색');

  await ensureCampaignStructureRoot(page);
  await page.waitForTimeout(500);

  const fastMenuBox = adsetName === '새 판매 광고'
    ? { x: 371, y: 159, width: 44, height: 36, label: '광고 복제 작업메뉴 빠른 좌표' }
    : { x: 407, y: 113, width: 44, height: 36, label: '광고 세트 작업메뉴 빠른 좌표' };

  async function isActionMenuOpen(timeout = 3000) {
    const actionHeading = page.locator('div[role="heading"]').filter({ hasText: /광고( 세트)?에 대한 작업/ }).first();
    const actionHeadingVisible = await actionHeading.isVisible({ timeout }).catch(() => false);
    const duplicateByClass = page.locator('div.x1mcwxda').filter({ hasText: /^복제$/ }).first();
    const duplicateVisible = await duplicateByClass.isVisible({ timeout }).catch(() => false);
    const bodyText = await page.locator('body').innerText().catch(() => '');

    console.log('[DEBUG] 작업 메뉴 클릭 후 body text:', bodyText.slice(0, 1200));
    console.log('[DEBUG] 광고세트 작업 heading visible:', actionHeadingVisible);
    console.log('[DEBUG] 복제 버튼 visible:', duplicateVisible);

    return actionHeadingVisible
      || duplicateVisible
      || bodyText.includes('광고 세트에 대한 작업')
      || bodyText.includes('광고에 대한 작업')
      || bodyText.includes('복제');
  }

  console.log('[DEBUG] 빠른 작업메뉴 좌표 클릭 시도:', fastMenuBox);
  await page.mouse.click(fastMenuBox.x + fastMenuBox.width / 2, fastMenuBox.y + fastMenuBox.height / 2);
  await page.waitForTimeout(1000);

  if (await isActionMenuOpen(3000)) {
    console.log('[STEP] 작업 메뉴 빠른 좌표 열기 성공');
    return;
  }

  console.log('[WARN] 빠른 좌표로 작업 메뉴 확인 실패 - 기존 row 탐색으로 fallback');

  const rowPatterns = adsetName === '새 판매 광고'
    ? [/새\s*판매\s*광고$/, /광고\s*-\s*사본/, /default-button-for-action-menu_\d+/]
    : [new RegExp(adsetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), /새\s*판매\s*광고\s*세트/, /광고\s*세트/, /default-button-for-action-menu_\d+/];
  let adRow = page.locator(`text=${adsetName}`).first();
  for (const pattern of rowPatterns) {
    const candidate = page
      .locator('[role="row"], [role="button"], span._3dfi._3dfj, [id^="default-button-for-action-menu_"]')
      .filter({ hasText: pattern })
      .first();
    if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
      adRow = candidate;
      break;
    }
  }
  const adRowVisible = await adRow.isVisible({ timeout: 15000 }).catch(() => false);
  if (!adRowVisible) {
    throw new Error(`광고세트 row를 찾지 못했습니다: ${adsetName}`);
  }
  await page.waitForTimeout(500);

  const adRowBox = await adRow.boundingBox();
  if (!adRowBox) throw new Error(`광고세트 row 위치를 찾지 못했습니다: ${adsetName}`);

  console.log('[DEBUG] 광고세트 row box:', { adsetName, adRowBox });

  const menuButtonSelector = '[role="button"].x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf';
  const menuIconSelector = '.x6s0dn4.x78zum5.x1q0g3np.xozqiw3.x2lwn1j.xeuugli.x1iyjqo2.x8va1my.x1hc1fzr.x13dflua.x6o7n8i.xxziih7.x12w9bfk.xl56j7k.xh8yej3';

  let opened = false;

  for (let attempt = 1; attempt <= 10 && !opened; attempt += 1) {
    console.log(`[STEP] 작업 메뉴 검색/클릭 시도 ${attempt}/10`);

    const buttonCandidates = await page.locator(menuButtonSelector).elementHandles();
    let targetMenu = null;

    for (const candidate of buttonCandidates) {
      const hasIcon = await candidate.$(menuIconSelector);
      if (!hasIcon) continue;

      const box = await candidate.boundingBox();
      if (!box) continue;

      const sameRow = Math.abs((box.y + box.height / 2) - (adRowBox.y + adRowBox.height / 2)) < 15;
      const rightSide = box.x > adRowBox.x;

      console.log('[DEBUG] 작업 메뉴 candidate:', { box, sameRow, rightSide });

      if (sameRow && rightSide) {
        targetMenu = candidate;
        break;
      }
    }

    if (!targetMenu) {
      console.log('[WARN] 같은 row의 작업 메뉴 후보를 찾지 못함');
      await page.waitForTimeout(1000);
      continue;
    }

    const menuBox = await targetMenu.boundingBox();
    if (!menuBox) {
      await page.waitForTimeout(1000);
      continue;
    }

    const menuTypeLabel = adsetName === '새 판매 광고' ? '광고 복제 작업메뉴 찾기' : '광고 세트 작업메뉴 찾기';
    console.log(`[DEBUG] ${menuTypeLabel}:`, menuBox);
    await page.waitForTimeout(300);
    await page.mouse.click(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
    await page.waitForTimeout(1000);

    if (await isActionMenuOpen(5000)) {
      opened = true;
      break;
    }

    await page.waitForTimeout(2500);
  }

  if (!opened) {
    await safeScreenshot(page, path.join(DIRS.screenshots, 'duplicate-menu-not-opened.png'), 'duplicate menu not opened');
    throw new Error('작업 메뉴를 클릭했지만 복제 메뉴가 열리지 않았습니다.');
  }

  console.log('[STEP] 작업 메뉴 열기 성공');
}

async function clickDuplicateMenuItem(page) {
  const duplicateButton = page
    .locator('div.x1mcwxda, [role="menuitem"], [role="button"], div, span')
    .filter({ hasText: /^(복제|Duplicate)$/ })
    .first();

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await duplicateButton.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(500);
    await duplicateButton.click({ force: true }).catch(async () => {
      const box = await duplicateButton.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });

    let bodyText = '';
    let input = null;
    const modalDeadline = Date.now() + 6000;
    while (Date.now() < modalDeadline && !input) {
      bodyText = await page.locator('body').innerText().catch(() => '');
      input = await findDuplicateCountInputHandle(page);
      if (input || /복제\s*개수|계속|복제 만들기|Create duplicates|Duplicate/i.test(bodyText)) break;
      await page.waitForTimeout(400);
    }
    const duplicateStillVisible = await duplicateButton.isVisible({ timeout: 1000 }).catch(() => false);
    if (input || !duplicateStillVisible || /복제\s*개수|계속|복제 만들기|Create duplicates|Duplicate/i.test(bodyText)) {
      console.log('[STEP] duplicate menu item clicked');
      return true;
    }

    console.log(`[WARN] 복제 클릭 후 모달/input 미확정 - 재시도 ${attempt}/10`);
  }

  await safeScreenshot(page, path.join(DIRS.screenshots, 'duplicate-button-click-failed.png'), 'duplicate button click failed');
  throw new Error('복제 버튼 클릭에 실패했습니다.');
}

async function findDuplicateCountInputHandle(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const labelTextFor = (input) => {
      const labelledBy = input.getAttribute('aria-labelledby') || '';
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
    };
    const candidates = [...document.querySelectorAll('input')]
      .filter(visible)
      .map((input) => {
        const box = input.getBoundingClientRect();
        const type = (input.getAttribute('type') || 'text').toLowerCase();
        const value = input.value || input.getAttribute('value') || '';
        const placeholder = input.getAttribute('placeholder') || '';
        const ariaLabel = input.getAttribute('aria-label') || '';
        const labelText = labelTextFor(input);
        const role = input.getAttribute('role') || '';
        const allText = normalize(`${placeholder} ${ariaLabel} ${labelText}`);
        const numeric = /^\d*$/.test(value);
        const duplicateHint = /복제|개수|수량|duplicate|copies|number/i.test(allText);
        const numberType = type === 'number' || role === 'spinbutton';
        const timeHint = /(^|\s)(분|시|시간|초|오전|오후|minute|minutes|min|hour|hours|time|second|seconds)(\s|$)/i.test(allText) ||
          /^(분|시|시간|초)$/i.test(ariaLabel);
        const booleanValue = /^(true|false)$/i.test(value);
        const dateOrTime = /:|-/.test(value) || /date|time/i.test(type);
        const score = duplicateHint ? 0 : (value === '1' ? 1 : (numberType ? 2 : 3));
        return { input, box, type, value, placeholder, ariaLabel, labelText, role, numeric, duplicateHint, numberType, timeHint, booleanValue, dateOrTime, score };
      })
      .filter((item) => {
        if (item.booleanValue || item.dateOrTime || item.timeHint) return false;
        if (!item.numeric) return false;
        if (item.value && Number(item.value) > 100) return false;
        return item.duplicateHint || item.numberType || item.value === '1' || item.box.width < 180;
      })
      .sort((a, b) => {
        return a.score - b.score || b.box.x - a.box.x || a.box.y - b.box.y;
      });

    return candidates[0]?.input || null;
  }).catch(() => null);

  const input = handle?.asElement?.() || null;
  if (input) {
    const meta = await input.evaluate((el) => ({
      type: el.getAttribute('type') || '',
      value: el.value || el.getAttribute('value') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      ariaLabelledBy: el.getAttribute('aria-labelledby') || '',
      role: el.getAttribute('role') || '',
    })).catch(() => ({}));
    console.log('[DEBUG] duplicate count input selected:', meta);
  }
  return input;
}

async function focusDuplicateInputReliably(page, duplicateInput) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await duplicateInput.click({ force: true, timeout: 5000 });
      return true;
    } catch (error) {
      console.log('[WARN] duplicate input force click failed:', { attempt, error: error.message });
      const box = await duplicateInput.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch((mouseError) => {
          console.log('[WARN] duplicate input mouse click failed:', { attempt, error: mouseError.message });
        });
        const focusedByMouse = await duplicateInput.evaluate((el) => document.activeElement === el).catch(() => false);
        if (focusedByMouse) return true;
      }
      const focusedByDom = await duplicateInput.evaluate((el) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        return document.activeElement === el;
      }).catch(() => false);
      if (focusedByDom) return true;
      await page.waitForTimeout(1000);
    }
  }

  console.log('[WARN] duplicate input click/focus remained blocked - continuing with DOM value fallback');
  return false;
}

async function setDuplicateCount(page, count = 9, adsetName) {
  console.log('[STEP] 복제 옵션 버튼 검색:', { adsetName, count });

  let duplicateInput = null;
  for (let modalAttempt = 1; modalAttempt <= 3 && !duplicateInput; modalAttempt += 1) {
    console.log(`[STEP] 복제 모달 열기/수량 input 확인 ${modalAttempt}/3`);
    await openCorrectAdActionMenu(page, adsetName);
    await clickDuplicateMenuItem(page);
    console.log('[STEP] 복제 개수 input 검색');

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      duplicateInput = await findDuplicateCountInputHandle(page);
      if (duplicateInput) break;
      console.log(`[WAIT] 복제 개수 input 검색 재시도 ${modalAttempt}.${attempt}/8`);
      await page.waitForTimeout(attempt <= 3 ? 700 : 1500);
    }

    if (!duplicateInput && modalAttempt < 3) {
      console.log('[WARN] 복제 개수 input 미확정 - 모달 닫고 복제 메뉴 재오픈');
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(1000);
    }
  }

  if (!duplicateInput) {
    await safeScreenshot(page, path.join(DIRS.screenshots, 'duplicate-count-input-not-found.png'), 'duplicate count input not found');
    throw new Error('복제 개수 input을 찾지 못했습니다.');
  }

  await focusDuplicateInputReliably(page, duplicateInput);
  await page.waitForTimeout(200);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.type(String(count), { delay: 80 });
  let duplicateValueCheck = await waitForInputHandleValue(duplicateInput, String(count), 3000);
  let actualValue = duplicateValueCheck.actual;
  console.log('[DEBUG] duplicate count after keyboard input:', actualValue);

  if (!duplicateValueCheck.ok) {
    console.log('[WARN] 키보드 입력으로 복제 개수 변경 실패 - DOM value 직접 변경 fallback');

    await duplicateInput.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(count));

    duplicateValueCheck = await waitForInputHandleValue(duplicateInput, String(count), 3000);
    actualValue = duplicateValueCheck.actual;
  }

  console.log('[DEBUG] final duplicate count:', actualValue);

  if (actualValue !== String(count)) {
    throw new Error(`복제 개수 변경 실패: expected=${count}, actual=${actualValue}`);
  }

  console.log(`[STEP] 복제 개수 ${count}개 설정 완료`);

  await uncheckExistingEngagementSharingOption(page);
  await confirmDuplicateModal(page);
}

async function uncheckExistingEngagementSharingOption(page) {
  console.log('[STEP] 기존 공감/댓글/공유 표시 옵션 해제 확인');

  {
    const engagementPatterns = [
      /기존 공감, 댓글 및 공유/,
      /기존 공감, 댓글 및 공유 사용/,
      /기존 게시물의 공감, 댓글 및 공유/,
      /Use existing reactions, comments and shares/i,
      /Use existing engagement/i,
    ];
    for (const pattern of engagementPatterns) {
      const option = page.locator('label, div, span').filter({ hasText: pattern }).first();
      const visible = await option.isVisible({ timeout: 1200 }).catch(() => false);
      if (!visible) continue;
      const unchecked = await option.evaluate((el) => {
        const root = el.closest('label, [role="checkbox"], [role="button"], div') || el;
        const checkbox = root.querySelector?.('input[type="checkbox"], [role="checkbox"]') ||
          root.previousElementSibling?.querySelector?.('input[type="checkbox"], [role="checkbox"]') ||
          root.parentElement?.querySelector?.('input[type="checkbox"], [role="checkbox"]');
        if (!checkbox) return { found: false, checked: false };
        const checked = checkbox.checked === true || checkbox.getAttribute('aria-checked') === 'true';
        if (checked) checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { found: true, checked };
      }).catch(() => ({ found: false, checked: false }));
      if (unchecked.found) {
        console.log('[STEP] existing engagement checkbox unchecked:', { pattern: String(pattern), wasChecked: unchecked.checked });
        return true;
      }
    }
  }

  const labelText = '새로운 광고에 기존 공감, 댓글 및 공유 표시하기';
  const label = page
    .locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2')
    .filter({ hasText: labelText })
    .first()
    .or(page.getByText(labelText).first());

  const labelVisible = await label.isVisible({ timeout: 5000 }).catch(() => false);
  if (!labelVisible) {
    console.log('[STEP] 기존 공감/댓글/공유 표시 옵션 미노출 - 건너뜀');
    return false;
  }

  const labelBox = await label.boundingBox().catch(() => null);
  console.log('[DEBUG] 기존 공감/댓글/공유 표시 옵션 label box:', labelBox);

  const checkedInputs = await page
    .locator('input[type="checkbox"][aria-checked="true"], input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')
    .elementHandles()
    .catch(() => []);

  let targetCheckbox = null;
  let targetBox = null;

  for (const checkbox of checkedInputs) {
    const visible = await checkbox.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await checkbox.boundingBox().catch(() => null);
    if (!box) continue;

    const sameRow = labelBox
      ? Math.abs((box.y + box.height / 2) - (labelBox.y + labelBox.height / 2)) < 40
      : true;
    const leftOfLabel = labelBox ? box.x < labelBox.x + labelBox.width : true;

    console.log('[DEBUG] 기존 공감/댓글/공유 checkbox 후보:', { box, sameRow, leftOfLabel });

    if (sameRow && leftOfLabel) {
      targetCheckbox = checkbox;
      targetBox = box;
      break;
    }
  }

  if (!targetCheckbox) {
    console.log('[STEP] 기존 공감/댓글/공유 표시 옵션이 이미 해제되었거나 체크박스 미탐지');
    return false;
  }

  await targetCheckbox.click({ force: true }).catch(async () => {
    await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  });
  await page.waitForTimeout(1500);

  const stillChecked = await targetCheckbox.evaluate((el) => (
    el.getAttribute('aria-checked') === 'true' || el.checked === true
  )).catch(() => false);

  console.log('[STEP] 기존 공감/댓글/공유 표시 옵션 해제 완료:', { stillChecked });
  return !stillChecked;
}



async function confirmDuplicateModal(page) {
  console.log('[STEP] 복제 모달 하단 "복제 만들기" 버튼 확인 클릭');

  const duplicateCreateButton = page.locator('#pe_duplicate_create_button').first();

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const visible = await duplicateCreateButton.isVisible({ timeout: 3000 }).catch(() => false);
    const box = await duplicateCreateButton.boundingBox().catch(() => null);

    console.log('[DEBUG] 복제 만들기 버튼 상태:', { attempt, visible, box });

    if (visible && box) {
      await page.waitForTimeout(500);
      await duplicateCreateButton.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await duplicateCreateButton.waitFor({ state: 'hidden', timeout: 7000 }).catch(() => null);
      return true;
    }

    console.log(`[WAIT] 복제 만들기 버튼 검색 재시도 ${attempt}/10`);
    await page.waitForTimeout(1200);
  }

  const confirmCandidates = page.locator('div, span, button').filter({ hasText: /^복제$/ });

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const count = await confirmCandidates.count();

    for (let i = 0; i < count; i += 1) {
      const candidate = confirmCandidates.nth(i);
      const box = await candidate.boundingBox().catch(() => null);
      const visible = await candidate.isVisible().catch(() => false);
      const text = (await candidate.innerText().catch(() => '')).trim();

      console.log('[DEBUG] 복제 confirm fallback candidate:', { attempt, index: i, text, visible, box });

      if (!visible || !box) continue;
      if (box.x < 900 || box.y < 480 || box.y > 700) continue;

      await page.waitForTimeout(500);
      await candidate.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await candidate.waitFor({ state: 'hidden', timeout: 7000 }).catch(() => null);
      return true;
    }

    console.log(`[WAIT] 복제 confirm fallback 검색 재시도 ${attempt}/10`);
    await page.waitForTimeout(1200);
  }

  await safeScreenshot(page, path.join(DIRS.screenshots, 'duplicate-confirm-not-found.png'), 'duplicate confirm not found');
  throw new Error('복제 모달의 확인/복제 만들기 버튼을 찾지 못했습니다.');
}

async function clickContinueButtonOnly(page) {
  await pause(page, '계속 버튼 검색 전 대기', 5000);
  let continueButton = null;

  for (let attempt = 1; attempt <= 8 && !continueButton; attempt += 1) {
    const continueCandidates = await page
      .locator('div, span, button')
      .filter({ hasText: /^계속$/ })
      .elementHandles();

    for (const el of continueCandidates) {
      const text = (await el.innerText().catch(() => '')).trim();
      const box = await el.boundingBox();
      console.log('[DEBUG] continue candidate:', { attempt, text, box });

      if (text !== '계속' || !box) continue;
      if (box.x > 900 && box.y > 300 && box.y < 700) {
        continueButton = el;
        break;
      }
    }

    if (!continueButton) {
      console.log(`[WAIT] 계속 버튼 검색 재시도 ${attempt}/8`);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(5000);
    }
  }

  if (!continueButton) {
    await debugDump(page, 'continue button not found after retries');
    throw new Error('계속 버튼을 찾지 못했습니다.');
  }

  const box = await continueButton.boundingBox();
  if (!box) throw new Error('계속 버튼 좌표를 가져오지 못했습니다.');

  await continueButton.click().catch(async () => {
    await continueButton.click({ force: true });
  }).catch(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });

  await page.waitForTimeout(3500);
}

async function clickCampaignContinueButton(page) {
  const candidates = [
    {
      name: 'completion data-surface continue',
      locator: page
        .locator('div[role="button"][data-surface="/am/lib:convergence_alt_modal_geo/lib:completion-button"]')
        .filter({ hasText: /^계속$/ })
        .first(),
    },
    { name: 'role button continue', locator: page.getByRole('button', { name: /^계속$/ }).first() },
    { name: 'text exact continue', locator: page.getByText(/^계속$/).first() },
    {
      name: 'completion data-surface fallback',
      locator: page
        .locator('div[role="button"][data-surface*="completion-button"]')
        .filter({ hasText: /계속/ })
        .first(),
    },
  ];

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    for (const candidate of candidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1200 }).catch(() => false);
      if (!visible) continue;
      const disabled = await candidate.locator.evaluate((el) => (
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.hasAttribute('disabled')
      )).catch(() => false);
      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] continue button candidate:', { attempt, name: candidate.name, disabled, box });
      if (disabled || !box) continue;
      await candidate.locator.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      console.log('[STEP] continue clicked');
      await page.waitForLoadState('domcontentloaded').catch(() => null);
      await page.waitForTimeout(5000);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  await debugDump(page, 'campaign continue button not found');
  throw new Error('Campaign objective continue button not found or stayed disabled.');
}

async function selectSalesObjective(page) {
  console.log('[STEP] selecting sales objective');
  const heading = page
    .getByRole('heading', { name: /^판매$/ })
    .first()
    .or(page.locator('span[role="heading"][aria-level="4"]').filter({ hasText: /^판매$/ }).first())
    .or(page.getByText(/^판매$/).first());

  await heading.waitFor({ state: 'visible', timeout: 60000 });
  const alreadyChecked = await heading.evaluate((el) => {
    const root = el.closest('[role="radio"], label, [role="button"], div') || el.parentElement;
    const scoped = root?.querySelector?.('input[aria-checked="true"], [role="radio"][aria-checked="true"]');
    const fallback = document.querySelector('input[aria-labelledby="js_7be"][aria-checked="true"]');
    return Boolean(scoped || fallback);
  }).catch(() => false);
  if (alreadyChecked) {
    console.log('[STEP] sales objective already selected');
    return true;
  }

  const clicked = await heading.evaluate((el) => {
    const root = el.closest('[role="radio"], label, [role="button"]') || el.closest('div');
    const target = root?.querySelector?.('input[type="radio"], input[role="radio"], [role="radio"]') || root || el;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);
  if (!clicked) await heading.click({ force: true });

  await page.waitForTimeout(500);
  const checked = await page.evaluate(() => {
    const salesHeading = [...document.querySelectorAll('[role="heading"], span, div')]
      .find((el) => (el.textContent || '').trim() === '판매');
    const root = salesHeading?.closest('[role="radio"], label, [role="button"], div') || salesHeading?.parentElement;
    return Boolean(
      root?.querySelector?.('input[aria-checked="true"], [role="radio"][aria-checked="true"], input:checked') ||
      document.querySelector('input[aria-labelledby="js_7be"][aria-checked="true"], input[aria-labelledby="js_7be"]:checked')
    );
  });
  if (!checked) {
    await debugDump(page, 'sales objective not selected');
    throw new Error('Sales objective selection failed.');
  }
  console.log('[STEP] sales objective selected');
  return true;
}

async function fillCampaignName(page, campaignName) {
  console.log('[STEP] filling campaign name:', campaignName);
  const candidates = [
    page.locator('input[placeholder="여기에 캠페인 이름을 입력하세요..."], input[placeholder="여기에 캠페인을입력하세요..."]').first(),
    page.locator('input[placeholder*="캠페인"][placeholder*="입력"]').first(),
    page.locator('input[value="새 판매 캠페인"]').first(),
    page.locator('input.xjbqb8w.x972fbf.x10w94by.x1qhh985.x14e42zd.xdj266r.x14z9mp.xat24cr.x1lziwak.x1t137rt.xexx8yu.xyri2b.x18d9i69.x1c1uobl.xwd1esu.x1gnnqk1.xbsr9hj.x1urst0s.x1glnyev.x1ad04t7.x1ix68h3.x19gujb8.xni1clt.x1tutvks.xfrpkgu.x1vvvo52.x1fvot60.xo1l8bm.xxio538.x1rffpxw.xh8yej3.x10emqs4').first(),
  ];
  for (const locator of candidates) {
    const visible = await locator.isVisible({ timeout: 5000 }).catch(() => false);
    if (!visible) continue;
    const handle = await locator.elementHandle();
    const ok = await fillInputHandle(page, handle, campaignName, 'campaign name');
    const actual = await locator.inputValue().catch(() => '');
    if (ok || actual === campaignName) {
      console.log('[STEP] campaign name filled');
      return true;
    }
  }
  await debugDump(page, 'campaign name input not found');
  throw new Error('Campaign name input not found.');
}

async function findInputNearExactText(page, text, inputFilter = () => true) {
  return page.evaluateHandle(({ text }) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const label = [...document.querySelectorAll('span, div, label')]
      .filter((el) => visible(el) && (el.textContent || '').trim() === text)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (!label) return null;
    const labelBox = label.getBoundingClientRect();
    const inputs = [...document.querySelectorAll('input')]
      .filter((input) => visible(input))
      .map((input) => {
        const box = input.getBoundingClientRect();
        return { input, distance: Math.abs(box.top - labelBox.top) + Math.abs(box.left - labelBox.left), box };
      })
      .filter(({ box }) => box.top >= labelBox.top - 80 && box.top <= labelBox.top + 240)
      .sort((a, b) => a.distance - b.distance);
    return inputs[0]?.input || null;
  }, { text }).then((handle) => handle.asElement()).catch(() => null);
}

async function findCampaignBudgetInputHandle(page) {
  const usableCurrencyInput = async (locator, selectorName) => {
    if (!(await locator.isVisible({ timeout: 1200 }).catch(() => false))) return null;
    const usable = await locator.evaluate((input) => {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      const value = input.value || input.getAttribute('value') || '';
      const placeholder = input.getAttribute('placeholder') || '';
      if (['checkbox', 'radio', 'hidden'].includes(type)) return false;
      if (/^(true|false)$/i.test(value)) return false;
      return /금액|amount/i.test(placeholder) || /^[\d,]*$/.test(value);
    }).catch(() => false);
    if (!usable) return null;
    console.log('[DEBUG] campaign budget input selector matched:', selectorName);
    return locator.elementHandle();
  };

  const selectors = [
    'input[id="js_7ew"]',
    'input[aria-labelledby="js_7el js_7ex"]',
    'input[placeholder="금액을 입력하세요"]',
    'input[placeholder*="금액"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const handle = await usableCurrencyInput(locator, selector);
    if (handle) return handle;
  }

  return page.evaluateHandle(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    };
    const textOf = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const usableInput = (input) => {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      const value = input.value || input.getAttribute('value') || '';
      const placeholder = input.getAttribute('placeholder') || '';
      if (['checkbox', 'radio', 'hidden'].includes(type)) return false;
      if (/^(true|false)$/i.test(value)) return false;
      return /금액|amount/i.test(placeholder) || /^[\d,]*$/.test(value);
    };
    const labels = [...document.querySelectorAll('span, div, label')]
      .filter((el) => visible(el) && textOf(el) === '캠페인 예산');

    const requestedClassLabel = [...document.querySelectorAll('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2')]
      .find((el) => visible(el) && textOf(el) === '캠페인 예산');
    if (requestedClassLabel) labels.unshift(requestedClassLabel);

    const label = labels[0];
    const inputs = [...document.querySelectorAll('input')]
      .filter((input) => visible(input) && usableInput(input))
      .map((input) => {
        const box = input.getBoundingClientRect();
        const labelBox = label?.getBoundingClientRect();
        return {
          input,
          box,
          value: input.value || input.getAttribute('value') || '',
          placeholder: input.getAttribute('placeholder') || '',
          aria: input.getAttribute('aria-labelledby') || '',
          id: input.id || '',
          distance: labelBox ? Math.abs(box.top - labelBox.top) + Math.abs(box.left - labelBox.left) : 999999,
        };
      });

    const exact = inputs.find((item) => item.id === 'js_7ew' || item.aria === 'js_7el js_7ex');
    if (exact) return exact.input;

    const placeholderMatch = inputs.find((item) => /금액|amount/i.test(item.placeholder));
    if (placeholderMatch) return placeholderMatch.input;

    if (label) {
      const labelBox = label.getBoundingClientRect();
      const nearby = inputs
        .filter((item) => item.box.top >= labelBox.top && item.box.top <= labelBox.top + 520)
        .sort((a, b) => {
          const aCurrency = /^[\d,]+$/.test(a.value) ? 0 : 1;
          const bCurrency = /^[\d,]+$/.test(b.value) ? 0 : 1;
          return aCurrency - bCurrency || a.distance - b.distance;
        });
      if (nearby[0]) return nearby[0].input;
    }

    return inputs
      .filter((item) => /^[\d,]+$/.test(item.value))
      .sort((a, b) => a.box.top - b.box.top)[0]?.input || null;
  }).then((handle) => handle.asElement()).catch(() => null);
}

async function fillCampaignBudget(page, budget) {
  const formattedBudget = formatBudgetForMetaInput(budget);
  console.log('[STEP] filling campaign budget:', { raw: budget, formattedBudget });
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(500);
  await selectCampaignDailyBudgetIfVisible(page);

  let input = await findCampaignBudgetInputHandle(page);
  if (!input) input = await findInputNearExactText(page, '캠페인 예산');
  if (!input) {
    const fallback = page.locator('input[aria-labelledby="js_7el js_7ex"], input[id="js_7ew"]').first();
    if (await fallback.isVisible({ timeout: 3000 }).catch(() => false)) input = await fallback.elementHandle();
  }
  if (!input) {
    await debugDump(page, 'campaign budget input not found');
    throw new Error('Campaign budget input not found near "캠페인 예산".');
  }

  const { ok: filled, actual } = await fillCurrencyInputHandle(page, input, formattedBudget, 'campaign budget');
  if (!filled) {
    await debugDump(page, 'campaign budget input fill mismatch');
    throw new Error(`Campaign budget fill failed: expected=${formattedBudget}, actual=${actual}`);
  }
  console.log('[STEP] campaign budget filled:', { formattedBudget, actual });
  return true;
}

async function selectCampaignDailyBudgetIfVisible(page) {
  console.log('[STEP] campaign budget type check - daily budget');
  const dailyCandidates = [
    page.getByRole('radio', { name: /일일\s*예산|일일예산/i }).first(),
    page.getByRole('button', { name: /일일\s*예산|일일예산/i }).first(),
    page.locator('label, div, span').filter({ hasText: /일일\s*예산|일일예산/i }).first(),
  ];

  for (const candidate of dailyCandidates) {
    const visible = await candidate.isVisible({ timeout: 1500 }).catch(() => false);
    if (!visible) continue;
    const selected = await candidate.evaluate((el) => (
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.querySelector?.('input:checked, [aria-checked="true"]')
    )).catch(() => false);
    if (selected) {
      console.log('[STEP] campaign budget type already daily');
      return true;
    }
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;
    await candidate.click({ force: true }).catch(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(300);
    console.log('[STEP] campaign budget type selected: daily');
    return true;
  }

  console.log('[STEP] campaign daily budget selector not visible - keeping current budget type');
  return false;
}


async function selectCampaignStructureRowByText(page, patterns, label) {
  await ensureCampaignStructureRoot(page);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const rowHandle = await page.evaluateHandle(({ label }) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const isAdset = label.includes('광고 세트');
      const textPattern = isAdset
        ? /새\s*판매\s*광고\s*세트|광고\s*세트/
        : /새\s*판매\s*광고(?!\s*세트)|광고\s*-\s*사본|광고명/;
      const surfacePart = isAdset ? 'editor_tree:adset' : 'editor_tree:ad';
      const ariaLabel = isAdset ? '광고 세트' : '광고';

      const surfaces = [...document.querySelectorAll(`[data-surface-wrapper="1"][data-surface*="${surfacePart}"] [role="rowheader"]`)]
        .filter(visible);
      const labelled = [...document.querySelectorAll(`[role="rowheader"][aria-label="${ariaLabel}"]`)]
        .filter(visible);
      const textRows = [...document.querySelectorAll('[role="rowheader"], [role="row"], [id^="ads_campaign_structure_item_"], [id^="default-button-for-action-menu_"]')]
        .filter((el) => visible(el) && textPattern.test(normalize(el.textContent)));
      const labelSpans = [...document.querySelectorAll('span._3dfi._3dfj')]
        .filter((el) => visible(el) && textPattern.test(normalize(el.textContent)))
        .map((span) => span.closest('[role="rowheader"], [role="row"], [id^="ads_campaign_structure_item_"]') || span.closest('[data-surface-wrapper="1"]') || span);

      const candidates = [...surfaces, ...labelled, ...textRows, ...labelSpans]
        .filter(Boolean)
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .map((el) => {
          const box = el.getBoundingClientRect();
          return {
            el,
            text: normalize(el.textContent),
            id: el.id || el.querySelector?.('[id^="default-button-for-action-menu_"]')?.id || '',
            aria: el.getAttribute('aria-label') || '',
            objectType: el.getAttribute('data-objecttype') || '',
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
          };
        })
        .filter((item) => item.box.width > 10 && item.box.height > 10)
        .sort((a, b) => {
          const aExact = textPattern.test(a.text) ? 0 : 1;
          const bExact = textPattern.test(b.text) ? 0 : 1;
          return aExact - bExact || a.box.y - b.box.y;
        });

      return candidates[0]?.el || null;
    }, { label }).then((handle) => handle.asElement()).catch(() => null);

    if (rowHandle) {
      const text = (await rowHandle.innerText().catch(() => '')).trim();
      const id = await rowHandle.getAttribute('id').catch(() => '');
      const box = await rowHandle.boundingBox().catch(() => null);
      console.log('[DEBUG] campaign structure row candidate:', { label, attempt, text, id, box });
      if (!box) {
        await page.waitForTimeout(1500);
        continue;
      }
      await rowHandle.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + Math.min(box.width / 2, 220), box.y + box.height / 2);
      });
      await page.waitForTimeout(5000);
      console.log('[STEP] campaign structure row selected:', { label, text, id });
      return true;
    }
    console.log(`[WAIT] campaign structure row not found: ${label} ${attempt}/10`);
    await page.waitForTimeout(2500);
  }
  await debugDump(page, `${label} row not found`);
  throw new Error(`${label} row not found in campaign structure.`);
}

async function selectNewSalesAdsetRow(page) {
  return selectCampaignStructureRowByText(page, [
    /새\s*판매\s*광고\s*세트/,
    /광고\s*세트/,
    /default-button-for-action-menu_\d+/,
  ], '새 판매 광고 세트');
}

async function selectNewSalesAdRow(page) {
  return selectCampaignStructureRowByText(page, [
    /새\s*판매\s*광고$/,
    /광고\s*-\s*사본/,
    /광고명/,
    /default-button-for-action-menu_\d+/,
  ], '새 판매 광고');
}

async function selectExistingAdsetRowByName(page, adsetName) {
  if (!adsetName) return false;
  console.log('[STEP] resume target adset row select:', { adsetName });
  await ensureCampaignStructureRoot(page);

  for (let attempt = 1; attempt <= 18; attempt += 1) {
    const candidateHandle = await page.evaluateHandle((name) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
      const target = normalize(name);
      const rows = [...document.querySelectorAll('[role="row"], [role="rowheader"], [id^="ads_campaign_structure_item_"]')];
      const candidates = rows
        .map((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          const rowHeader = el.matches?.('[role="rowheader"]') ? el : el.querySelector?.('[role="rowheader"]');
          const aria = el.getAttribute('aria-label') || rowHeader?.getAttribute('aria-label') || '';
          const surface = el.closest?.('[data-surface]')?.getAttribute('data-surface') || el.querySelector?.('[data-surface]')?.getAttribute('data-surface') || '';
          const normalizedText = normalize(text);
          const isAdset = normalize(aria).includes('광고세트') || surface.includes('editor_tree:adset') || normalizedText.includes('광고세트');
          const exact = normalizedText === target || normalizedText.includes(target);
          const copy = /사본|copy/i.test(text);
          const rect = el.getBoundingClientRect();
          return { el, text, aria, surface, isAdset, exact, copy, y: rect.y, width: rect.width, height: rect.height };
        })
        .filter((item) => item.isAdset && item.exact && item.width > 0 && item.height > 0)
        .sort((a, b) => (a.copy ? 1 : 0) - (b.copy ? 1 : 0) || a.y - b.y);
      return candidates[0]?.el || null;
    }, adsetName).catch(() => null);
    const candidate = candidateHandle ? candidateHandle.asElement() : null;
    if (candidate) {
      await candidate.scrollIntoViewIfNeeded().catch(() => null);
      const box = await candidate.boundingBox().catch(() => null);
      const text = (await candidate.innerText().catch(() => '')).trim();
      console.log('[DEBUG] resume target adset candidate:', { attempt, adsetName, text: text.slice(0, 180), box });
      if (!box) {
        await page.waitForTimeout(1500);
        continue;
      }
      await page.mouse.click(box.x + Math.min(box.width / 2, 220), box.y + box.height / 2);
      await page.waitForTimeout(2500);
      console.log('[STEP] resume target adset row selected:', { adsetName });
      return true;
    }
    console.log(`[WAIT] resume target adset row not visible ${attempt}/18: ${adsetName}`);
    await scrollCampaignStructureTree(page, attempt <= 6 ? 450 : 900);
    await page.mouse.wheel(0, attempt <= 6 ? 180 : 320).catch(() => null);
    await page.waitForTimeout(attempt <= 6 ? 1500 : 3000);
  }

  await debugDump(page, `resume target adset not found: ${adsetName}`);
  throw new Error(`Resume target adset row not found: ${adsetName}`);
}

async function isCampaignEditorTreeReady(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    };
    const root = document.querySelector('#campaign_structure_tree_root');
    if (isVisible(root)) return { ok: true, source: 'campaign_structure_tree_root' };
    const editorNode = [...document.querySelectorAll('[data-surface*="editor_tree"], [id^="ads_campaign_structure_item_"]')]
      .find((el) => isVisible(el) && /광고|adset|adgroup|campaign/i.test(el.textContent || el.getAttribute('aria-label') || ''));
    if (editorNode) {
      return {
        ok: true,
        source: editorNode.id || editorNode.getAttribute('data-surface') || editorNode.getAttribute('aria-label') || 'editor_tree_fallback',
      };
    }
    return { ok: false, source: '' };
  }).catch(() => ({ ok: false, source: '' }));
}

async function isDisabledLike(locator) {
  return locator.evaluate((el) => (
    el.getAttribute('aria-disabled') === 'true' ||
    el.getAttribute('aria-busy') === 'true' ||
    el.hasAttribute('disabled') ||
    Boolean(el.closest('[aria-disabled="true"], [aria-busy="true"]'))
  ));
}

async function ensureCampaignEditorOpenForResume(page, label = 'resume') {
  const ready = await isCampaignEditorTreeReady(page);
  if (ready.ok) {
    console.log('[STEP] resume editor tree already ready:', ready);
    return true;
  }

  console.warn('[WARN] resume editor tree not visible - attempting to reopen editor:', {
    label,
    url: page.url(),
    title: await page.title().catch(() => ''),
  });

  const editLocators = [
    page.getByRole('button', { name: /^수정$/ }).first(),
    page.getByRole('button', { name: /^Edit$/i }).first(),
    page.locator('[role="button"], button').filter({ hasText: /^수정$/ }).first(),
    page.locator('[role="button"], button').filter({ hasText: /^Edit$/i }).first(),
    page.getByText(/^수정$/).locator('xpath=ancestor-or-self::*[@role="button" or self::button][1]').first(),
  ];

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    for (const locator of editLocators) {
      const visible = await locator.isVisible({ timeout: 1200 }).catch(() => false);
      if (!visible) continue;
      const disabled = await isDisabledLike(locator).catch(() => false);
      if (disabled) continue;
      console.log('[STEP] resume editor reopen - clicking edit button:', { attempt, label });
      await locator.click({ force: true, timeout: 8000 }).catch(async (error) => {
        console.warn('[WARN] resume edit button click failed:', error.message);
      });
      await page.waitForTimeout(attempt <= 2 ? 3000 : 6000);
      const afterClick = await isCampaignEditorTreeReady(page);
      if (afterClick.ok) {
        console.log('[STEP] resume editor tree reopened:', afterClick);
        return true;
      }
    }

    const opened = await page.getByText(/^열기$/).first().isVisible({ timeout: 1000 }).catch(() => false);
    if (opened) {
      console.log('[STEP] resume editor reopen - clicking open button:', { attempt, label });
      await page.getByText(/^열기$/).first().click({ force: true }).catch(() => null);
    }
    await page.waitForTimeout(attempt <= 3 ? 2500 : 5000);
    const afterWait = await isCampaignEditorTreeReady(page);
    if (afterWait.ok) {
      console.log('[STEP] resume editor tree ready after wait:', afterWait);
      return true;
    }
  }

  await debugDump(page, `resume editor tree reopen failed: ${label}`);
  throw new Error(`Resume editor tree not available: ${label}`);
}

async function selectExistingAdRowByName(page, adName) {
  if (!adName) return false;
  console.log('[STEP] resume target ad row select:', { adName });
  await ensureCampaignEditorOpenForResume(page, adName);

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const candidateHandle = await page.evaluateHandle((name) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
      const target = normalize(name);
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };
      const rows = [...document.querySelectorAll('[role="row"], [role="rowheader"], [id^="ads_campaign_structure_item_"]')];
      const candidates = rows
        .map((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          const rowHeader = el.matches?.('[role="rowheader"]') ? el : el.querySelector?.('[role="rowheader"]');
          const aria = el.getAttribute('aria-label') || rowHeader?.getAttribute('aria-label') || '';
          const surface = el.closest?.('[data-surface]')?.getAttribute('data-surface') || el.querySelector?.('[data-surface]')?.getAttribute('data-surface') || '';
          const normalizedText = normalize(text);
          const normalizedAria = normalize(aria);
          const isAd = normalizedAria === '광고' ||
            normalizedAria.includes('ad') ||
            /editor_tree:ad(\/|$)/.test(surface) ||
            surface.includes('editor_tree:ad/lib:');
          const isAdset = normalizedAria.includes('광고세트') ||
            normalizedAria.includes('adset') ||
            surface.includes('editor_tree:adset') ||
            normalizedText.includes('광고세트');
          const exact = normalizedText === target || normalizedText.includes(target);
          const rect = el.getBoundingClientRect();
          return { el, text, aria, surface, isAd, isAdset, exact, y: rect.y, width: rect.width, height: rect.height };
        })
        .filter((item) => item.isAd && !item.isAdset && item.exact && item.width > 0 && item.height > 0 && isVisible(item.el))
        .sort((a, b) => a.y - b.y);
      return candidates[0]?.el || null;
    }, adName).catch(() => null);
    const candidate = candidateHandle ? candidateHandle.asElement() : null;
    if (candidate) {
      await candidate.scrollIntoViewIfNeeded().catch(() => null);
      const box = await candidate.boundingBox().catch(() => null);
      const text = (await candidate.innerText().catch(() => '')).trim();
      console.log('[DEBUG] resume target ad candidate:', { attempt, adName, text: text.slice(0, 180), box });
      if (!box) {
        await page.waitForTimeout(1500);
        continue;
      }
      await page.mouse.click(box.x + Math.min(box.width / 2, 220), box.y + box.height / 2);
      await page.waitForTimeout(3500);
      console.log('[STEP] resume target ad row selected:', { adName });
      return true;
    }

    console.log(`[WAIT] resume target ad row not visible ${attempt}/30: ${adName}`);
    if (attempt % 8 === 0) {
      await ensureCampaignEditorOpenForResume(page, `retry ${adName}`);
    }
    await scrollCampaignStructureTree(page, attempt <= 10 ? 450 : 900);
    await page.mouse.wheel(0, attempt <= 10 ? 180 : 360).catch(() => null);
    await page.waitForTimeout(attempt <= 10 ? 1500 : 3000);
  }

  await debugDump(page, `resume target ad not found: ${adName}`);
  throw new Error(`Resume target ad row not found: ${adName}`);
}


async function enterAdsetFlow(page) {
  if (isCboCampaign()) {
    await selectNewSalesAdsetRow(page);
    return true;
  }
  await ensureAdsetCreateOpen(page);
  await page.locator('input[placeholder="광고 세트 이름 지정"], input[placeholder="여기에 광고 세트 이름을 입력하세요..."], input._58al._aghb').first().waitFor({ state: 'visible', timeout: 180000 });
}



async function selectImageAdModeWithRequestedClasses(page) {
  console.log('[STEP] 이미지 광고 버튼 선택 단계 시작');

  const surfaceWrapper = page.locator('span[data-surface-wrapper="1"]').first();
  const requestedWrapper = page
    .locator('div.x6s0dn4.x1q0g3np.xozqiw3.x2lwn1j.x1iyjqo2.xs83m0k.x1xsc7gk.x78zum5.xeuugli')
    .filter({ hasText: /이미지\s*광고/ })
    .first();

  const requestedLabel = page
    .locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2')
    .filter({ hasText: /^이미지\s*광고$/ })
    .first();

  const requestedIconOrButton = page
    .locator('div.x6s0dn4.x78zum5.x1q0g3np.xozqiw3.x2lwn1j.xeuugli.x1iyjqo2.x8va1my.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1y1aw1k.xwib8y2.xmzvs34.xf159sx.xo1l8bm.xbsr9hj.x1v911su')
    .filter({ hasText: /이미지\s*광고/ })
    .first();

  const autoLoggingButton = page
    .locator('[data-auto-logging-id="f1a363776"]')
    .filter({ hasText: /이미지\s*광고/ })
    .first();

  const ariaReadyButton = page
    .locator('[aria-busy="false"], [aria-busy="False"]')
    .filter({ hasText: /이미지\s*광고/ })
    .first();

  const longClassButton = page
    .locator('div.x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.x2lwn1j.xeuugli.x16tdsg8.xggy1nq.x1ja2u2z.x6s0dn4.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x3nfvp2.xdl72j9.x1q0g3np.x2lah0s.x193iq5w.x1n2onr6.x1hl2dhg.x87ps6o.xxymvpz.xlh3980.xvmahel.x1lku1pv.x1g40iwv.x1g2r6go.x16e9yqp.x12w9bfk.x15406qy.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1ob88yx.xaatb59.x1qgsegg.xo1l8bm.xbsr9hj.x1v911su.x1y1aw1k.xwib8y2.xv54qhq.x1g0dm76')
    .filter({ hasText: /이미지\s*광고/ })
    .first();

  const presentationArea = page
    .locator('div[role="presentation"].x3nfvp2.x120ccyz.x1heor9g.x2lah0s.x1c4vz4f')
    .first();

  const uploadButton = page
    .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
    .filter({ hasText: /^업로드/ })
    .first()
    .or(page.getByRole('button', { name: /^업로드/ }).first())
    .or(page.getByText(/^업로드/).first());

  const candidates = [
    { name: 'data-auto-logging-id f1a363776', locator: autoLoggingButton },
    { name: 'aria-busy false image ad', locator: ariaReadyButton },
    { name: 'requested long button class', locator: longClassButton },
    { name: 'requested icon/button class', locator: requestedIconOrButton },
    { name: 'requested wrapper row', locator: requestedWrapper },
    { name: 'requested image label', locator: requestedLabel },
    {
      name: 'menuitem data-surface',
      locator: page
        .locator('div[role="menuitem"][data-surface*="browse-image-library-dropdown-item"]')
        .filter({ hasText: /이미지\s*광고/ })
        .first(),
    },
    {
      name: 'role menuitem text',
      locator: page.getByRole('menuitem', { name: /이미지\s*광고/ }).first(),
    },
    {
      name: 'role button text',
      locator: page.getByRole('button', { name: /이미지\s*광고/ }).first(),
    },
    {
      name: 'plain text',
      locator: page.getByText(/^이미지\s*광고$/).first(),
    },
  ];

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    console.log(`[STEP] 이미지 광고 버튼 클릭 시도 ${attempt}/12`);

    const surfaceVisible = await surfaceWrapper.isVisible({ timeout: 1000 }).catch(() => false);
    const wrapperVisible = await requestedWrapper.isVisible({ timeout: 2000 }).catch(() => false);
    const labelVisible = await requestedLabel.isVisible({ timeout: 2000 }).catch(() => false);
    const autoLoggingVisible = await autoLoggingButton.isVisible({ timeout: 1000 }).catch(() => false);
    const ariaReadyVisible = await ariaReadyButton.isVisible({ timeout: 1000 }).catch(() => false);
    const presentationVisible = await presentationArea.isVisible({ timeout: 1000 }).catch(() => false);
    const uploadVisible = await uploadButton.isVisible({ timeout: 1000 }).catch(() => false);
    console.log('[DEBUG] 이미지 광고 버튼 후보 표시 상태:', {
      attempt,
      surfaceVisible,
      wrapperVisible,
      labelVisible,
      autoLoggingVisible,
      ariaReadyVisible,
      presentationVisible,
      uploadVisible,
    });

    if (surfaceVisible && uploadVisible) {
      console.log('[STEP] 이미지 광고 내부 진입 확인 - 업로드 버튼 단계로 이동');
      return;
    }

    for (const candidate of candidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;

      await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
      await page.waitForTimeout(1000);

      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] 이미지 광고 버튼 클릭 후보:', { attempt, name: candidate.name, box });

      let clicked = false;
      await candidate.locator.click({ force: true }).then(() => { clicked = true; }).catch(async () => {
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          clicked = true;
        }
      });

      if (!clicked) continue;

      await page.waitForTimeout(5000);
      const uploadVisible = await page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
        .filter({ hasText: /^업로드/ })
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      const fileInputVisible = await page.locator('input[type="file"]').first().isVisible({ timeout: 2000 }).catch(() => false);
      const enteredSurface = await surfaceWrapper.isVisible({ timeout: 2000 }).catch(() => false);

      console.log('[DEBUG] 이미지 광고 버튼 클릭 후 진입 판정:', {
        attempt,
        candidate: candidate.name,
        enteredSurface,
        uploadVisible,
        fileInputVisible,
      });

      console.log('[STEP] 이미지 광고 버튼 클릭 완료');
      return;
    }

    await page.waitForTimeout(4000);
  }

  await debugDump(page, 'image ad button not clicked');
  throw new Error('이미지 광고 버튼을 찾거나 클릭하지 못했습니다.');
}

async function selectVideoAdModeWithRequestedClasses(page) {
  console.log('[STEP] video ad button selection started');

  const adLabel = getCreativeFormatLabel('video');
  const adPattern = getCreativeFormatPattern('video');
  const surfaceWrapper = page.locator('span[data-surface-wrapper="1"]').first();
  const requestedWrapper = page
    .locator('div.x6s0dn4.x1q0g3np.xozqiw3.x2lwn1j.x1iyjqo2.xs83m0k.x1xsc7gk.x78zum5.xeuugli')
    .filter({ hasText: adPattern })
    .first();

  const requestedLabel = page
    .locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2')
    .filter({ hasText: new RegExp(`^${adLabel}$`) })
    .first();

  const requestedIconOrButton = page
    .locator('div.x6s0dn4.x78zum5.x1q0g3np.xozqiw3.x2lwn1j.xeuugli.x1iyjqo2.x8va1my.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1y1aw1k.xwib8y2.xmzvs34.xf159sx.xo1l8bm.xbsr9hj.x1v911su')
    .filter({ hasText: adPattern })
    .first();

  const longClassButton = page
    .locator('div.x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.x2lwn1j.xeuugli.x16tdsg8.xggy1nq.x1ja2u2z.x6s0dn4.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x3nfvp2.xdl72j9.x1q0g3np.x2lah0s.x193iq5w.x1n2onr6.x1hl2dhg.x87ps6o.xxymvpz.xlh3980.xvmahel.x1lku1pv.x1g40iwv.x1g2r6go.x16e9yqp.x12w9bfk.x15406qy.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1ob88yx.xaatb59.x1qgsegg.xo1l8bm.xbsr9hj.x1v911su.x1y1aw1k.xwib8y2.xv54qhq.x1g0dm76')
    .filter({ hasText: adPattern })
    .first();

  const presentationArea = page
    .locator('div[role="presentation"].x3nfvp2.x120ccyz.x1heor9g.x2lah0s.x1c4vz4f')
    .first();

  const uploadButton = page
    .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
    .filter({ hasText: /^업로드/ })
    .first()
    .or(page.getByRole('button', { name: /^업로드/ }).first())
    .or(page.getByText(/^업로드/).first());

  const candidates = [
    { name: 'requested long button class', locator: longClassButton },
    { name: 'requested icon/button class', locator: requestedIconOrButton },
    { name: 'requested wrapper row', locator: requestedWrapper },
    { name: 'requested video label', locator: requestedLabel },
    {
      name: 'role menuitem text',
      locator: page.getByRole('menuitem', { name: adPattern }).first(),
    },
    {
      name: 'role button text',
      locator: page.getByRole('button', { name: adPattern }).first(),
    },
    {
      name: 'plain text',
      locator: page.getByText(new RegExp(`^${adLabel}$`)).first(),
    },
  ];

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    console.log(`[STEP] video ad button click attempt ${attempt}/12`);

    const surfaceVisible = await surfaceWrapper.isVisible({ timeout: 1000 }).catch(() => false);
    const wrapperVisible = await requestedWrapper.isVisible({ timeout: 2000 }).catch(() => false);
    const labelVisible = await requestedLabel.isVisible({ timeout: 2000 }).catch(() => false);
    const presentationVisible = await presentationArea.isVisible({ timeout: 1000 }).catch(() => false);
    const uploadVisible = await uploadButton.isVisible({ timeout: 1000 }).catch(() => false);
    console.log('[DEBUG] video ad button candidate state:', {
      attempt,
      surfaceVisible,
      wrapperVisible,
      labelVisible,
      presentationVisible,
      uploadVisible,
    });

    if (surfaceVisible && uploadVisible) {
      console.log('[STEP] video ad internal surface confirmed');
      return;
    }

    for (const candidate of candidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;

      await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
      await page.waitForTimeout(1000);

      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] video ad click candidate:', { attempt, name: candidate.name, box });

      let clicked = false;
      await candidate.locator.click({ force: true }).then(() => { clicked = true; }).catch(async () => {
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          clicked = true;
        }
      });

      if (!clicked) continue;

      await page.waitForTimeout(5000);
      const enteredSurface = await surfaceWrapper.isVisible({ timeout: 2000 }).catch(() => false);
      const uploadVisibleAfterClick = await uploadButton.isVisible({ timeout: 3000 }).catch(() => false);
      console.log('[DEBUG] video ad click result:', {
        attempt,
        candidate: candidate.name,
        enteredSurface,
        uploadVisible: uploadVisibleAfterClick,
      });

      console.log('[STEP] video ad button click completed');
      return;
    }

    await page.waitForTimeout(2500);
  }

  await debugDump(page, 'video ad button not clicked');
  throw new Error('Could not find or click the video ad button.');
}

async function selectCreativeAdModeWithRequestedClasses(page, adFormat = AD_FORMAT) {
  const label = getCreativeFormatLabel(adFormat);
  console.log('[STEP] creative ad mode selected:', { adFormat, label });
  if (adFormat === 'video') {
    await selectVideoAdModeWithRequestedClasses(page);
    return;
  }

  await selectImageAdModeWithRequestedClasses(page);
}

function getCreativeSettingsEntryLocator(page) {
  const settingsPattern = /크리에이티브\s*설정|미디어\s*(설정|선택)|Creative\s*settings|Media\s*(settings|selection|select)/i;
  return page
    .locator('div.x78zum5.xdt5ytf.x2lwn1j.xeuugli.xkh2ocl')
    .filter({ hasText: settingsPattern })
    .first()
    .or(
      page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli.x1iyjqo2')
        .filter({ hasText: settingsPattern })
        .first(),
    )
    .or(page.getByRole('button', { name: settingsPattern }).first())
    .or(page.getByText(settingsPattern).first());
}

async function clickCreativeSettingsEntry(page, attempt = 1) {
  const creativeSettings = getCreativeSettingsEntryLocator(page);
  const visible = await creativeSettings.isVisible({ timeout: 3000 }).catch(() => false);
  if (visible) {
    await creativeSettings.scrollIntoViewIfNeeded().catch(() => null);
    const box = await creativeSettings.boundingBox().catch(() => null);
    console.log('[DEBUG] creative/media settings locator candidate:', { attempt, box });
    await creativeSettings.click({ force: true }).catch(async () => {
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(2500);
    return true;
  }

  const domResult = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const pattern = /크리에이티브\s*설정|미디어\s*(설정|선택)|Creative\s*settings|Media\s*(settings|selection|select)/i;
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [...document.querySelectorAll('[role="button"], button, div[tabindex="0"], span, div')]
      .map((el) => {
        const text = normalize(`${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`);
        const rect = el.getBoundingClientRect();
        const clickable = el.closest('[role="button"], button, div[tabindex="0"]') || el;
        return {
          el,
          clickable,
          text,
          exact: pattern.test(text),
          role: el.getAttribute('role') || clickable.getAttribute?.('role') || '',
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })
      .filter((item) => item.exact && isVisible(item.el))
      .sort((a, b) => {
        const aButton = /button/i.test(a.role) ? 0 : 1;
        const bButton = /button/i.test(b.role) ? 0 : 1;
        return aButton - bButton || a.box.y - b.box.y || a.box.x - b.box.x;
      });
    const chosen = candidates[0];
    if (!chosen) return { clicked: false };
    chosen.clickable.scrollIntoView({ block: 'center', inline: 'center' });
    chosen.clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    chosen.clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    chosen.clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return {
      clicked: true,
      text: chosen.text.slice(0, 120),
      role: chosen.role,
      box: chosen.box,
    };
  }).catch((error) => ({ clicked: false, error: error.message }));

  console.log('[DEBUG] creative/media settings DOM fallback:', { attempt, domResult });
  if (domResult.clicked) {
    await page.waitForTimeout(2500);
    return true;
  }
  return false;
}

async function isCreativeUploadVisible(page) {
  return page
    .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
    .filter({ hasText: /^업로드/ })
    .first()
    .or(page.getByRole('button', { name: /^업로드|Upload/i }).first())
    .or(page.getByText(/^업로드|Upload/i).first())
    .isVisible({ timeout: 1500 })
    .catch(() => false);
}

async function advanceFromMediaSettingsToUploadIfNeeded(page, adFormat = AD_FORMAT) {
  const uploadVisible = await isCreativeUploadVisible(page);
  if (uploadVisible) {
    console.log('[STEP] media settings already at upload step:', { adFormat });
    return;
  }

  const nextClicked = await clickOptionalMediaPickerNextButton(page, `${adFormat}-after-media-type-select`, 8000);
  if (!nextClicked) {
    console.log('[DEBUG] media settings next button not visible after ad type selection:', { adFormat });
    return;
  }

  await page.waitForTimeout(3000);
  const uploadVisibleAfterNext = await isCreativeUploadVisible(page);
  console.log('[STEP] media settings advanced after ad type selection:', {
    adFormat,
    uploadVisible: uploadVisibleAfterNext,
  });
}

async function attachMediaFromFolderIfConfigured(page, targetAdName, explicitFiles = null, adFormat = AD_FORMAT) {
  const desktopRoot = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Desktop');
  const targetFolderName = targetAdName.replace(/_\\d+$/, '');
  const todayFolderName = `f_i_o_l_${getTodayMMDD()}`;
  const folderNames = [...new Set([targetFolderName, todayFolderName])];
  const searchRoots = [
    desktopRoot,
    ...(MEDIA_FOLDER_PATH ? [path.resolve(MEDIA_FOLDER_PATH)] : []),
  ];

  async function pathExists(targetPath) {
    return fs.stat(targetPath).then((stat) => stat.isDirectory()).catch(() => false);
  }

  async function collectUploadFiles(rootPath) {
    const mediaPattern = adFormat === 'video'
      ? /\.(mp4|mov|m4v|webm)$/i
      : /\.(png|jpe?g|webp|gif)$/i;

    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const directFiles = entries
      .filter((e) => e.isFile())
      .map((e) => path.join(rootPath, e.name))
      .filter((f) => mediaPattern.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    if (directFiles.length) return directFiles;

    const childFolders = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(rootPath, e.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const nestedFiles = [];
    for (const childFolder of childFolders) {
      const childEntries = await fs.readdir(childFolder, { withFileTypes: true }).catch(() => []);
      nestedFiles.push(...childEntries
        .filter((e) => e.isFile())
        .map((e) => path.join(childFolder, e.name))
        .filter((f) => mediaPattern.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
    }

    return nestedFiles;
  }

  async function findExactMediaFolder() {
    for (const root of searchRoots) {
      for (const folderName of folderNames) {
        const candidate = path.join(root, folderName);
        if (await pathExists(candidate)) return candidate;
      }
    }
    return null;
  }

  const uploadFolder = explicitFiles?.length ? path.dirname(explicitFiles[0]) : await findExactMediaFolder();
  if (!uploadFolder) {
    throw new Error(`Could not find the expected media folder on Desktop or configured media path. Expected folder names: ${folderNames.join(', ')}`);
  }

  const files = explicitFiles?.length ? explicitFiles : await collectUploadFiles(uploadFolder);
  if (!files.length) {
    throw new Error(`No uploadable ${adFormat} files found in: ${uploadFolder}`);
  }
  if (explicitFiles?.length) {
    const targetStem = normalizeText(targetAdName);
    const aliasStems = new Set([
      targetStem,
      targetStem.replace(/^f_v_o_l_/i, 'f_v_b_o_l_'),
      targetStem.replace(/^f_v_b_o_l_/i, 'f_v_o_l_'),
    ]);
    const mismatched = files.filter((file) => {
      const parsed = path.parse(file);
      const stem = normalizeText(parsed.name);
      return !aliasStems.has(stem);
    });
    if (mismatched.length) {
      throw new Error(`Explicit ${adFormat} upload file does not match ad name: ${targetAdName}. Files: ${mismatched.join(', ')}`);
    }
  }

  console.log('[STEP] upload media folder selected:', {
    uploadFolder,
    targetAdName,
    adFormat,
    folderNames,
    fileCount: files.length,
    files,
  });

  console.log('[STEP] media creative area - searching upload button');

  const presentationArea = page
    .locator('div[role="presentation"].x3nfvp2.x120ccyz.x1heor9g.x2lah0s.x1c4vz4f')
    .first();

  const presentationVisible = await presentationArea.isVisible({ timeout: 30000 }).catch(() => false);
  console.log('[DEBUG] creative presentation area visible:', { presentationVisible });
  if (presentationVisible) {
    await presentationArea.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(1500);
  }

  const uploadButtonCandidates = [
    {
      name: 'upload data-surface button',
      locator: page
        .locator('div[role="button"][aria-busy="false"][data-surface*="creative-tool-asset-picker-upload-button"]')
        .filter({ hasText: /^업로드/ })
        .first(),
    },
    {
      name: 'upload long class button',
      locator: page
        .locator('div.x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.x2lwn1j.xeuugli.x16tdsg8.xggy1nq.x1ja2u2z.x6s0dn4.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x3nfvp2.xdl72j9.x1q0g3np.x2lah0s.x193iq5w.x1n2onr6.x1hl2dhg.x87ps6o.xxymvpz.xlh3980.xvmahel.x1lku1pv.x1g40iwv.x1g2r6go.x16e9yqp.x12w9bfk.x15406qy.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1ob88yx.xaatb59.x1qgsegg.xo1l8bm.xbsr9hj.x1v911su.x1y1aw1k.xwib8y2.xv54qhq.x1g0dm76')
        .filter({ hasText: /^업로드/ })
        .first(),
    },
    {
      name: 'role button upload',
      locator: page.getByRole('button', { name: /^업로드/ }).first(),
    },
    {
      name: 'upload text div',
      locator: page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
        .filter({ hasText: /^업로드/ })
        .first(),
    },
  ];

  let uploadButton = null;
  let uploadBox = null;
  for (let attempt = 1; attempt <= 12 && !uploadButton; attempt += 1) {
    console.log(`[STEP] upload button search/click prep ${attempt}/12`);
    for (const candidate of uploadButtonCandidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;

      await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
      await page.waitForTimeout(700);
      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] upload button candidate:', { attempt, name: candidate.name, box });
      if (!box) continue;

      uploadButton = candidate.locator;
      uploadBox = box;
      break;
    }

    if (!uploadButton) await page.waitForTimeout(3000);
  }

  if (!uploadButton) {
    await debugDump(page, 'upload button not found');
    throw new Error('Could not find the upload button.');
  }

  console.log('[DEBUG] upload button box:', uploadBox);

  const clickUploadButton = async () => uploadButton.click({ force: true }).catch(async () => {
    if (uploadBox) await page.mouse.click(uploadBox.x + uploadBox.width / 2, uploadBox.y + uploadBox.height / 2);
  });

  const largeUpload = await hasLargeUploadFile(files);
  const useCdpUpload = adFormat === 'video' || largeUpload;
  if (useCdpUpload) {
    console.log('[STEP] large/video upload detected - intercepting Chrome file chooser via CDP:', {
      adFormat,
      largeUpload,
      files,
    });
    await uploadFilesViaInterceptedChooser(page, files, clickUploadButton);
  } else {
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
    await clickUploadButton();
    const fileChooser = await fileChooserPromise;
    await uploadFilesToCurrentPicker(page, fileChooser, files, adFormat);
  }

  if (adFormat === 'video') {
    await waitForVideoUploadComplete(page, targetAdName, VIDEO_UPLOAD_TIMEOUT_MS);
  } else {
    await page.waitForTimeout(3000);
  }
  console.log('[STEP] media upload completed:', {
    uploadFolder,
    fileCount: files.length,
  });

  if (explicitFiles?.length) {
    if (!(await isExactMediaSelected(page, targetAdName))) {
      console.log('[STEP] exact uploaded media is not selected yet - clearing stale selections and clicking exact media:', { targetAdName, adFormat });
      await clearSelectedMediaSelections(page, targetAdName);
      const exactSelected = await clickVisibleMediaImageOnce(page, targetAdName, { requireExact: true });
      if (!exactSelected || !(await isExactMediaSelected(page, targetAdName))) {
        throw new Error(`Uploaded ${adFormat} was not selected with exact media name: ${targetAdName}`);
      }
    }
    await completeMediaPickerNextAndOriginalFlow(page, adFormat);
    return;
  }

  await searchAndSelectExistingMedia(page, targetAdName);
}

async function waitForVideoUploadComplete(page, targetAdName, timeoutMs = VIDEO_UPLOAD_TIMEOUT_MS) {
  const startedAt = Date.now();
  console.log('[STEP] video upload processing wait started:', {
    targetAdName,
    timeoutMs,
    fallbackWaitMs: WAIT_CONFIG.videoFallbackWaitMs,
  });
  let lastSnapshot = {};

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const hasError = /오류|실패|error|failed/i.test(bodyText);
      const hasProgress100 = /100\s*%/.test(bodyText);
      const hasThumbnail = [...document.querySelectorAll('img, video, canvas')]
        .some((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 20 && box.height > 20;
        });
      const nextEnabled = [...document.querySelectorAll('[role="button"], button')]
        .some((el) => {
          const text = (el.textContent || '').trim();
          const disabled = el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true' || el.disabled;
          return /^(다음|완료|저장|Next|Done|Save)$/.test(text) && !disabled;
        });
      const uploading = /업로드 중|처리 중|uploading|processing/i.test(bodyText);
      return { hasError, hasProgress100, hasThumbnail, nextEnabled, uploading, textSample: bodyText.slice(0, 500) };
    }).catch((error) => ({ error: error.message }));

    console.log('[DEBUG] video upload wait status:', {
      targetAdName,
      elapsedMs: Date.now() - startedAt,
      ...lastSnapshot,
    });

    if (lastSnapshot.hasError) {
      await debugDump(page, `video upload error ${targetAdName}`);
      throw new Error(`Video upload failed for ${targetAdName}.`);
    }
    if (lastSnapshot.hasProgress100 || (lastSnapshot.hasThumbnail && lastSnapshot.nextEnabled && !lastSnapshot.uploading)) {
      console.log('[STEP] upload completed:', { targetAdName, uploadWaitDurationMs: Date.now() - startedAt });
      return true;
    }
    await page.waitForTimeout(3000);
  }

  const timeoutSeconds = Math.round(timeoutMs / 1000);
  console.log('[WAIT] video upload completion ambiguous - applying fallback wait:', {
    targetAdName,
    fallbackWaitMs: WAIT_CONFIG.videoFallbackWaitMs,
    lastSnapshot,
  });
  await page.waitForTimeout(WAIT_CONFIG.videoFallbackWaitMs);
  lastSnapshot = await page.evaluate((name) => {
    const bodyText = document.body?.innerText || '';
    const hasError = /오류|실패|error|failed/i.test(bodyText);
    const hasProgress100 = /100\s*%|완료|completed|done/i.test(bodyText);
    const hasThumbnail = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(bodyText) ||
      Boolean(document.querySelector('video, img[src], [aria-label*="thumbnail" i], [data-testid*="thumbnail" i]'));
    const nextEnabled = [...document.querySelectorAll('[role="button"], button')]
      .some((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        const disabled = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') || el.getAttribute('aria-busy') === 'true';
        return /^(다음|완료|저장|Next|Done|Save)$/.test(text) && !disabled;
      });
    const uploading = /업로드 중|처리 중|uploading|processing/i.test(bodyText);
    return { hasError, hasProgress100, hasThumbnail, nextEnabled, uploading, textSample: bodyText.slice(0, 500) };
  }, targetAdName).catch((error) => ({ hasError: false, hasProgress100: false, hasThumbnail: false, nextEnabled: false, uploading: true, error: error.message }));

  if (lastSnapshot.hasProgress100 || (lastSnapshot.hasThumbnail && lastSnapshot.nextEnabled && !lastSnapshot.uploading)) {
    console.log('[STEP] video upload processing completed after fallback:', {
      targetAdName,
      uploadWaitDurationMs: Date.now() - startedAt,
      lastSnapshot,
    });
    return;
  }

  await debugDump(page, `video upload ambiguous after ${timeoutSeconds}s ${targetAdName}`);
  await safeScreenshot(
    page,
    path.join(DIRS.screenshots, `video-upload-ambiguous-${targetAdName}.png`),
    `video upload ambiguous ${targetAdName}`,
  );
  throw new Error(`Video upload completion was not confirmed within ${timeoutSeconds}s for ${targetAdName}. Last status: ${JSON.stringify(lastSnapshot)}`);
}

async function searchAndSelectExistingMedia(page, targetAdName) {
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactNameRegex = new RegExp(`^${escapeRegex(targetAdName)}(\\.[a-z0-9]+)?$`, 'i');

  console.log('[STEP] existing uploaded media search/select started:', { targetAdName });

  const mediaSearch = page
    .locator('input[placeholder="미디어 검색"], input[placeholder*="미디어"], input[type="search"]')
    .first();

  await mediaSearch.waitFor({ state: 'visible', timeout: 60000 });
  await mediaSearch.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(targetAdName, { delay: 40 });
  await page.waitForTimeout(8000);
  console.log('[STEP] exact existing media search keyword entered:', { targetAdName });
  await page.waitForTimeout(7000);

  if (await clickVisibleMediaImageOnce(page, targetAdName)) {
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  if (await clickMediaResultByNameSpanAndImage(page, targetAdName)) {
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  const explicitImageTileSelector = 'div.x1rdy4ex.x1lxpwgx.x4vbgl9.x165d6jo.xtf92mu.xp5jslt.xcjh6jn.xq2cub4.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x13fuv20.x18b5jzi.x1q0q8m5.x1t7ytsu.xamhcws.x1alpsbp.xlxy82.xyumdvf._32rk._32rg._32rh._32ri._32rj';
  if (await clickRightmostMediaTileAndVerifySelected(page, explicitImageTileSelector, targetAdName)) {
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  const mediaElements = await page
    .locator('[role="checkbox"], input[type="checkbox"], [role="button"], label, img')
    .elementHandles()
    .catch(() => []);
  const inspected = [];

  for (const element of mediaElements) {
    const visible = await element.isVisible().catch(() => false);
    if (!visible) continue;

    const matchInfo = await element.evaluate((el, target) => {
      const collectValues = (root) => {
        const attrs = ['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'alt', 'data-tooltip-content'];
        const values = [root.textContent];

        for (const attr of attrs) {
          const value = root.getAttribute?.(attr);
          if (!value) continue;
          values.push(value);
          if (attr === 'aria-labelledby' || attr === 'aria-describedby') {
            for (const id of value.split(/\s+/)) {
              const ref = root.ownerDocument.getElementById(id);
              if (ref) values.push(ref.textContent, ref.getAttribute('aria-label'), ref.getAttribute('title'));
            }
          }
        }

        for (const child of root.querySelectorAll?.('img, [aria-label], [aria-labelledby], [aria-describedby], [title], [alt], [data-tooltip-content]') || []) {
          values.push(child.textContent);
          for (const attr of attrs) {
            const value = child.getAttribute?.(attr);
            if (!value) continue;
            values.push(value);
            if (attr === 'aria-labelledby' || attr === 'aria-describedby') {
              for (const id of value.split(/\s+/)) {
                const ref = child.ownerDocument.getElementById(id);
                if (ref) values.push(ref.textContent, ref.getAttribute('aria-label'), ref.getAttribute('title'));
              }
            }
          }
        }

        return values
          .filter(Boolean)
          .flatMap((value) => String(value).split(/\s+|\n|\r|,|"/))
          .map((value) => value.trim())
          .filter(Boolean);
      };

      const mediaNameRegex = /f_i_o_l_\d{4}_\d+(\.[a-z0-9]+)?/ig;
      const exactRegex = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[a-z0-9]+)?$`, 'i');

      const roots = [];
      let current = el;
      for (let depth = 0; current && depth < 7; depth += 1) {
        roots.push(current);
        current = current.parentElement;
      }

      for (const root of roots) {
        const values = [...new Set(collectValues(root))];
        const mediaNames = [...new Set(values.flatMap((value) => value.match(mediaNameRegex) || []))];
        const exactNames = mediaNames.filter((name) => exactRegex.test(name));
        const otherNames = mediaNames.filter((name) => !exactRegex.test(name));
        const hasExactValue = values.some((value) => exactRegex.test(value));

        if ((exactNames.length || hasExactValue) && otherNames.length === 0) {
          return {
            ok: true,
            values: values.slice(0, 40),
            mediaNames,
            exactNames,
            otherNames,
            text: (root.textContent || '').trim().slice(0, 240),
          };
        }
      }

      const values = collectValues(el);
      return {
        ok: false,
        values: [...new Set(values)].slice(0, 20),
        mediaNames: [...new Set(values.flatMap((value) => value.match(mediaNameRegex) || []))],
        exactNames: [],
        otherNames: [],
        text: (el.textContent || '').trim().slice(0, 160),
      };
    }, targetAdName).catch(() => ({ ok: false, values: [], mediaNames: [], exactNames: [], otherNames: [], text: '' }));

    inspected.push({
      values: matchInfo.values.slice(0, 6),
      mediaNames: matchInfo.mediaNames,
      text: matchInfo.text,
    });
    if (!matchInfo.ok) continue;

    const clickableHandle = await element.evaluateHandle((el) => {
      const card = el.closest('[role="checkbox"], label, [role="button"]') || el;
      return card.querySelector?.('[role="checkbox"][aria-checked="false"], input[type="checkbox"]:not(:checked), input[type="radio"]:not(:checked)') || card;
    }).catch(() => null);
    const clickable = clickableHandle?.asElement?.() || element;

    await clickable.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(2500);
    const box = await clickable.boundingBox().catch(() => null);
    console.log('[DEBUG] exact media filename candidate:', {
      targetAdName,
      box,
      values: matchInfo.values,
      mediaNames: matchInfo.mediaNames,
      text: matchInfo.text,
    });
    if (!box) continue;

    await clickable.click({ force: true }).catch(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await waitForOneMediaSelected(page, targetAdName);
    console.log('[STEP] exact uploaded media selected:', { targetAdName });
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  console.log('[WARN] exact filename media card not found - selecting the visible upload result fallback:', { targetAdName });
  const fallbackCandidates = [
    {
      name: 'first unchecked result checkbox',
      locator: page.locator('[role="checkbox"][aria-checked="false"]').first(),
    },
    {
      name: 'first unchecked input checkbox',
      locator: page.locator('input[type="checkbox"][aria-checked="false"], input[type="checkbox"]:not(:checked)').first(),
    },
    {
      name: 'first visible media image parent',
      locator: page.locator('img').first(),
    },
    {
      name: 'first media result button',
      locator: page.locator('[role="button"]').filter({ hasNotText: /^다음$|^완료$|^업로드/ }).first(),
    },
  ];

  for (const candidate of fallbackCandidates) {
    const visible = await candidate.locator.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) continue;

    await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(5000);
    const box = await candidate.locator.boundingBox().catch(() => null);
    console.log('[DEBUG] visible uploaded media fallback candidate:', { targetAdName, name: candidate.name, box });
    if (!box) continue;

    const clickableHandle = await candidate.locator.evaluateHandle((el) => (
      el.closest('[role="checkbox"], label, [role="button"]') || el
    )).catch(() => null);
    const clickable = clickableHandle?.asElement?.() || await candidate.locator.elementHandle().catch(() => null);

    if (clickable) {
      await clickable.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
    } else {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }

    await waitForOneMediaSelected(page, targetAdName);
    console.log('[STEP] visible uploaded media fallback selected:', { targetAdName, candidate: candidate.name });
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  console.log('[DEBUG] exact filename matching failed - inspected samples:', inspected.slice(0, 20));
  await debugDump(page, 'existing media not selected');
  throw new Error(`Failed to search/select existing uploaded media with exact filename: ${targetAdName}`);
}

async function waitForOneMediaSelected(page, targetAdName) {
  const selectedLabel = page
    .locator('span.x1vvvo52.xw23nyj.x63nzvj.xbsr9hj.xq9mrsl.x1h4wwuj.x117nqv4.xeuugli')
    .filter({ hasText: /1\s*개\s*선택됨/ })
    .first()
    .or(page.getByText(/1\s*개\s*선택됨/).first());

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const selectedVisible = await selectedLabel.isVisible({ timeout: 2000 }).catch(() => false);
    const selectedText = selectedVisible ? await selectedLabel.innerText().catch(() => '') : '';
    console.log('[DEBUG] one media selected check:', { targetAdName, attempt, selectedVisible, selectedText });
    if (selectedVisible) {
      await page.waitForTimeout(5000);
      return true;
    }
    await page.waitForTimeout(2000);
  }

  await debugDump(page, 'one media selected label not found');
  throw new Error(`Could not confirm that exactly one media item is selected: ${targetAdName}`);
}

async function isOneMediaSelected(page) {
  const selectedLabel = page
    .locator('span.x1vvvo52.xw23nyj.x63nzvj.xbsr9hj.xq9mrsl.x1h4wwuj.x117nqv4.xeuugli')
    .filter({ hasText: /1\s*개\s*선택됨/ })
    .first()
    .or(page.getByText(/1\s*개\s*선택됨/).first());

  return selectedLabel.isVisible({ timeout: 1000 }).catch(() => false);
}

async function isExactMediaSelected(page, targetAdName) {
  return page.evaluate((target) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
    const normalizedTarget = normalize(target);
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    };
    const collectValues = (root) => {
      const values = [];
      let node = root;
      for (let depth = 0; node && depth < 8; depth += 1) {
        values.push(node.textContent);
        for (const attr of ['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'alt', 'data-tooltip-content', 'cachekey']) {
          const value = node.getAttribute?.(attr);
          if (value) values.push(value);
          if ((attr === 'aria-labelledby' || attr === 'aria-describedby') && value) {
            for (const id of value.split(/\s+/)) {
              const ref = node.ownerDocument.getElementById(id);
              if (ref) values.push(ref.textContent, ref.getAttribute('aria-label'), ref.getAttribute('title'));
            }
          }
        }
        for (const child of node.querySelectorAll?.('[aria-label], [aria-labelledby], [aria-describedby], [title], [alt], [data-tooltip-content], img, span') || []) {
          values.push(child.textContent);
          for (const attr of ['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'alt', 'data-tooltip-content', 'cachekey']) {
            const value = child.getAttribute?.(attr);
            if (value) values.push(value);
          }
        }
        node = node.parentElement;
      }
      return values.filter(Boolean).map(normalize);
    };

    const selected = [...document.querySelectorAll('[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked, [aria-selected="true"]')]
      .filter(isVisible);
    return selected.some((el) => collectValues(el).some((value) => value === normalizedTarget || value.includes(normalizedTarget)));
  }, targetAdName).catch(() => false);
}

async function clearSelectedMediaSelections(page, targetAdName) {
  const selected = await page.locator('[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked, [aria-selected="true"]').elementHandles().catch(() => []);
  console.log('[DEBUG] clearing stale media selections:', { targetAdName, count: selected.length });
  for (const element of selected) {
    const visible = await element.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await element.boundingBox().catch(() => null);
    if (!box) continue;
    await element.click({ force: true }).catch(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(800);
  }
}

async function clickVisibleMediaImageOnce(page, targetAdName, options = {}) {
  await page.waitForTimeout(5000);
  const requireExact = Boolean(options.requireExact);
  const result = await page.evaluate(({ targetAdName, requireExact }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
    const target = normalize(targetAdName);
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width >= 40 &&
        rect.height >= 40 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.top > 80 &&
        rect.left > 250;
    };

    const collectNames = (el) => {
      const values = [];
      let node = el;
      for (let depth = 0; node && depth < 7; depth += 1) {
        values.push(node.textContent);
        for (const attr of ['aria-label', 'title', 'alt', 'data-tooltip-content', 'cachekey']) {
          values.push(node.getAttribute?.(attr));
        }
        for (const child of node.querySelectorAll?.('[aria-label], [title], [alt], [data-tooltip-content], img, span') || []) {
          values.push(child.textContent);
          for (const attr of ['aria-label', 'title', 'alt', 'data-tooltip-content', 'cachekey']) {
            values.push(child.getAttribute?.(attr));
          }
        }
        node = node.parentElement;
      }
      return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
    };

    const scoreTarget = (el) => {
      const styleAttr = el.getAttribute('style') || '';
      const cachekey = el.getAttribute('cachekey') || '';
      const names = collectNames(el);
      const normalizedNames = names.map(normalize);
      const hasExact = normalizedNames.some((name) => name === target || name.includes(target));
      let score = 0;
      if (hasExact) score += 5000;
      if (cachekey.includes('ACCOUNT_1838892106940197:5fcb2558443858feef4df9bbdfe93c06')) score += 1000;
      if (cachekey.startsWith('ACCOUNT_')) score += 500;
      if (styleAttr.includes('width: 96px') && styleAttr.includes('height: 96px')) score += 300;
      if (styleAttr.includes('left: 0px') && styleAttr.includes('top: 0px')) score += 100;
      if (el.classList.contains('_5f0d')) score += 80;
      if (el.classList.contains('_5i4g')) score += 60;
      return score;
    };

    const targets = [...document.querySelectorAll(
      '[cachekey="ACCOUNT_1838892106940197:5fcb2558443858feef4df9bbdfe93c06"], [cachekey^="ACCOUNT_"], div._5f0d, img._5i4g, img, [style*="width: 96px"][style*="height: 96px"]'
    )]
      .filter((el) => visible(el))
      .map((el, index) => {
        const box = el.getBoundingClientRect();
        const parentBoxes = [];
        let parent = el.parentElement;
        for (let depth = 0; parent && depth < 5; depth += 1) {
          const parentBox = parent.getBoundingClientRect();
          if (parentBox.width >= 40 && parentBox.height >= 40) {
            parentBoxes.push({
              depth,
              tagName: parent.tagName,
              className: parent.getAttribute('class') || '',
              box: { x: parentBox.x, y: parentBox.y, width: parentBox.width, height: parentBox.height },
            });
          }
          parent = parent.parentElement;
        }
        const names = collectNames(el);
        const normalizedNames = names.map(normalize);
        const hasExact = normalizedNames.some((name) => name === target || name.includes(target));
        return {
          index,
          tagName: el.tagName,
          className: el.getAttribute('class') || '',
          cachekey: el.getAttribute('cachekey') || '',
          style: el.getAttribute('style') || '',
          score: scoreTarget(el),
          hasExact,
          names: names.slice(0, 20),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          parentBoxes,
        };
      })
      .filter((item) => !requireExact || item.hasExact);

    targets.sort((a, b) => (b.score - a.score) || (b.box.x - a.box.x) || (a.box.y - b.box.y));
    return { found: targets.length > 0, target: targets[0] || null, count: targets.length };
  }, { targetAdName, requireExact }).catch((error) => ({ found: false, error: error.message }));

  console.log('[DEBUG] visible media simple click candidate:', { targetAdName, requireExact, result });
  if (!result.found || !result.target) return false;

  const { box } = result.target;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(7000);

  if (await isOneMediaSelected(page)) {
    console.log('[STEP] visible media selected by simple click:', { targetAdName });
    return true;
  }

  const coordinateCandidates = [
    { name: 'image center', x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { name: 'image upper center', x: box.x + box.width / 2, y: box.y + box.height * 0.25 },
    { name: 'image lower center', x: box.x + box.width / 2, y: box.y + box.height * 0.75 },
    { name: 'card center', x: box.x + box.width / 2, y: box.y + box.height + 28 },
    { name: 'card upper left', x: box.x + 16, y: box.y + 16 },
    { name: 'card upper right', x: box.x + box.width - 16, y: box.y + 16 },
    { name: 'fixed first result center', x: 365, y: 279 },
    { name: 'fixed first result top', x: 365, y: 238 },
    { name: 'fixed first result label', x: 365, y: 316 },
  ];

  for (const parent of result.target.parentBoxes || []) {
    coordinateCandidates.push({
      name: `parent depth ${parent.depth} center`,
      x: parent.box.x + parent.box.width / 2,
      y: parent.box.y + parent.box.height / 2,
    });
    coordinateCandidates.push({
      name: `parent depth ${parent.depth} upper left`,
      x: parent.box.x + 18,
      y: parent.box.y + 18,
    });
  }

  for (const candidate of coordinateCandidates) {
    console.log('[DEBUG] media coordinate candidate click:', { targetAdName, candidate });
    await page.mouse.click(candidate.x, candidate.y);
    await page.waitForTimeout(5000);
    if (await isOneMediaSelected(page)) {
      console.log('[STEP] media selected by coordinate candidate:', { targetAdName, candidate });
      return true;
    }
  }

  console.log('[WARN] visible media simple click did not confirm selection:', { targetAdName });
  return false;
}

async function clickMediaResultByNameSpanAndImage(page, targetAdName) {
  const nameSpanSelector = 'span.x1vvvo52.xw23nyj.xo1l8bm.x63nzvj.xbsr9hj.xq9mrsl.x1h4wwuj.xeuugli';
  const requestedContainerSelector = 'div.x6s0dn4.x78zum5.xdt5ytf.x1a2a7pz.x13oubkp.x1ypdohk.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8';
  await page.waitForTimeout(7000);

  const result = await page.evaluate(({ selector, target, containerSelector }) => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const targetNormalized = normalize(target);
    const unpaddedTarget = target.replace(/_(0)(\d)$/, '_$2');
    const unpaddedNormalized = normalize(unpaddedTarget);
    const allSpans = [...document.querySelectorAll(selector)].filter((span) => visible(span));
    let spans = allSpans.filter((span) => {
      const text = normalize(span.textContent);
      return text.includes(targetNormalized) || text.includes(unpaddedNormalized);
    });

    if (!spans.length) {
      spans = allSpans.filter((span) => normalize(span.textContent).includes('f_i_o_l_'));
    }

    const scrollAreas = [...document.querySelectorAll('.uiScrollableArea.fade.uiScrollableAreaWithShadow, .uiScrollableArea')]
      .filter((area) => visible(area));

    const candidates = spans.map((span, index) => {
      let root = span.closest(containerSelector) || span.closest('.uiScrollableArea, .uiScrollableAreaContent') || span;
      for (let depth = 0; root?.parentElement && depth < 8; depth += 1) {
        if (root.querySelector('button, div._5f0d, img._5i4g, img, [role="checkbox"], input[type="checkbox"]')) break;
        root = root.parentElement;
      }

      const button = root?.querySelector('button, [role="button"]') || null;
      const image = root?.querySelector('div._5f0d, img._5i4g, img') || null;
      const checkbox = root?.querySelector('[role="checkbox"], input[type="checkbox"]') || null;
      const clickTarget = button || image || checkbox || root || span;
      const box = clickTarget.getBoundingClientRect();
      const rootBox = (root || span).getBoundingClientRect();
      return {
        index,
        text: (span.textContent || '').trim(),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        rootBox: { x: rootBox.x, y: rootBox.y, width: rootBox.width, height: rootBox.height },
        hasButton: Boolean(button),
        hasImage: Boolean(image),
        hasCheckbox: Boolean(checkbox),
      };
    }).filter((candidate) => candidate.box.width > 10 && candidate.box.height > 10);

    candidates.sort((a, b) => (b.box.x - a.box.x) || (a.box.y - b.box.y));
    return {
      found: candidates.length > 0,
      candidate: candidates[0] || null,
      count: candidates.length,
      visibleSpanCount: allSpans.length,
      scrollAreaCount: scrollAreas.length,
      usedFallback: !allSpans.some((span) => {
        const text = normalize(span.textContent);
        return text.includes(targetNormalized) || text.includes(unpaddedNormalized);
      }),
    };
  }, {
    selector: nameSpanSelector,
    target: targetAdName,
    containerSelector: requestedContainerSelector,
  }).catch((error) => ({ found: false, error: error.message }));

  console.log('[DEBUG] filename span based media candidate:', { targetAdName, result });
  if (!result.found || !result.candidate) return false;

  const { box } = result.candidate;
  await page.waitForTimeout(5000);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(7000);

  if (!(await isOneMediaSelected(page))) {
    const rootBox = result.candidate.rootBox;
    if (rootBox) {
      await page.waitForTimeout(5000);
      await page.mouse.click(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2);
      await page.waitForTimeout(7000);
    }
  }

  if (!(await isOneMediaSelected(page))) {
    await page.waitForTimeout(5000);
    const forced = await page.evaluate(({ selector, target, containerSelector }) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const normalize = (value) => String(value || '').replace(/\s+/g, '');
      const targetNormalized = normalize(target);
      const unpaddedTarget = target.replace(/_(0)(\d)$/, '_$2');
      const unpaddedNormalized = normalize(unpaddedTarget);
      let spans = [...document.querySelectorAll(selector)]
        .filter((item) => visible(item) && (
          normalize(item.textContent).includes(targetNormalized) ||
          normalize(item.textContent).includes(unpaddedNormalized)
        ));
      if (!spans.length) {
        spans = [...document.querySelectorAll(selector)]
          .filter((item) => visible(item) && normalize(item.textContent).includes('f_i_o_l_'));
      }
      const span = spans
        .sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0];
      if (!span) return { ok: false, reason: 'name span not found' };

      let root = span.closest(containerSelector) || span.closest('.uiScrollableArea, .uiScrollableAreaContent') || span;
      for (let depth = 0; root?.parentElement && depth < 8; depth += 1) {
        if (root.querySelector('button, div._5f0d, img._5i4g, img, [role="checkbox"], input[type="checkbox"]')) break;
        root = root.parentElement;
      }

      const clickTarget = root?.querySelector('button, [role="button"]') ||
        root?.querySelector('div._5f0d, img._5i4g, img') ||
        root?.querySelector('[role="checkbox"], input[type="checkbox"]') ||
        span.closest('[role="checkbox"], label, [role="button"]') ||
        root ||
        span;
      clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
      clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return {
        ok: true,
        tagName: clickTarget.tagName,
        className: clickTarget.getAttribute('class') || '',
        text: (span.textContent || '').trim(),
      };
    }, {
      selector: nameSpanSelector,
      target: targetAdName,
      containerSelector: requestedContainerSelector,
    }).catch((error) => ({ ok: false, reason: error.message }));
    console.log('[DEBUG] filename span media DOM forced click result:', { targetAdName, forced });
    await page.waitForTimeout(7000);
  }

  await waitForOneMediaSelected(page, targetAdName);
  console.log('[STEP] filename span media selected:', { targetAdName });
  return true;
}

async function clickMediaCandidateAndVerifySelected(page, locator, targetAdName, name) {
  const visible = await locator.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) return false;

  await locator.scrollIntoViewIfNeeded().catch(() => null);
  await page.waitForTimeout(5000);
  const box = await locator.boundingBox().catch(() => null);
  console.log('[DEBUG] named media candidate:', { targetAdName, name, box });
  if (!box) return false;

  await locator.click({ force: true }).catch(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
  await page.waitForTimeout(7000);
  await waitForOneMediaSelected(page, targetAdName);
  console.log('[STEP] named media candidate selected:', { targetAdName, name });
  return true;
}

async function clickRightmostMediaTileAndVerifySelected(page, selector, targetAdName) {
  const candidates = await page.locator(selector).evaluateAll((tiles) => {
    return tiles
      .map((tile, index) => {
        const rect = tile.getBoundingClientRect();
        const style = window.getComputedStyle(tile);
        const visible = rect.width > 20 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
        return {
          index,
          visible,
          box: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          text: (tile.textContent || '').trim().slice(0, 120),
        };
      })
      .filter((candidate) => candidate.visible);
  }).catch(() => []);

  if (!candidates.length) return false;

  candidates.sort((a, b) => (b.box.x - a.box.x) || (a.box.y - b.box.y));
  const chosen = candidates[0];
  console.log('[DEBUG] rightmost media tile candidate:', {
    targetAdName,
    chosenIndex: chosen.index,
    chosenBox: chosen.box,
    candidateCount: candidates.length,
  });

  await page.waitForTimeout(5000);
  await page.mouse.click(chosen.box.x + chosen.box.width / 2, chosen.box.y + chosen.box.height / 2);
  await page.waitForTimeout(7000);

  const selectedAfterMouse = await isOneMediaSelected(page);
  if (!selectedAfterMouse) {
    const forced = await page.locator(selector).nth(chosen.index).evaluate((tile) => {
      const clickable = tile.closest('[role="checkbox"], label, [role="button"]') ||
        tile.querySelector('[role="checkbox"], input[type="checkbox"], [role="button"], label') ||
        tile;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return {
        tagName: clickable.tagName,
        role: clickable.getAttribute?.('role') || '',
        text: (clickable.textContent || '').trim().slice(0, 120),
      };
    }).catch((error) => ({ error: error.message }));
    console.log('[DEBUG] media tile DOM forced click result:', { targetAdName, forced });
    await page.waitForTimeout(7000);
  }

  await waitForOneMediaSelected(page, targetAdName);
  console.log('[STEP] right-side media library item selected:', { targetAdName });
  return true;
}

async function clickMediaPickerButton(page, buttonText, attemptLabel, dataSurfacePart = '') {
  const labelGroups = {
    다음: ['다음', 'Next'],
    완료: ['완료', 'Done'],
    저장: ['저장', 'Save'],
    '건너뛰고 계속하기': ['건너뛰고 계속하기', '건너뛰고 계속', 'Skip and continue', 'Skip and Continue'],
  };
  const labels = labelGroups[buttonText] || [buttonText];
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const exactPattern = new RegExp(`^\\s*(?:${escapedLabels.join('|')})\\s*$`, 'i');
  const containsPattern = new RegExp(`(?:${escapedLabels.join('|')})`, 'i');

  const totalAttempts = WAIT_CONFIG.baseRetryCount + WAIT_CONFIG.extendedRetryCount;
  console.log('[STEP] media picker button search started:', {
    buttonText,
    attemptLabel,
    labels,
    baseRetryCount: WAIT_CONFIG.baseRetryCount,
    extendedRetryCount: WAIT_CONFIG.extendedRetryCount,
  });

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const extended = attempt > WAIT_CONFIG.baseRetryCount;
    if (attempt === WAIT_CONFIG.baseRetryCount + 1) {
      console.log('[WAIT] media picker button switching to extended wait:', {
        buttonText,
        attemptLabel,
        attemptedLabels: labels,
        extendedRetryIntervalMs: WAIT_CONFIG.extendedRetryIntervalMs,
      });
    }
    const candidates = [
      {
        name: `${buttonText} data-surface exact`,
        locator: dataSurfacePart
          ? page
            .locator(`button[data-surface*="${dataSurfacePart}"], [role="button"][aria-busy="false"][data-surface*="${dataSurfacePart}"]`)
            .filter({ hasText: exactPattern })
            .first()
          : page.locator('__never_matches__').first(),
      },
      {
        name: `${buttonText} role button exact`,
        locator: page.getByRole('button', { name: exactPattern }).first(),
      },
      {
        name: `${buttonText} button contains`,
        locator: page.locator('button, [role="button"]').filter({ hasText: containsPattern }).first(),
      },
      {
        name: `${buttonText} text ancestor button`,
        locator: page
          .getByText(containsPattern)
          .locator('xpath=ancestor-or-self::*[@role="button" or self::button][1]')
          .first(),
      },
      {
        name: `${buttonText} primary data-surface fallback`,
        locator: dataSurfacePart
          ? page.locator(`button[data-surface*="${dataSurfacePart}"], [role="button"][data-surface*="${dataSurfacePart}"]`).last()
          : page.locator('__never_matches__').first(),
      },
    ];

    for (const candidate of candidates) {
      const visible = await candidate.locator.isVisible({ timeout: extended ? WAIT_CONFIG.extendedRetryIntervalMs : WAIT_CONFIG.baseRetryIntervalMs }).catch(() => false);
      if (!visible) continue;

      const disabled = await candidate.locator.evaluate((el) => (
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.hasAttribute('disabled') ||
        el.closest('[aria-disabled="true"], [aria-busy="true"]')
      )).catch(() => false);
      if (disabled) continue;

      await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
      await page.waitForTimeout(500);
      const box = await candidate.locator.boundingBox().catch(() => null);
      const text = await candidate.locator.innerText().catch(() => '');
      console.log('[DEBUG] media picker button candidate:', {
        buttonText,
        attemptLabel,
        attempt,
        name: candidate.name,
        text,
        box,
      });
      if (!box) continue;

      await candidate.locator.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(1200);
      console.log('[STEP] media picker button clicked:', { buttonText, attemptLabel, candidate: candidate.name });
      return true;
    }

    const domFallback = await page.evaluate(({ labels: buttonLabels, dataSurfacePart: surfacePart }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
      const normalizedLabels = buttonLabels.map(normalize);
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (el) => (
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.hasAttribute('disabled') ||
        Boolean(el.closest('[aria-disabled="true"], [aria-busy="true"]'))
      );
      const elements = [...document.querySelectorAll('button, [role="button"], div[tabindex="0"]')]
        .filter((el) => isVisible(el) && !disabled(el))
        .map((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          const aria = el.getAttribute('aria-label') || '';
          const surface = el.getAttribute('data-surface') || '';
          const normalizedText = normalize(`${text} ${aria}`);
          const exact = normalizedLabels.some((label) => normalizedText === label);
          const contains = normalizedLabels.some((label) => normalizedText.includes(label));
          const surfaceMatch = surfacePart && surface.includes(surfacePart);
          const rect = el.getBoundingClientRect();
          return {
            el,
            text,
            aria,
            surface,
            exact,
            contains,
            surfaceMatch,
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        })
        .filter((item) => item.exact || item.contains || item.surfaceMatch)
        .sort((a, b) => {
          const aScore = (a.exact ? 0 : a.contains ? 1 : 2);
          const bScore = (b.exact ? 0 : b.contains ? 1 : 2);
          return aScore - bScore || b.box.y - a.box.y || b.box.x - a.box.x;
        });

      const chosen = elements[0];
      if (!chosen) {
        return {
          clicked: false,
          candidates: elements.slice(0, 8).map(({ text, aria, surface, box }) => ({ text, aria, surface, box })),
        };
      }
      chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
      chosen.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      chosen.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      chosen.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return {
        clicked: true,
        text: chosen.text,
        aria: chosen.aria,
        surface: chosen.surface,
        box: chosen.box,
      };
    }, { labels, dataSurfacePart }).catch((error) => ({ clicked: false, error: error.message }));

    console.log('[DEBUG] media picker DOM button fallback:', {
      buttonText,
      attemptLabel,
      attempt,
      domFallback,
    });
    if (domFallback.clicked) {
      await page.waitForTimeout(1200);
      console.log('[STEP] media picker button clicked by DOM fallback:', { buttonText, attemptLabel });
      return true;
    }

    console.log('[WAIT] media picker button retry:', {
      buttonText,
      attemptLabel,
      attempt,
      attemptedLabels: labels,
      nextWaitMs: extended ? WAIT_CONFIG.extendedRetryIntervalMs : WAIT_CONFIG.baseRetryIntervalMs,
    });
    await page.waitForTimeout(extended ? WAIT_CONFIG.extendedRetryIntervalMs : WAIT_CONFIG.baseRetryIntervalMs);
  }

  await debugDump(page, `media picker button not found ${buttonText} ${attemptLabel}`);
  return false;
}

async function clickMediaPickerNextButton(page, attemptLabel) {
  return clickMediaPickerButton(page, '다음', attemptLabel, 'ads-omp-primary-button');
}

async function clickOptionalMediaPickerNextButton(page, attemptLabel, timeoutMs = 5000) {
  const labels = ['다음', 'Next'];
  const exactPattern = /^\s*(?:다음|Next)\s*$/i;
  const candidates = [
    page.getByRole('button', { name: exactPattern }).first(),
    page.locator('button, [role="button"]').filter({ hasText: exactPattern }).first(),
  ];

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const locator of candidates) {
      const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;
      const disabled = await locator.evaluate((el) => (
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.hasAttribute('disabled') ||
        Boolean(el.closest('[aria-disabled="true"], [aria-busy="true"]'))
      )).catch(() => false);
      if (disabled) continue;

      const text = await locator.innerText().catch(() => '');
      const box = await locator.boundingBox().catch(() => null);
      console.log('[DEBUG] optional media picker next candidate:', {
        attemptLabel,
        labels,
        text,
        box,
      });
      await locator.scrollIntoViewIfNeeded().catch(() => null);
      await locator.click({ force: true }).catch(async () => {
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(1500);
      console.log('[STEP] optional media picker next clicked:', { attemptLabel, text });
      return true;
    }
    await page.waitForTimeout(500);
  }

  console.log('[DEBUG] optional media picker next not visible:', { attemptLabel, timeoutMs });
  return false;
}

async function clickOptionalMediaPickerButton(page, buttonText, attemptLabel, timeoutMs = 5000) {
  const labelGroups = {
    다음: ['다음', 'Next'],
    완료: ['완료', 'Done'],
    '건너뛰고 계속하기': ['건너뛰고 계속하기', '건너뛰고 계속', 'Skip and continue', 'Skip and Continue'],
  };
  const labels = labelGroups[buttonText] || [buttonText];
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const exactPattern = new RegExp(`^\\s*(?:${escapedLabels.join('|')})\\s*$`, 'i');
  const containsPattern = new RegExp(`(?:${escapedLabels.join('|')})`, 'i');
  const candidates = [
    page.getByRole('button', { name: exactPattern }).first(),
    page.locator('button, [role="button"]').filter({ hasText: exactPattern }).first(),
    page.locator('button, [role="button"]').filter({ hasText: containsPattern }).first(),
  ];

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const locator of candidates) {
      const visible = await locator.isVisible({ timeout: 800 }).catch(() => false);
      if (!visible) continue;
      const disabled = await locator.evaluate((el) => (
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.hasAttribute('disabled') ||
        Boolean(el.closest('[aria-disabled="true"], [aria-busy="true"]'))
      )).catch(() => false);
      if (disabled) continue;

      const box = await locator.boundingBox().catch(() => null);
      const text = await locator.innerText().catch(() => '');
      await locator.scrollIntoViewIfNeeded().catch(() => null);
      await locator.click({ force: true }).catch(async () => {
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(1200);
      console.log('[STEP] optional media picker button clicked:', { buttonText, attemptLabel, text });
      return true;
    }
    await page.waitForTimeout(400);
  }
  console.log('[DEBUG] optional media picker button not visible:', { buttonText, attemptLabel, timeoutMs });
  return false;
}

async function clickMediaPickerDoneButton(page, attemptLabel) {
  return clickMediaPickerButton(page, '완료', attemptLabel, 'ads-omp-primary-button');
}

async function clickMediaPickerSkipAndContinueButton(page, attemptLabel) {
  const exactClicked = await clickMediaPickerButton(page, '건너뛰고 계속하기', attemptLabel, 'ads-omp-primary-button');
  if (exactClicked) return true;

  const candidates = [
    page.getByRole('button', { name: /건너뛰고\s*계속/i }).first(),
    page.getByText(/건너뛰고\s*계속/i).first(),
    page.locator('[role="button"]').filter({ hasText: /건너뛰고\s*계속/i }).first(),
  ];

  for (const locator of candidates) {
    const visible = await locator.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => null);
    await locator.click({ force: true }).catch(async () => {
      const box = await locator.boundingBox().catch(() => null);
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(1000);
    console.log('[STEP] skip and continue button clicked:', { attemptLabel });
    return true;
  }

  return false;
}

async function selectAllOriginalRadios(page) {
  let selectedCount = 0;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const originalRadios = await page.locator('input[type="radio"][value="original"][aria-checked="false"], input[type="radio"][value="original"]:not(:checked)').elementHandles().catch(() => []);
    if (!originalRadios.length) break;

    for (const radio of originalRadios) {
      const visible = await radio.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await radio.boundingBox().catch(() => null);
      if (!box) continue;
      await radio.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      selectedCount += 1;
      await page.waitForTimeout(200);
    }
  }
  console.log('[STEP] original radio selection completed:', { selectedCount });
  return selectedCount;
}

async function getOriginalRadioStatus(page) {
  return page
    .locator('input[type="radio"][value="original"]')
    .evaluateAll((radios) => radios.map((radio) => ({
      checked: radio.checked || radio.getAttribute('aria-checked') === 'true',
      name: radio.getAttribute('name') || '',
      ariaLabel: radio.getAttribute('aria-label') || '',
    })))
    .catch(() => []);
}

async function completeFlexibleMediaPickerFlow(page, adFormat = 'image') {
  const selectedNext = await clickMediaPickerNextButton(page, `${adFormat}-after-media-select`);
  if (!selectedNext) {
    await debugDump(page, `next button not found after ${adFormat} media select`);
    throw new Error(`Could not find the Next button after selecting ${adFormat} media.`);
  }

  for (let step = 1; step <= 7; step += 1) {
    await page.waitForTimeout(step === 1 ? 1000 : 500);
    const selectedOriginalCount = await selectAllOriginalRadios(page);
    if (selectedOriginalCount) {
      const originalStatus = await getOriginalRadioStatus(page);
      console.log('[STEP] media picker original ratio selection status:', {
        adFormat,
        step,
        total: originalStatus.length,
        checked: originalStatus.filter((radio) => radio.checked).length,
      });
    }

    const skipped = await clickOptionalMediaPickerButton(page, '건너뛰고 계속하기', `${adFormat}-flex-step-${step}-skip`, 2500);
    if (skipped) {
      console.log('[STEP] media picker skip/continue completed:', { adFormat, step });
      continue;
    }

    const doneClicked = await clickOptionalMediaPickerButton(page, '완료', `${adFormat}-flex-step-${step}-done`, 2500);
    if (doneClicked) {
      await page.waitForTimeout(4000);
      console.log('[STEP] flexible media picker flow completed:', { adFormat, step });
      return;
    }

    const nextClicked = await clickOptionalMediaPickerNextButton(page, `${adFormat}-flex-step-${step}-next`, 3000);
    if (nextClicked) {
      console.log('[STEP] flexible media picker next completed:', { adFormat, step });
      continue;
    }

    console.log('[WAIT] flexible media picker step did not expose next/done/skip yet:', { adFormat, step });
    await page.waitForTimeout(WAIT_CONFIG.baseRetryIntervalMs);
  }

  await debugDump(page, `flexible media picker flow did not finish ${adFormat}`);
  throw new Error(`Could not complete the ${adFormat} media picker flow.`);
}

async function completeVideoMediaPickerFlow(page) {
  await completeFlexibleMediaPickerFlow(page, 'video');
}

async function completeMediaPickerNextAndOriginalFlow(page, adFormat = 'image') {
  await completeFlexibleMediaPickerFlow(page, adFormat);
}

async function fillLandingUrlOnly(page, targetAdName, landingUrl = '') {
  const targetUrl = landingUrl || buildRepurelyLandingUrl(targetAdName);

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    console.log(`[STEP] landing URL input search attempt ${attempt}/6`);
    const landingInput = page
      .locator('input[placeholder="http://www.example.com/page"], input[placeholder*="example.com/page"]')
      .or(page.getByLabel(/웹사이트 URL|website url/i))
      .or(page.getByPlaceholder(/웹사이트 URL|website url/i))
      .first();

    const landingVisible = await landingInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (landingVisible) {
      console.log('[STEP] landing URL input started:', { targetAdName, targetUrl });
      const landingInputHandle = await landingInput.elementHandle();
      const filled = await fastFillInputHandle(page, landingInputHandle, targetUrl, 'landing URL', {
        verify: 'exact',
        timeoutMs: 2500,
        typeDelay: 5,
      });
      if (!filled.ok) {
        throw new Error(`Landing URL fill failed: expected=${targetUrl}, actual=${filled.actual}`);
      }
      console.log('[STEP] landing URL input completed:', { targetAdName, targetUrl, actualUrl: filled.actual, method: filled.method });
      return;
    }

    // Scroll to expose the URL section when it is not visible on the current screen.
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(2500);

    if (attempt === 3) {
      console.log('[WARN] 랜딩 URL input 미감지 - 크리에이티브 설정 재진입 후 재시도');
      await openCreativeSettingsAndFillLandingUrl(page, targetAdName, targetUrl, AD_FORMAT);
      return;
    }
  }

  throw new Error('Landing URL input not found.');
}

async function openCreativeSettingsAndFillLandingUrl(page, targetAdName, landingUrl = '', adFormat = AD_FORMAT) {
  const creativeAdPattern = getCreativeFormatPattern(adFormat);
  const creativeAdTab = page.locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2').filter({ hasText: creativeAdPattern }).first();
  const uploadButton = page.locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli').filter({ hasText: /^업로드/ }).first();

  let creativeOpened = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    console.log(`[STEP] creative settings entry attempt ${attempt}/10`);
    const clickedSettings = await clickCreativeSettingsEntry(page, attempt);
    if (!clickedSettings) {
      console.log(`[WAIT] creative/media settings button search retry ${attempt}/10`);
      await page.waitForTimeout(5000);
      continue;
    }

    await page.waitForTimeout(7000);

    const openedByCreativeAdMode = await creativeAdTab.isVisible({ timeout: 5000 }).catch(() => false);
    const openedByUpload = await uploadButton.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('[DEBUG] creative settings opened check:', { adFormat, openedByCreativeAdMode, openedByUpload });

    if (openedByCreativeAdMode || openedByUpload) {
      creativeOpened = true;
      console.log('[STEP] creative settings opened successfully');
      break;
    }

    console.log(`[WAIT] creative settings opened check retry ${attempt}/10`);
    await page.waitForTimeout(5000);
  }

  if (!creativeOpened) {
    await debugDump(page, 'creative settings not opened after retries');
    throw new Error('Failed to open creative settings: image/video ad upload area not detected.');
  }

  console.log('[STEP] creative settings opened - selecting ad mode from env');
  await selectCreativeAdModeWithRequestedClasses(page, adFormat);
  await advanceFromMediaSettingsToUploadIfNeeded(page, adFormat);
  await page.waitForTimeout(4000);

  const targetUrl = landingUrl || `https://repurely.com/surl/P/100?utm_source=f&utm_medium=f&utm_campaign=${getLandingCampaignName(targetAdName)}`;
  const landingInput = page.locator('input[placeholder="http://www.example.com/page"]').first();
  const landingVisible = await landingInput.isVisible({ timeout: 10000 }).catch(() => false);
  if (landingVisible) {
    console.log('[STEP] landing URL input started after creative settings:', { targetAdName, targetUrl });
    const landingInputHandle = await landingInput.elementHandle();
    const filled = await fastFillInputHandle(page, landingInputHandle, targetUrl, 'landing URL after creative settings', {
      verify: 'exact',
      timeoutMs: 2500,
      typeDelay: 5,
    });
    if (!filled.ok) {
      throw new Error(`Landing URL fill failed after creative settings: expected=${targetUrl}, actual=${filled.actual}`);
    }
    console.log('[STEP] landing URL input completed after creative settings:', { targetAdName, targetUrl, actualUrl: filled.actual, method: filled.method });
  } else {
    throw new Error('Landing URL input not found after creative settings.');
  }
}


async function enterCreativeInsideEditor(page, adFormat = AD_FORMAT) {
  console.log('[STEP] creative internal entry started:', { adFormat, label: getCreativeFormatLabel(adFormat) });

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    console.log(`[STEP] 크리에이티브/미디어 설정 버튼 클릭 시도 ${attempt}/10`);
    const clickedSettings = await clickCreativeSettingsEntry(page, attempt);
    if (!clickedSettings) {
      console.log(`[WAIT] 크리에이티브/미디어 설정 버튼 대기 ${attempt}/10`);
      await page.waitForTimeout(5000);
      continue;
    }
    await page.waitForTimeout(6000);

    const creativeFormatVisible = await page.getByText(getCreativeFormatPattern(adFormat)).first().isVisible({ timeout: 5000 }).catch(() => false);
    const uploadVisible = await isCreativeUploadVisible(page);
    console.log('[DEBUG] creative settings click exposed ad mode:', { attempt, adFormat, creativeFormatVisible, uploadVisible });
    if (uploadVisible && !creativeFormatVisible) {
      console.log('[STEP] creative/media settings opened directly at upload step:', { adFormat });
      return;
    }
    if (creativeFormatVisible) {
      await selectCreativeAdModeWithRequestedClasses(page, adFormat);
      await advanceFromMediaSettingsToUploadIfNeeded(page, adFormat);
      await page.waitForTimeout(4000);
      console.log('[STEP] creative settings -> ad mode entry completed:', { adFormat });
      return;
    }
  }

  await debugDump(page, 'creative settings button did not expose image ad button');
  throw new Error('크리에이티브 설정 버튼 클릭 후 광고 형식 버튼을 찾지 못했습니다.');
}

async function fillAdNameAndVerify(page, adNameInput, targetAdName) {
  let actualAdName = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await adNameInput.scrollIntoViewIfNeeded().catch(() => null);
    const adNameInputHandle = await adNameInput.elementHandle();
    const filled = await fastFillInputHandle(page, adNameInputHandle, targetAdName, 'ad name', {
      timeoutMs: attempt <= 2 ? 2500 : WAIT_CONFIG.extendedRetryIntervalMs,
      typeDelay: 10,
    });
    actualAdName = filled.actual;
    console.log('[DEBUG] ad name input check:', { attempt, targetAdName, actualAdName, method: filled.method });
    if (filled.ok) {
      console.log('[STEP] ad name changed:', { targetAdName, actualAdName, attempt, method: filled.method });
      return actualAdName;
    }

    console.log('[WARN] ad name input verification retry:', {
      attempt,
      targetAdName,
      actualAdName,
      nextWaitMs: attempt <= 2 ? 6000 : WAIT_CONFIG.extendedRetryIntervalMs,
    });
    await adNameInput.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, targetAdName).catch(() => null);
    await page.waitForTimeout(3000);
    actualAdName = await adNameInput.inputValue().catch(() => '');
    if (actualAdName.includes(targetAdName)) {
      console.log('[STEP] ad name changed by DOM fallback:', { targetAdName, actualAdName, attempt });
      return actualAdName;
    }
  }

  throw new Error(`Ad name input verification failed: expected=${targetAdName}, actual=${actualAdName}`);
}

async function findResumeAdsetBoundsFromRows(rows, adsetName) {
  if (!adsetName) return null;
  const target = normalizeText(adsetName);
  const rowInfos = [];
  for (const row of rows) {
    const rowText = (await row.innerText().catch(() => '')).trim();
    const box = await row.boundingBox().catch(() => null);
    if (!rowText || !box) continue;
    const rowMeta = await row.evaluate((el) => {
      const rowHeader = el.matches?.('[role="rowheader"]') ? el : el.querySelector?.('[role="rowheader"]');
      const surface = el.closest?.('[data-surface]') || el.querySelector?.('[data-surface]');
      return {
        ariaLabel: el.getAttribute('aria-label') || rowHeader?.getAttribute('aria-label') || '',
        surface: surface?.getAttribute('data-surface') || '',
      };
    }).catch(() => ({ ariaLabel: '', surface: '' }));
    const normalizedText = normalizeText(rowText);
    const isAdset = normalizeText(rowMeta.ariaLabel).includes('광고세트') ||
      rowMeta.surface.includes('editor_tree:adset') ||
      normalizedText.includes('광고세트');
    rowInfos.push({ rowText, normalizedText, box, isAdset });
  }

  const sorted = rowInfos.sort((a, b) => a.box.y - b.box.y);
  const targetIndex = sorted.findIndex((row) => row.isAdset && row.normalizedText.includes(target));
  if (targetIndex < 0) return null;
  const targetRow = sorted[targetIndex];
  const nextAdset = sorted.slice(targetIndex + 1).find((row) => row.isAdset && row.box.y > targetRow.box.y + 2);
  return {
    top: targetRow.box.y,
    bottom: nextAdset ? nextAdset.box.y : Number.POSITIVE_INFINITY,
    rowText: targetRow.rowText,
  };
}

async function renameAdsetsAndAdsSequentially(page, adsetStartIndex = 1, adsetCount = 10, adCreativeCount = 5, options = {}) {
  console.log('[STEP] sequential adset/ad rename started');

  let adCreativeIndex = getResumeAdCreativeStartIndex();
  if (adCreativeIndex > 1) {
    console.log('[STEP] resume mode enabled - starting ad rename from creative index:', {
      adCreativeIndex,
      RESUME_FROM_AD_INDEX: getEffectiveResumeAdIndex(),
      RESUME_FROM_AD_NAME: getEffectiveResumeAdName(),
    });
  }
  const effectiveAdsetCount = adsetCount + 1;
  const effectiveCreativeCount = adCreativeCount + 1;
  const adsetEndIndex = adsetStartIndex + effectiveAdsetCount - 1;
  const maxCreativeTotal = effectiveAdsetCount * effectiveCreativeCount;
  const resumeOnly = Boolean(options.resumeOnly);
  const resumeTargetAdsetName = String(options.resumeTargetAdsetName || '').trim();
  const resumeTargetPlanAdset = resumeOnly && resumeTargetAdsetName
    ? (activeCampaignPlan?.adsets || []).find((adset) => normalizeText(adset.name || '') === normalizeText(resumeTargetAdsetName))
    : null;
  const resumeStopCreativeIndex = resumeTargetPlanAdset?.ads?.length
    ? Math.max(...resumeTargetPlanAdset.ads.map((ad) => Number(ad.index || 0)).filter(Boolean))
    : maxCreativeTotal;
  const effectiveMaxCreativeTotal = resumeOnly ? resumeStopCreativeIndex : maxCreativeTotal;
  const totalRenameTarget = (effectiveAdsetCount * effectiveCreativeCount) + effectiveAdsetCount;
  let adsetIndex = resumeOnly ? adsetEndIndex + 1 : adsetStartIndex;
  const maxRenameAttempts = resumeOnly
    ? Math.max(40, ((effectiveMaxCreativeTotal - adCreativeIndex) + 1) * 3 + 12)
    : Math.max(totalRenameTarget * 3 + 20, 60);
  const processedAdsetRows = new Set();
  const processedAdRows = new Set();
  const plannedAdNames = new Set(
    (activeCampaignPlan?.adsets || [])
      .flatMap((adset) => adset.ads || [])
      .map((ad) => normalizeText(ad.name || ''))
      .filter(Boolean),
  );

  for (let attempt = 1; attempt <= maxRenameAttempts; attempt += 1) {
    await page.waitForTimeout(resumeOnly ? 1500 : 2500);
    let progressedThisAttempt = false;

    const rows = await page.locator('[role="row"]').elementHandles();
    if (!rows.length) {
      console.log(`[WAIT] rows not visible yet retry ${attempt}/${maxRenameAttempts}`);
      continue;
    }
    const resumeAdsetBounds = resumeOnly && resumeTargetAdsetName
      ? await findResumeAdsetBoundsFromRows(rows, resumeTargetAdsetName)
      : null;
    if (resumeOnly && resumeTargetAdsetName && !resumeAdsetBounds) {
      console.log('[WAIT] resume target adset bounds not visible yet:', { resumeTargetAdsetName, attempt });
      await scrollCampaignStructureTree(page, attempt <= 6 ? 450 : 900);
      await page.mouse.wheel(0, attempt <= 6 ? 180 : 320).catch(() => null);
      await page.waitForTimeout(attempt <= 6 ? 1500 : 3000);
      continue;
    }
    if (resumeAdsetBounds) {
      console.log('[DEBUG] resume target adset bounds:', {
        resumeTargetAdsetName,
        top: resumeAdsetBounds.top,
        bottom: Number.isFinite(resumeAdsetBounds.bottom) ? resumeAdsetBounds.bottom : 'end',
        rowText: resumeAdsetBounds.rowText.slice(0, 140),
      });
    }

    const orderedRows = (await Promise.all(rows.map(async (row) => {
      const box = await row.boundingBox().catch(() => null);
      return box ? { row, box } : null;
    })))
      .filter(Boolean)
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
      .map((item) => item.row);

    let visibleAdsetOrdinal = 0;
    for (const row of orderedRows) {
      const rowText = (await row.innerText().catch(() => '')).trim();
      if (!rowText) continue;

      const rowBox = await row.boundingBox().catch(() => null);
      if (!rowBox) continue;
      if (resumeAdsetBounds && (rowBox.y <= resumeAdsetBounds.top + 2 || rowBox.y >= resumeAdsetBounds.bottom - 2)) {
        continue;
      }

      const rowId = await row
        .evaluate((el) => el.getAttribute('data-id') || el.id || el.querySelector('[data-id]')?.getAttribute('data-id') || '')
        .catch(() => '');
      const rowMeta = await row.evaluate((el) => {
        const rowHeader = el.matches?.('[role="rowheader"]') ? el : el.querySelector?.('[role="rowheader"]');
        const surface = el.closest?.('[data-surface]') || el.querySelector?.('[data-surface]');
        return {
          ariaLabel: el.getAttribute('aria-label') || rowHeader?.getAttribute('aria-label') || '',
          objectType: el.getAttribute('data-objecttype') || rowHeader?.getAttribute('data-objecttype') || '',
          surface: surface?.getAttribute('data-surface') || '',
        };
      }).catch(() => ({ ariaLabel: '', objectType: '', surface: '' }));
      const rowKey = rowId || `${Math.round(rowBox.x)}:${Math.round(rowBox.y)}:${rowText.slice(0, 80)}`;
      const primaryNameText = await row.evaluate((el) => {
        const nameCell = el.querySelector('[id^="default-button-for-action-menu_"] span._3dfi._3dfj, [id^="default-button-for-action-menu_"], span._3dfi._3dfj');
        return (nameCell?.innerText || nameCell?.textContent || '').trim();
      }).catch(() => '');
      const targetAdsetName = adsetIndex <= adsetEndIndex
        ? (isBlogCampaign()
          ? buildBlogAdsetName(adsetIndex, process.env)
          : (isVideoOnlyCampaign()
            ? buildVideoOnlyAdsetName(adsetIndex, process.env)
            : (isVideoOnlyCboCampaign()
              ? buildVideoOnlyCboAdsetName(adsetIndex, process.env)
              : (isImageOnlyCboCampaign() ? buildImageOnlyCboAdsetName(adsetIndex, process.env) : getAdsetName(adsetIndex)))))
        : '';
      const normalizedRowText = normalizeText(rowText);
      const normalizedPrimaryNameText = normalizeText(primaryNameText || rowText);
      const isAdsetStructureRow =
        normalizeText(rowMeta.ariaLabel).includes('광고세트') ||
        rowMeta.surface.includes('editor_tree:adset') ||
        /새\s*판매\s*광고\s*세트/.test(normalizedRowText) ||
        /광고\s*세트/.test(normalizedRowText) ||
        normalizedRowText.includes('광고세트');
      if (isAdsetStructureRow) visibleAdsetOrdinal += 1;
      const isAdStructureRow =
        !isAdsetStructureRow &&
        (
          normalizeText(rowMeta.ariaLabel) === '광고' ||
          rowMeta.surface.includes('editor_tree:ad') ||
          /새\s*판매\s*광고(?!\s*세트)/.test(normalizedRowText) ||
          /광고\s*-\s*사본/.test(normalizedRowText) ||
          normalizedRowText.includes('광고명')
        );
      const isAlreadyTargetAdset = targetAdsetName && normalizedPrimaryNameText.includes(normalizeText(targetAdsetName));
      const isDefaultAdsetRow = isAdsetStructureRow && /새\s*판매\s*광고\s*세트/.test(normalizedPrimaryNameText || normalizedRowText);
      const isAdsetCopy = isAdsetStructureRow && /사본|copy/i.test(primaryNameText || rowText);
      const isAdRowCopy = /사본|copy/i.test(rowText);
      const isDefaultAdRow = /새\s*판매\s*광고(?!\s*세트)/.test(normalizedRowText) || /광고\s*-\s*사본/.test(normalizedRowText);
      const hasPlannedAdName = [...plannedAdNames].some((name) => name && normalizedRowText.includes(name));
      const currentBlogAdPlan = isBlogCampaign() ? getBlogAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
      const currentVideoAdPlan = isVideoOnlyCampaign() ? getVideoOnlyAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
      const currentVideoCboAdPlan = isVideoOnlyCboCampaign() ? getVideoOnlyCboAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
      const currentImageCboAdPlan = isImageOnlyCboCampaign() ? getImageOnlyCboAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
      const currentTargetPlan = currentBlogAdPlan || currentVideoAdPlan || currentVideoCboAdPlan || currentImageCboAdPlan;
      const currentTargetPlanAdsetIndex = Number(currentTargetPlan?.adsetIndex || 0);
      const currentTargetAdName = normalizeText(currentTargetPlan?.name || getAdName(adCreativeIndex));
      const isCurrentTargetAdRow = isAdStructureRow && currentTargetAdName && normalizedRowText.includes(currentTargetAdName);
      const isAdCopy = isAdStructureRow && (isDefaultAdRow || isAdRowCopy || !hasPlannedAdName || isCurrentTargetAdRow);
      const adsetDisplayName = primaryNameText || rowText;
      const isBlogAdsetNameRow = isBlogCampaign() && isAdsetStructureRow && /f_[iv]_b?_?o_l_\d{4}_\d+/i.test(adsetDisplayName);
      const isBlogAdsetCopyRow = isBlogAdsetNameRow && /사본|copy/i.test(adsetDisplayName);
      const isImageOnlyAdsetNameRow = !isBlogCampaign() && isAdsetStructureRow && /\d{4}\s+리타겟\s+\d+번\s+광고\s*세트/i.test(adsetDisplayName);
      const isVideoOnlyAdsetNameRow = isVideoOnlyCampaign() && isAdsetStructureRow && /\d{4}\s+직접세팅\s+광고\s*세트\s*-\s*\d+/i.test(adsetDisplayName);
      const isVideoOnlyCboAdsetNameRow = isVideoOnlyCboCampaign() && isAdsetStructureRow && /\d{4}\s+CBO\s+광고\s*세트\s*-\s*\d+/i.test(adsetDisplayName);
      const isImageOnlyCboAdsetNameRow = isImageOnlyCboCampaign() && isAdsetStructureRow && /\d{4}\s+CBO\s+광고\s*세트\s*-\s*\d+/i.test(adsetDisplayName);
      const shouldRenameAdsetRow = (isDefaultAdsetRow || isAdsetCopy || isBlogAdsetNameRow || isVideoOnlyAdsetNameRow || isVideoOnlyCboAdsetNameRow || isImageOnlyCboAdsetNameRow) && adsetIndex <= adsetEndIndex;
      const parsedAdsetIndex = isAdsetStructureRow
        ? parseAdsetIndexFromDisplayName(adsetDisplayName, effectiveCreativeCount)
        : null;

      if (isAdsetStructureRow) {
        console.log('[DEBUG] visible adset row index:', {
          visibleAdsetOrdinal,
          parsedAdsetIndex,
          currentTargetAdsetIndex: adsetIndex,
          targetAdsetName,
          rowKey,
          displayName: adsetDisplayName.slice(0, 140),
        });
      }

      if (
        resumeOnly &&
        isAdsetStructureRow &&
        parsedAdsetIndex &&
        parsedAdsetIndex < adsetIndex &&
        !isAdsetCopy &&
        !isBlogAdsetCopyRow &&
        !isDefaultAdsetRow
      ) {
        processedAdsetRows.add(rowKey);
        console.log('[DEBUG] earlier adset row skipped without advancing target index:', {
          parsedAdsetIndex,
          currentTargetAdsetIndex: adsetIndex,
          rowKey,
          displayName: adsetDisplayName.slice(0, 140),
        });
        continue;
      }

      if (
        resumeOnly &&
        isAdsetStructureRow &&
        parsedAdsetIndex &&
        parsedAdsetIndex > adsetIndex &&
        !isAdsetCopy &&
        !isDefaultAdsetRow
      ) {
        console.log('[DEBUG] later adset row deferred until target index catches up:', {
          parsedAdsetIndex,
          currentTargetAdsetIndex: adsetIndex,
          rowKey,
          displayName: adsetDisplayName.slice(0, 140),
        });
        continue;
      }

      if (processedAdsetRows.has(rowKey) && (isAdsetStructureRow || rowText.includes(ADSET_BASE_NAME) || isBlogAdsetNameRow)) {
        console.log('[DEBUG] already processed adset row skipped:', { rowKey, rowText: rowText.slice(0, 120) });
        continue;
      }

      if (isAdStructureRow && hasPlannedAdName && !isAdRowCopy && !isCurrentTargetAdRow) {
        processedAdRows.add(rowKey);
        console.log('[DEBUG] already named ad row skipped:', { rowKey, rowText: rowText.slice(0, 120) });
        continue;
      }

      if (processedAdRows.has(rowKey) && isAdStructureRow) {
        console.log('[DEBUG] already processed ad row skipped:', { rowKey, rowText: rowText.slice(0, 120) });
        continue;
      }

      if (isAlreadyTargetAdset && !isAdsetCopy && !isBlogAdsetCopyRow && adsetIndex <= adsetEndIndex) {
        processedAdsetRows.add(rowKey);
        console.log('[STEP] adset name already changed - moving to next adset:', { targetAdsetName, rowKey });
        adsetIndex += 1;
        progressedThisAttempt = true;
        continue;
      }

      if (isImageOnlyAdsetNameRow && adsetIndex <= adsetEndIndex && (!parsedAdsetIndex || parsedAdsetIndex === adsetIndex)) {
        processedAdsetRows.add(rowKey);
        console.log('[STEP] image retarget adset name preserved:', {
          currentName: adsetDisplayName,
          targetAdsetName,
          rowKey,
        });
        adsetIndex += 1;
        progressedThisAttempt = true;
        continue;
      }

      if (shouldRenameAdsetRow) {
        const nameCell = await row
          .$('[id^="default-button-for-action-menu_"], span._3dfi._3dfj')
          .catch(() => null);
        const nameCellBox = await nameCell?.boundingBox().catch(() => null);
        if (nameCellBox) {
          console.log('[DEBUG] adset name cell click:', {
            targetAdsetName,
            rowText: rowText.slice(0, 160),
            nameCellBox,
          });
          await page.mouse.click(nameCellBox.x + Math.min(nameCellBox.width / 2, 180), nameCellBox.y + nameCellBox.height / 2);
        } else {
          console.log('[DEBUG] adset row fallback click:', {
            targetAdsetName,
            rowText: rowText.slice(0, 160),
            rowBox,
          });
          await page.mouse.click(rowBox.x + Math.min(rowBox.width / 2, 220), rowBox.y + rowBox.height / 2);
        }
        await page.waitForTimeout(4000);

        const directAdsetInput = page.locator('input[placeholder="여기에 광고 세트 이름을 입력하세요..."], input[placeholder="광고 세트 이름 지정"]').first();
        const directVisible = await directAdsetInput.isVisible({ timeout: 5000 }).catch(() => false);
        const adsetInputHandle = directVisible
          ? await directAdsetInput.elementHandle()
          : await findVideoCboAdsetNameInputHandle(page, targetAdsetName);
        if (adsetInputHandle) {
          let filled = await fastFillInputHandle(page, adsetInputHandle, targetAdsetName, 'sequential adset name', {
            timeoutMs: 2500,
            typeDelay: 10,
          });
          let actualAdsetName = filled.actual;
          if (!filled.ok) {
            console.log('[DEBUG] adset rename keyboard fill mismatch - applying DOM fallback:', {
              targetAdsetName,
              actualAdsetName,
            });
            await adsetInputHandle.evaluate((el, value) => {
              el.focus();
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, targetAdsetName);
            await page.waitForTimeout(1500);
            actualAdsetName = await adsetInputHandle.evaluate((el) => el.value || '').catch(() => '');
          }
          console.log('[STEP] adset name changed:', { targetAdsetName, actualAdsetName, method: filled.method });
          if (!actualAdsetName.includes(targetAdsetName)) {
            throw new Error(`광고세트명 입력 확인 실패: expected=${targetAdsetName}, actual=${actualAdsetName}`);
          }
          processedAdsetRows.add(rowKey);
          adsetIndex += 1;
          progressedThisAttempt = true;
          continue;
        }
        console.log('[WARN] adset row clicked but adset name input not visible:', {
          targetAdsetName,
          rowText: rowText.slice(0, 160),
          rowMeta,
        });
        continue;
      }

      if (
        isAdStructureRow &&
        !resumeOnly &&
        currentTargetPlanAdsetIndex > 0 &&
        adsetIndex <= currentTargetPlanAdsetIndex &&
        adsetIndex <= adsetEndIndex
      ) {
        console.log('[DEBUG] ad row deferred until its adset name is handled:', {
          adCreativeIndex,
          currentTargetPlanAdsetIndex,
          currentTargetAdName: currentTargetPlan?.name || getAdName(adCreativeIndex),
          currentAdsetRenameIndex: adsetIndex,
          rowText: rowText.slice(0, 140),
        });
        continue;
      }

      if (isAdCopy && adCreativeIndex <= maxCreativeTotal) {
        const adNameCell = await row
          .$('[id^="default-button-for-action-menu_"], span._3dfi._3dfj')
          .catch(() => null);
        const adNameCellBox = await adNameCell?.boundingBox().catch(() => null);
        if (adNameCellBox) {
          console.log('[DEBUG] ad name cell click:', {
            adCreativeIndex,
            rowText: rowText.slice(0, 160),
            adNameCellBox,
          });
          await page.mouse.click(adNameCellBox.x + Math.min(adNameCellBox.width / 2, 180), adNameCellBox.y + adNameCellBox.height / 2);
        } else {
          await page.mouse.click(rowBox.x + Math.min(rowBox.width / 2, 220), rowBox.y + rowBox.height / 2);
        }
        await page.waitForTimeout(4000);

        const adNameInput = page.locator('input[placeholder="여기에 광고 이름을 입력하세요..."], input[placeholder*="광고 이름"], input[value*="새 판매 광고"]').first();
        const visible = await adNameInput.isVisible({ timeout: 5000 }).catch(() => false);
        if (!visible) continue;

        const blogAdPlan = isBlogCampaign() ? getBlogAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
        const videoAdPlan = isVideoOnlyCampaign() ? getVideoOnlyAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
        const videoCboAdPlan = isVideoOnlyCboCampaign() ? getVideoOnlyCboAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
        const imageCboAdPlan = isImageOnlyCboCampaign() ? getImageOnlyCboAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
        if (isBlogCampaign() && !blogAdPlan) {
          throw new Error(`${CAMPAIGN_MODE} ad plan not found for creative sequence ${adCreativeIndex}`);
        }
        if (isVideoOnlyCampaign() && !videoAdPlan) {
          throw new Error(`VIDEO_ONLY ad plan not found for creative sequence ${adCreativeIndex}`);
        }
        if (isVideoOnlyCboCampaign() && !videoCboAdPlan) {
          throw new Error(`VIDEO_ONLY_CBO ad plan not found for creative sequence ${adCreativeIndex}`);
        }
        if (isImageOnlyCboCampaign() && !imageCboAdPlan) {
          throw new Error(`IMAGE_ONLY_CBO ad plan not found for creative sequence ${adCreativeIndex}`);
        }
        const targetPlan = blogAdPlan || videoAdPlan || videoCboAdPlan || imageCboAdPlan;
        const targetAdName = targetPlan?.name || getAdName(adCreativeIndex);
        const targetLandingUrl = targetPlan?.landingUrl || '';
        const targetAdFormat = targetPlan?.type || AD_FORMAT;
        const targetAssetPath = targetPlan?.assetPath || '';
        updateRunContext({
          current_step: 'edit_ad',
          current_ad_index: adCreativeIndex,
          current_ad_name: targetAdName,
          current_landing_url: targetLandingUrl,
          current_video_file: targetAdFormat === 'video' ? targetAssetPath : '',
        });

        await timedStep('input_ad_name', targetAdName, () => fillAdNameAndVerify(page, adNameInput, targetAdName));

        console.log('[STEP] ad creative plan:', {
          campaignMode: CAMPAIGN_MODE,
          adsetIndex: targetPlan?.adsetIndex,
          adsetName: targetPlan?.adsetName,
          adType: targetAdFormat,
          targetAdName,
          targetLandingUrl,
          targetAssetPath,
        });

        await timedStep('input_url', targetAdName, () => fillLandingUrlOnly(page, targetAdName, targetLandingUrl));
        await page.waitForTimeout(targetAdFormat === 'video' ? 3000 : 2000);
        console.log('[STEP] landing URL step completed and stabilized:', { targetAdName });

        await timedStep('open_creative_settings', targetAdName, () => enterCreativeInsideEditor(page, targetAdFormat));
        await page.waitForTimeout(getCreativeStabilizeWaitMs(targetAdFormat));
        console.log('[STEP] creative format step completed:', { targetAdName, targetAdFormat });

        if (isBlogCampaign() || isVideoOnlyCampaign() || isCboCampaign()) {
          await page.waitForTimeout(getMediaPreUploadWaitMs(targetAdFormat));
          await timedStep(targetAdFormat === 'video' ? 'upload_video' : 'upload_image', targetAdName, () => attachMediaFromFolderIfConfigured(page, targetAdName, [targetAssetPath], targetAdFormat));
          console.log('[STEP] planned media upload completed:', {
            campaignMode: CAMPAIGN_MODE,
            targetAdName,
            targetAdFormat,
            targetAssetPath,
          });
        } else if (isPerAdImageOnlyUploadMode(process.env)) {
          const imageAssetPath = getImageOnlyAssetBySequence(imageOnlyPerAdAssets, adCreativeIndex);
          if (!imageAssetPath) {
            throw new Error(`IMAGE_ONLY per-ad image asset not found for ad sequence ${adCreativeIndex}.`);
          }
          await page.waitForTimeout(getMediaPreUploadWaitMs('image'));
          await timedStep('upload_image', targetAdName, () => attachMediaFromFolderIfConfigured(page, targetAdName, [imageAssetPath], 'image'));
          console.log('[STEP] IMAGE_ONLY PER_AD media upload completed:', {
            targetAdName,
            targetAssetPath: imageAssetPath,
          });
        } else if (adCreativeIndex === 1 && !firstCreativeMediaUploaded) {
          await page.waitForTimeout(getMediaPreUploadWaitMs(AD_FORMAT));
          await timedStep('upload_media', targetAdName, () => attachMediaFromFolderIfConfigured(page, targetAdName));
          firstCreativeMediaUploaded = true;
          console.log('[STEP] first ad media upload completed');
        } else {
          await page.waitForTimeout(getMediaPreUploadWaitMs(AD_FORMAT));
          await timedStep('select_existing_media', targetAdName, () => searchAndSelectExistingMedia(page, targetAdName));
          console.log('[STEP] existing uploaded media selected:', { targetAdName });
        }

        await page.waitForTimeout(getMediaPostUploadWaitMs(targetAdFormat));
        console.log('[STEP] ad media handling completed - waiting before next ad search:', { targetAdName });

        processedAdRows.add(rowKey);
        adCreativeIndex += 1;
        progressedThisAttempt = true;
      }
    }

    console.log('[DEBUG] sequential rename progress:', {
      adsetIndex,
      adsetEndIndex,
      adCreativeIndex,
      maxCreativeTotal,
      effectiveMaxCreativeTotal,
      effectiveAdsetCount,
      adCreativeCount,
      effectiveCreativeCount,
      totalRenameTarget,
    });

    if (resumeOnly && adCreativeIndex > effectiveMaxCreativeTotal) {
      console.log('[STEP] resume sequential ad rename completed after all target ads were processed:', {
        adCreativeIndex,
        effectiveMaxCreativeTotal,
        adsetIndex,
        adsetEndIndex,
      });
      return true;
    }

    if (!resumeOnly && adCreativeIndex > effectiveMaxCreativeTotal && adsetIndex >= adsetEndIndex) {
      console.log('[STEP] sequential rename completed after all ads and final adset target were reached:', {
        adCreativeIndex,
        effectiveMaxCreativeTotal,
        adsetIndex,
        adsetEndIndex,
        totalRenameTarget,
      });
      return true;
    }

    if (adsetIndex > adsetEndIndex && adCreativeIndex > effectiveMaxCreativeTotal) {
      console.log('[STEP] sequential adset/ad rename completed');
      return true;
    }

    console.log(`[WAIT] sequential rename retry ${attempt}/${maxRenameAttempts}`, { progressedThisAttempt });
    await page.mouse.wheel(0, progressedThisAttempt ? 250 : 700);
    await page.waitForTimeout(3000);
  }

  await safeScreenshot(page, path.join(DIRS.screenshots, 'adset-ad-rename-sequence-failed.png'), 'adset ad rename failed');
  throw new Error('Sequential adset/ad rename failed.');
}


async function runCreativeStepOnly(page) {
  console.log('[STEP] QUICK_TEST_CREATIVE_STEP=true - running creative step only');
  await openCreativeSettingsAndFillLandingUrl(page, QUICK_TEST_AD_NAME);
  if (!firstCreativeMediaUploaded) {
    if (isVideoOnlyCampaign()) {
      if (!videoOnlyAssets.length) {
        videoOnlyAssets = await getVideoOnlyAssets(process.env, { baseDir: process.cwd() });
      }
      const videoAssetPath = getVideoOnlyAssetBySequence(videoOnlyAssets, 1);
      if (!videoAssetPath) throw new Error('VIDEO_ONLY video asset not found for quick creative test.');
      await attachMediaFromFolderIfConfigured(page, QUICK_TEST_AD_NAME, [videoAssetPath], 'video');
    } else if (isPerAdImageOnlyUploadMode(process.env)) {
      if (!imageOnlyPerAdAssets.length) {
        imageOnlyPerAdAssets = await getImageOnlyAssets(process.env, { baseDir: process.cwd() });
      }
      const imageAssetPath = getImageOnlyAssetBySequence(imageOnlyPerAdAssets, 1);
      if (!imageAssetPath) throw new Error('IMAGE_ONLY per-ad image asset not found for quick creative test.');
      await attachMediaFromFolderIfConfigured(page, QUICK_TEST_AD_NAME, [imageAssetPath], 'image');
    } else {
      await attachMediaFromFolderIfConfigured(page, QUICK_TEST_AD_NAME);
    }
    firstCreativeMediaUploaded = true;
  }
  await safeScreenshot(page, path.join(DIRS.screenshots, 'quick-creative-step-done.png'), 'quick creative step done');
}

async function runFlow(page) {
  updateRunContext({ current_step: 'start_flow' });
  if (QUICK_TEST_CREATIVE_STEP) {
    updateRunContext({ current_step: 'quick_creative_step' });
    await runCreativeStepOnly(page);
    return;
  }

  updateRunContext({ current_step: 'ads_manager_open' });
  console.log('[STEP] Ads Manager 접속');
  await timedStep('open_ads_manager', CAMPAIGN_NAME, () => page.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'domcontentloaded' }));
  await timedStep('check_login', CAMPAIGN_NAME, () => ensureLoggedInOrThrow(page));
  await safeScreenshot(page, PATHS.step1, 'page screenshot');

  console.log(`[STEP] 광고계정 이동: act=${AD_ACCOUNT_ID}`);
  await timedStep('open_ad_account', CAMPAIGN_NAME, () => page.goto(`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT_ID}`, { waitUntil: 'domcontentloaded' }));
  await timedStep('ensure_campaign_tab', CAMPAIGN_NAME, () => ensureCampaignTab(page));
  console.log('[DEBUG] URL:', page.url());
  console.log('[DEBUG] TITLE:', await page.title());
  await safeScreenshot(page, PATHS.step2, 'page screenshot');

  const resumeMode = isResumeModeEnabled();
  if (isCboCampaign() && !resumeMode) {
    updateRunContext({ current_step: 'cbo_campaign_create' });
    console.log(`[STEP] ${CAMPAIGN_MODE} campaign creation mode`);
    await timedStep('click_create_campaign', CAMPAIGN_NAME, () => clickRealCreateButton(page));
    videoOnlyCboInitialCreateClicked = true;
    await safeScreenshot(page, PATHS.step5, 'page screenshot');
    await timedStep('select_sales_objective', CAMPAIGN_NAME, () => selectSalesObjective(page));
    await timedStep('click_continue', CAMPAIGN_NAME, () => clickCampaignContinueButton(page));
    await timedStep('fill_campaign_name', activeCampaignPlan.campaignName, () => fillCampaignName(page, activeCampaignPlan.campaignName));
    await timedStep('fill_campaign_budget', activeCampaignPlan.campaignName, () => fillCampaignBudget(page, activeCampaignPlan.rawCampaignBudget));
    await safeScreenshot(page, path.join(DIRS.screenshots, 'cbo-campaign-name-budget-filled.png'), 'cbo campaign name budget filled');
  } else {
    if (isCboCampaign() && resumeMode) {
      console.log('[STEP] CBO resume mode - opening existing campaign instead of creating a new campaign');
    }
    await timedStep('search_campaign', CAMPAIGN_NAME, () => trySearchBox(page, CAMPAIGN_NAME));
    const campaignTarget = await timedStep('find_campaign', CAMPAIGN_NAME, () => findCampaignTarget(page, CAMPAIGN_NAME));
    if (!campaignTarget) {
      await logCampaignCandidates(page, 10);
      throw new Error(`CAMPAIGN_NAME partial match 실패: ${CAMPAIGN_NAME}`);
    }

    await timedStep('open_campaign', CAMPAIGN_NAME, () => campaignTarget.click());
    await safeScreenshot(page, PATHS.step3, 'page screenshot');
    await page.waitForLoadState('domcontentloaded');
    await safeScreenshot(page, PATHS.step4, 'page screenshot');
  }

  if (isResumeModeEnabled()) {
    const resumeStartIndex = getResumeAdCreativeStartIndex();
    const resumeTargetAdset = getPlanAdsetForCreativeIndex(resumeStartIndex);
    const resumeByAdNameOnly = Boolean(getEffectiveResumeAdName());
    const adCreativeDuplicateCount = isBlogCampaign()
      ? Math.max((activeCampaignPlan?.totalAdsPerAdset || 5) - 1, 0)
      : ((isVideoOnlyCampaign() || isCboCampaign()) ? Math.max((activeCampaignPlan?.totalAdsPerAdset || AD_CREATIVE_COUNT + 1) - 1, 0) : Math.max(AD_CREATIVE_COUNT, 0));
    const adsetDuplicateCount = isBlogCampaign()
      ? Math.max((activeCampaignPlan?.adsetCount || ADSET_COUNT) - 1, 0)
      : ((isVideoOnlyCampaign() || isCboCampaign()) ? Math.max((activeCampaignPlan?.adsetCount || ADSET_COUNT + 1) - 1, 0) : Math.max(ADSET_COUNT, 0));
    console.log('[STEP] resume mode - skipping create/schedule/duplicate steps and resuming ad edit:', {
      resumeStartIndex,
      RESUME_FROM_AD_INDEX: getEffectiveResumeAdIndex(),
      RESUME_FROM_AD_NAME: getEffectiveResumeAdName(),
      targetAdsetName: resumeTargetAdset?.name || '',
      targetAdsetIndex: resumeTargetAdset?.index || '',
      resumeByAdNameOnly,
      adCreativeDuplicateCount,
      adsetDuplicateCount,
    });
    if (resumeTargetAdset?.name && !resumeByAdNameOnly) {
      updateRunContext({
        current_step: 'resume_select_adset',
        current_adset_index: resumeTargetAdset.index,
        current_adset_name: resumeTargetAdset.name,
      });
      await timedStep('resume_select_adset', resumeTargetAdset.name, () => selectExistingAdsetRowByName(page, resumeTargetAdset.name));
    } else if (resumeByAdNameOnly) {
      updateRunContext({
        current_step: 'resume_find_ad_by_name',
        current_adset_index: resumeTargetAdset?.index || 0,
        current_adset_name: resumeTargetAdset?.name || '',
        current_ad_index: resumeStartIndex,
        current_ad_name: getEffectiveResumeAdName(),
      });
      console.log('[STEP] resume by ad name only - reopening editor and selecting exact ad row:', {
        resumeAdName: getEffectiveResumeAdName(),
        resumeStartIndex,
        targetAdsetName: resumeTargetAdset?.name || '',
      });
      await timedStep('resume_open_editor_tree', getEffectiveResumeAdName(), () => ensureCampaignEditorOpenForResume(page, getEffectiveResumeAdName()));
      await timedStep('resume_select_ad_by_name', getEffectiveResumeAdName(), () => selectExistingAdRowByName(page, getEffectiveResumeAdName()));
    }
    updateRunContext({ current_step: 'resume_rename_ads_and_upload_media' });
    await timedStep('resume_rename_ads_and_upload_media', getEffectiveResumeAdName() || `ad_${resumeStartIndex}`, () => renameAdsetsAndAdsSequentially(page, (isBlogCampaign() || isVideoOnlyCampaign() || isCboCampaign()) ? 1 : ADSET_START_INDEX, adsetDuplicateCount, adCreativeDuplicateCount, {
      resumeOnly: true,
      resumeTargetAdsetName: resumeByAdNameOnly ? '' : (resumeTargetAdset?.name || ''),
    }));
    updateRunContext({ current_step: 'success' });
    return;
  }

  for (let n = 0; n < 1; n += 1) {
    const index = (isBlogCampaign() || isVideoOnlyCampaign() || isCboCampaign()) ? n + 1 : ADSET_START_INDEX + n;
    const adsetName = isBlogCampaign()
      ? buildBlogAdsetName(index, process.env)
      : (isVideoOnlyCampaign()
        ? buildVideoOnlyAdsetName(index, process.env)
        : (isVideoOnlyCboCampaign()
          ? buildVideoOnlyCboAdsetName(index, process.env)
          : (isImageOnlyCboCampaign() ? buildImageOnlyCboAdsetName(index, process.env) : getAdsetName(index))));
    console.log(`[STEP] ${n + 1}/1 광고 세트 생성 시작: ${adsetName}`);
    updateRunContext({
      current_step: 'adset_select_name_schedule',
      current_adset_index: index,
      current_adset_name: adsetName,
    });

    if (!isCboCampaign()) {
      await timedStep('click_create_adset', adsetName, () => clickRealCreateButton(page));
      await pause(page, '만들기 버튼 클릭 후 대기', 3000);
      await safeScreenshot(page, PATHS.step5, 'page screenshot');
    }
    await timedStep('enter_adset_flow', adsetName, () => enterAdsetFlow(page));
    await pause(page, '광고 세트 생성 화면 진입 후 대기', 3000);
    await safeScreenshot(page, PATHS.step6, 'page screenshot');

    if (isCboCampaign()) {
      console.log('[STEP] CBO adset selected after campaign budget; fill adset name then schedule');
    }
    await timedStep('fill_adset_name', adsetName, () => fillAdsetNameInAdsetModalOnly(page, adsetName));

    const scheduleReady = await timedStep('schedule_adset', adsetName, () => updateDateAndTimeBeforeContinue(page));
    if (!scheduleReady) {
      throw new Error('스케줄링 영역 확인 실패: 날짜 input을 찾지 못했습니다.');
    }
    if (!isCboCampaign()) {
      await timedStep('fill_adset_budget', adsetName, () => fillAdsetDailyBudgetAfterSchedule(page));
    } else {
      console.log('[STEP] CBO keeps campaign budget unchanged; adset budget fill skipped');
    }

    const adCreativeDuplicateCount = isBlogCampaign()
      ? Math.max((activeCampaignPlan?.totalAdsPerAdset || 5) - 1, 0)
      : ((isVideoOnlyCampaign() || isCboCampaign()) ? Math.max((activeCampaignPlan?.totalAdsPerAdset || AD_CREATIVE_COUNT + 1) - 1, 0) : Math.max(AD_CREATIVE_COUNT, 0));
    if (adCreativeDuplicateCount > 0) {
      updateRunContext({ current_step: 'duplicate_ads' });
      await pause(page, '스케줄링 후 새 판매 광고 복제 설정 전 대기', 5000);
      await timedStep('duplicate_ads', adsetName, () => setDuplicateCount(page, adCreativeDuplicateCount, '새 판매 광고'));
      await pause(page, '새 판매 광고 복제 설정 후 대기', 7000);
    }

    const adsetDuplicateCount = isBlogCampaign()
      ? Math.max((activeCampaignPlan?.adsetCount || ADSET_COUNT) - 1, 0)
      : ((isVideoOnlyCampaign() || isCboCampaign()) ? Math.max((activeCampaignPlan?.adsetCount || ADSET_COUNT + 1) - 1, 0) : Math.max(ADSET_COUNT, 0));
    if (adsetDuplicateCount > 0) {
      updateRunContext({ current_step: 'duplicate_adsets' });
      await pause(page, '스케줄링 후 광고세트 복제 설정 전 대기', 5000);
      await timedStep('duplicate_adsets', adsetName, () => setDuplicateCount(page, adsetDuplicateCount, adsetName));
      await pause(page, '광고세트 복제 설정 후 대기', 7000);
    }

    if (n === 0) {
      updateRunContext({ current_step: 'rename_ads_and_upload_media' });
      await timedStep('rename_ads_and_upload_media', adsetName, () => renameAdsetsAndAdsSequentially(page, (isBlogCampaign() || isVideoOnlyCampaign() || isCboCampaign()) ? 1 : ADSET_START_INDEX, adsetDuplicateCount, adCreativeDuplicateCount));
    }

  }

  updateRunContext({ current_step: 'success' });

}

async function runFlowWithAutoResume(page) {
  const maxAttempts = AUTO_RESUME_RECOVERABLE_ERRORS ? Math.max(AUTO_RESUME_MAX_ATTEMPTS, 0) : 0;
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 0) {
        console.log('[AUTO-RESUME] restarting flow from saved ad point:', {
          attempt,
          maxAttempts,
          resumeAdIndex: getEffectiveResumeAdIndex(),
          resumeAdName: getEffectiveResumeAdName(),
          waitMs: AUTO_RESUME_WAIT_MS,
        });
        updateRunContext({ current_step: 'auto_resume_restart', auto_resume_attempt: attempt });
        await page.waitForTimeout(AUTO_RESUME_WAIT_MS);
      }
      await runFlow(page);
      return;
    } catch (error) {
      const canRetry = attempt < maxAttempts && isRecoverableAutomationError(error);
      if (!canRetry || !activateRuntimeResumeFromContext(error, attempt + 1)) {
        throw error;
      }
      console.warn('[AUTO-RESUME] recoverable run failed; retrying from failed ad instead of stopping:', {
        attempt: attempt + 1,
        maxAttempts,
        resumeAdIndex: getEffectiveResumeAdIndex(),
        resumeAdName: getEffectiveResumeAdName(),
      });
    }
  }
}

async function main() {
  let browser = null;
  let status = 'success';
  let summaryLogPath = '';
  let context = null;
  let tracePath = '';
  let traceStarted = false;
  let caughtError = null;

  try {
    updateRunContext({ current_step: 'validate_config' });
    const validation = await timedStep('validate_config', CAMPAIGN_NAME, async () => {
      validateEnv();
      return validateCampaignConfig(process.env, { baseDir: process.cwd() });
    });
    activeCampaignPlan = validation.plan;
    updateRunContext({
      campaign_mode: validation.mode,
      campaign_name: activeCampaignPlan?.campaignName || CAMPAIGN_NAME,
      created_campaign_count: [CAMPAIGN_MODES.VIDEO_ONLY_CBO, CAMPAIGN_MODES.IMAGE_ONLY_CBO].includes(validation.mode) ? 1 : 0,
      created_adset_count: getPlanAdsetCount(),
      created_ad_count: getPlanAdCount(),
    });
    if (validation.mode === CAMPAIGN_MODES.IMAGE_ONLY && activeCampaignPlan?.uploadMode === 'PER_AD') {
      imageOnlyPerAdAssets = activeCampaignPlan.imageAssets || [];
    }
    if (validation.mode === CAMPAIGN_MODES.VIDEO_ONLY || validation.mode === CAMPAIGN_MODES.VIDEO_ONLY_CBO) {
      videoOnlyAssets = activeCampaignPlan.videoAssets || [];
    }
    console.log('[CONFIG] campaign mode:', validation.mode);
    if (imageOnlyPerAdAssets.length) {
      console.log('[CONFIG] image-only upload mode: PER_AD');
      console.log('[CONFIG] image-only per-ad asset count:', imageOnlyPerAdAssets.length);
    }

    if (DRY_RUN) {
      updateRunContext({ current_step: 'dry_run' });
      if ([CAMPAIGN_MODES.BLOG_MIXED, CAMPAIGN_MODES.BLOG_VIDEO, CAMPAIGN_MODES.BLOG_VIDEO_DIRECT, CAMPAIGN_MODES.VIDEO_ONLY, CAMPAIGN_MODES.VIDEO_ONLY_CBO, CAMPAIGN_MODES.IMAGE_ONLY_CBO].includes(validation.mode)) {
        console.log(formatDryRunPlan(activeCampaignPlan));
      } else if (activeCampaignPlan?.uploadMode === 'PER_AD') {
        console.log('[DRY RUN] Meta Ads Automation plan');
        console.log(`campaign mode: ${validation.mode}`);
        console.log(`campaign name: ${CAMPAIGN_NAME}`);
        console.log('image upload mode: PER_AD');
        console.log(`adset count: ${activeCampaignPlan.adsetCount}`);
        console.log(`image ads per adset: ${activeCampaignPlan.creativeCount}`);
        console.log(`total image ads: ${activeCampaignPlan.totalAds}`);
        activeCampaignPlan.imageAssets.forEach((asset, index) => {
          console.log(`- image ad sequence ${index + 1}: ${asset}`);
        });
      } else {
        console.log('[DRY RUN] Meta Ads Automation plan');
        console.log(`campaign mode: ${validation.mode}`);
        console.log(`campaign name: ${CAMPAIGN_NAME}`);
        console.log(`adset start index: ${ADSET_START_INDEX}`);
        console.log(`adset duplicate count: ${ADSET_COUNT}`);
        console.log(`ad creative duplicate count: ${AD_CREATIVE_COUNT}`);
        console.log('Meta browser automation skipped because DRY_RUN=true.');
      }
      summaryLogPath = await writeRunSummaryLog('dry_run_success');
      return;
    }

    await ensureDirs();
    updateRunContext({ current_step: 'connect_chrome' });
    console.log(`[OPEN] attaching to existing Chrome session via CDP: ${CDP_URL}`);
    browser = await timedStep('connect_chrome', CAMPAIGN_NAME, () => chromium.connectOverCDP(CDP_URL));

    context = browser.contexts()[0];
    if (!context) throw new Error('연결된 Chrome context가 없습니다.');
    const page = context.pages()[0] ?? (await context.newPage());
    installWaitForTimeoutProfiler(page);
    await fs.mkdir(path.resolve('logs'), { recursive: true });
    tracePath = path.resolve('logs', `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).then(() => {
      traceStarted = true;
      console.log('[TRACE] playwright tracing started:', tracePath);
    }).catch((error) => console.warn('[WARN] trace start failed:', error.message));
    await timedStep('run_flow', CAMPAIGN_NAME, () => runFlowWithAutoResume(page));

    summaryLogPath = await writeRunSummaryLog('success');
    await notifySuccess(
      '🚀세팅 완료했습니다 !',
      `Campaign: ${runContext.campaign_name}\nAdsets: ${runContext.created_adset_count}\nAds: ${runContext.created_ad_count}\nLog: ${summaryLogPath}`,
    );
  } catch (error) {
    caughtError = error;
    status = classifyAutomationError(error);
    console.error('[OPEN] 실행 실패:', error);

    summaryLogPath = await writeRunSummaryLog(status, error).catch((logError) => {
      console.warn('[WARN] run summary log failed:', logError.message);
      return '';
    });
    const detail = buildNotificationDetail({
      error_message: error.message,
      summary_log: summaryLogPath,
    });
    const reason = summarizeErrorReason(error);
    if (status === 'video_upload_timeout') {
      await notifyVideoUploadTimeout('🚨 오류가 발생했습니다!', `원인: 영상 업로드가 제한 시간 안에 완료되지 않았습니다.\n${detail}`);
    } else if (status === 'stop') {
      await notifyStop('🚨 오류가 발생했습니다!', `원인: 입력값 검증 또는 안전 제한으로 작업이 중단되었습니다.\n${detail}`);
    } else {
      await notifyError('🚨 오류가 발생했습니다!', `원인: ${reason}\n${detail}`);
    }
    throw error;
  } finally {
    if (traceStarted && context) {
      await context.tracing.stop({ path: tracePath }).then(() => {
        console.log('[TRACE] playwright trace saved:', tracePath);
      }).catch((error) => {
        console.warn('[WARN] trace stop failed:', error.message);
        tracePath = '';
      });
    }
    await writePerformanceReport(status, tracePath, caughtError).catch((error) => {
      console.warn('[WARN] performance report failed:', error.message);
    });
    if (browser) await browser.close().catch(() => null);
  }
}

main().catch((error) => {
  console.error('[FATAL ERROR]', error);
  process.exit(1);
});


