import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const JOB_DIR = process.env.LOCAL_JOB_DIR;
const JOB_ID = process.env.LOCAL_JOB_ID || path.basename(JOB_DIR || 'job');
const PROFILE_ROOT = process.env.LOCAL_PROFILE_ROOT || 'C:\\meta_profiles';
const PROFILE_ID = process.env.LOCAL_PROFILE_ID || 'profile_01';
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID || '';
const ADS_MANAGER_URL = process.env.ADS_MANAGER_URL || 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
const SLOW_MO_MS = Number(process.env.SLOW_MO_MS || 120);
const DRY_RUN = String(process.env.JOB_RUNNER_DRY_RUN || '').toLowerCase() === 'true';

const WAIT = {
  baseRetryCount: Number(process.env.WAIT_BASE_RETRY_COUNT || 5),
  baseRetryIntervalMs: Number(process.env.WAIT_BASE_RETRY_INTERVAL_MS || 1500),
  extendedRetryCount: Number(process.env.WAIT_EXTENDED_RETRY_COUNT || 5),
  extendedRetryIntervalMs: Number(process.env.WAIT_EXTENDED_RETRY_INTERVAL_MS || 7000),
  videoUploadTimeoutMs: Number(process.env.VIDEO_UPLOAD_TIMEOUT_MS || 120000),
  videoFallbackWaitMs: Number(process.env.VIDEO_UPLOAD_FALLBACK_WAIT_MS || 60000),
};

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi']);

if (!JOB_DIR) {
  throw new Error('LOCAL_JOB_DIR is required.');
}

const PATHS = {
  mappingCache: path.join(JOB_DIR, 'mapping.cache.json'),
  images: path.join(JOB_DIR, 'images'),
  state: path.join(JOB_DIR, 'job_state.json'),
  logs: path.join(JOB_DIR, 'logs'),
  runLog: path.join(JOB_DIR, 'logs', 'run.log'),
  errorLog: path.join(JOB_DIR, 'logs', 'error.log'),
  screenshots: path.join(JOB_DIR, 'logs', 'screenshots'),
  profile: path.join(PROFILE_ROOT, PROFILE_ID),
};

function now() {
  return new Date().toISOString();
}

async function ensureDirs() {
  await fs.mkdir(PATHS.logs, { recursive: true });
  await fs.mkdir(PATHS.screenshots, { recursive: true });
  await fs.mkdir(PATHS.profile, { recursive: true });
}

async function appendLog(filePath, message, extra = {}) {
  const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra, null, 0)}` : '';
  await fs.appendFile(filePath, `[${now()}] ${message}${suffix}\n`, 'utf-8');
}

async function logRun(message, extra = {}) {
  console.log(message, extra);
  await appendLog(PATHS.runLog, message, extra);
}

async function logError(message, extra = {}) {
  console.error(message, extra);
  await appendLog(PATHS.errorLog, message, extra);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeState(patch) {
  const previous = await readJson(PATHS.state, {});
  const state = {
    job_id: JOB_ID,
    ...previous,
    ...patch,
    updated_at: now(),
  };
  await fs.writeFile(PATHS.state, JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

function getValue(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && String(row[name]).trim()) return String(row[name]).trim();
  }
  return '';
}

function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function mediaPathFor(row) {
  const fileName = getValue(row, ['파일명', 'filename', 'file_name', 'file']);
  if (!fileName) throw new Error('mapping row is missing 파일명.');
  return path.join(PATHS.images, fileName);
}

async function screenshot(page, label) {
  const safeLabel = label.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const filePath = path.join(PATHS.screenshots, `${Date.now()}-${safeLabel}.png`);
  await page.screenshot({ path: filePath, timeout: 15000, fullPage: false }).catch((error) => logError('screenshot failed', { label, error: error.message }));
  return filePath;
}

async function waitForButtonAndClick(page, labels, step, verify = null) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const exactPattern = new RegExp(`^\\s*(?:${escaped.join('|')})\\s*$`, 'i');
  const containsPattern = new RegExp(`(?:${escaped.join('|')})`, 'i');
  const totalAttempts = WAIT.baseRetryCount + WAIT.extendedRetryCount;
  await logRun('button search started', { step, labels, totalAttempts });

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const extended = attempt > WAIT.baseRetryCount;
    if (attempt === WAIT.baseRetryCount + 1) {
      await logRun('button search entering extended wait', { step, labels, extendedRetryIntervalMs: WAIT.extendedRetryIntervalMs });
    }

    const candidates = [
      page.getByRole('button', { name: exactPattern }).first(),
      page.locator('button, [role="button"]').filter({ hasText: exactPattern }).first(),
      page.locator('button, [role="button"]').filter({ hasText: containsPattern }).first(),
      page.getByText(containsPattern).locator('xpath=ancestor-or-self::*[@role="button" or self::button][1]').first(),
    ];

    for (const locator of candidates) {
      const visible = await locator.isVisible({ timeout: extended ? WAIT.extendedRetryIntervalMs : WAIT.baseRetryIntervalMs }).catch(() => false);
      if (!visible) continue;
      const disabled = await locator.evaluate((el) => (
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.hasAttribute('disabled') ||
        Boolean(el.closest('[aria-disabled="true"], [aria-busy="true"]'))
      )).catch(() => false);
      if (disabled) {
        await logRun('button candidate disabled', { step, attempt, labels });
        continue;
      }
      const text = await locator.innerText().catch(() => '');
      await locator.scrollIntoViewIfNeeded().catch(() => null);
      await locator.click({ force: true });
      await logRun('button clicked', { step, attempt, labels, text });
      if (verify) await verify();
      return true;
    }

    await logRun('button search retry', {
      step,
      attempt,
      labels,
      waitMs: extended ? WAIT.extendedRetryIntervalMs : WAIT.baseRetryIntervalMs,
    });
    await page.waitForTimeout(extended ? WAIT.extendedRetryIntervalMs : WAIT.baseRetryIntervalMs);
  }

  await screenshot(page, `${step}-button-not-found`);
  throw new Error(`button not found for step=${step}, labels=${labels.join('|')}`);
}

async function fillFirstMatchingInput(page, labels, value, step) {
  const exactPattern = new RegExp(labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const locators = [
    page.getByLabel(exactPattern).first(),
    page.getByPlaceholder(exactPattern).first(),
    page.locator('input, textarea').filter({ hasText: exactPattern }).first(),
  ];

  for (const locator of locators) {
    const visible = await locator.isVisible({ timeout: WAIT.baseRetryIntervalMs }).catch(() => false);
    if (!visible) continue;
    await locator.click({ force: true });
    await locator.fill(value);
    const actual = await locator.inputValue().catch(() => '');
    if (actual !== value) throw new Error(`${step} value mismatch. expected=${value}, actual=${actual}`);
    await logRun('input filled', { step, value });
    return true;
  }

  throw new Error(`${step} input not found. labels=${labels.join('|')}`);
}

async function waitForMediaProcessing(page, row, mediaFile) {
  const fileName = path.basename(mediaFile);
  const video = isVideoFile(fileName);
  const timeoutMs = video ? WAIT.videoUploadTimeoutMs : 30000;
  const startedAt = Date.now();
  await logRun(video ? 'video processing wait started' : 'image upload wait started', { fileName, timeoutMs });

  while (Date.now() - startedAt < timeoutMs) {
    const status = await page.evaluate((name) => {
      const text = document.body?.innerText || '';
      const hasName = text.includes(name);
      const hasPreview = Boolean(document.querySelector('video, img[src], [aria-label*="thumbnail" i], [data-testid*="thumbnail" i]'));
      const hasError = /오류|실패|error|failed/i.test(text);
      const nextEnabled = [...document.querySelectorAll('button, [role="button"]')].some((el) => {
        const label = (el.innerText || el.textContent || '').trim();
        const disabled = el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true' || el.hasAttribute('disabled');
        return /^(다음|계속|완료|저장|Next|Continue|Done|Save)$/.test(label) && !disabled;
      });
      const processing = /업로드 중|처리 중|processing|uploading/i.test(text);
      return { hasName, hasPreview, hasError, nextEnabled, processing };
    }, fileName);

    if (status.hasError) throw new Error(`media upload failed: ${fileName}`);
    if ((status.hasName || status.hasPreview) && status.nextEnabled && !status.processing) {
      await logRun(video ? 'video processing completed' : 'image upload completed', { fileName, durationMs: Date.now() - startedAt, status });
      return;
    }
    await page.waitForTimeout(1500);
  }

  if (video) {
    await logRun('video processing fallback wait started', { fileName, fallbackWaitMs: WAIT.videoFallbackWaitMs });
    await page.waitForTimeout(WAIT.videoFallbackWaitMs);
  }

  const shot = await screenshot(page, `media-processing-timeout-${fileName}`);
  throw new Error(`media processing timeout: ${fileName}. screenshot=${shot}`);
}

async function uploadMedia(page, row) {
  const mediaFile = mediaPathFor(row);
  await fs.access(mediaFile);
  await logRun('media upload started', { mediaFile, type: isVideoFile(mediaFile) ? 'video' : 'image' });

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 }).catch(() => null);
  await waitForButtonAndClick(page, ['업로드', 'Upload'], 'upload_media');
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(mediaFile);
  } else {
    const fileInput = page.locator('input[type="file"]').last();
    await fileInput.setInputFiles(mediaFile);
  }
  await waitForMediaProcessing(page, row, mediaFile);
}

async function processItem(page, row, index) {
  const fileName = getValue(row, ['파일명', 'filename', 'file_name', 'file']);
  const adName = getValue(row, ['광고명', 'ad_name', 'adName']);
  const headline = getValue(row, ['제목', 'headline', 'title']);
  const body = getValue(row, ['본문문구', '본문', 'body', 'primary_text']);
  const landingUrl = getValue(row, ['랜딩URL', 'landing_url', 'url']);

  await writeState({ status: 'running', current_item: fileName, failed_item: '', failed_step: '', error: '' });
  await logRun('item started', { index, fileName, adName, landingUrl });

  if (DRY_RUN) {
    await logRun('dry-run item skipped browser mutation', { index, fileName, adName });
    await writeState({ status: 'running', last_completed_item: fileName });
    return;
  }

  await fillFirstMatchingInput(page, ['광고 이름', 'Ad name'], adName, 'fill_ad_name').catch((error) => logRun('fill_ad_name skipped or failed', { error: error.message }));
  await uploadMedia(page, row);
  if (headline) await fillFirstMatchingInput(page, ['제목', 'Headline'], headline, 'fill_headline').catch((error) => logRun('fill_headline skipped or failed', { error: error.message }));
  if (body) await fillFirstMatchingInput(page, ['본문', '기본 문구', 'Primary text'], body, 'fill_body').catch((error) => logRun('fill_body skipped or failed', { error: error.message }));
  if (landingUrl) await fillFirstMatchingInput(page, ['웹사이트 URL', '랜딩 URL', 'Website URL'], landingUrl, 'fill_landing_url');
  await logRun('item completed', { index, fileName, adName });
  await writeState({ status: 'running', last_completed_item: fileName, current_item: '' });
}

function resumeIndex(rows, state) {
  const failed = state.failed_item || state.current_item;
  const lastCompleted = state.last_completed_item;
  const target = failed || lastCompleted;
  if (!target) return 0;
  const index = rows.findIndex((row) => getValue(row, ['파일명', 'filename', 'file_name', 'file']) === target);
  if (index < 0) return 0;
  return failed ? index : index + 1;
}

async function main() {
  await ensureDirs();
  const rows = await readJson(PATHS.mappingCache, []);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`mapping cache is empty: ${PATHS.mappingCache}`);
  const previousState = await readJson(PATHS.state, {});
  const startIndex = resumeIndex(rows, previousState);
  await writeState({ status: 'running', started_at: now(), total_items: rows.length });
  await logRun('job started', { JOB_ID, JOB_DIR, PROFILE_ID, startIndex, totalItems: rows.length, WAIT });

  const context = await chromium.launchPersistentContext(PATHS.profile, {
    headless: false,
    slowMo: SLOW_MO_MS,
    viewport: { width: 1440, height: 950 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const url = AD_ACCOUNT_ID ? `${ADS_MANAGER_URL}?act=${AD_ACCOUNT_ID}` : ADS_MANAGER_URL;
    await writeState({ current_step: 'open_ads_manager' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await logRun('ads manager opened', { url });

    for (let index = startIndex; index < rows.length; index += 1) {
      await writeState({ current_step: 'process_item', current_index: index + 1 });
      await processItem(page, rows[index], index + 1);
    }

    await writeState({ status: 'completed', ended_at: now(), current_item: '', failed_item: '', failed_step: '', error: '' });
    await logRun('job completed', { JOB_ID, totalItems: rows.length });
  } catch (error) {
    const state = await readJson(PATHS.state, {});
    const shot = context.pages()[0] ? await screenshot(context.pages()[0], 'error') : '';
    await writeState({
      status: 'failed',
      failed_item: state.current_item || '',
      failed_step: state.current_step || '',
      error: error.message,
      screenshot: shot,
      ended_at: now(),
    });
    await logError('job failed', { error: error.message, stack: error.stack, screenshot: shot });
    throw error;
  } finally {
    await context.close().catch(() => null);
  }
}

main().catch((error) => {
  console.error('[FATAL JOB ERROR]', error);
  process.exitCode = 1;
});
