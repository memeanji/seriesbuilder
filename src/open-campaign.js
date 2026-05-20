import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  CAMPAIGN_MODES,
  buildBlogAdsetName,
  buildVideoOnlyAdsetName,
  formatDryRunPlan,
  getBlogAdPlanBySequence,
  getImageOnlyAssetBySequence,
  getImageOnlyAssets,
  getVideoOnlyAdPlanBySequence,
  getVideoOnlyAssetBySequence,
  getVideoOnlyAssets,
  isPerAdImageOnlyUploadMode,
  normalizeCampaignMode,
  parseBoolean,
  validateCampaignConfig,
} from './campaign-config.js';

const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME;
const ADSET_INDEX = process.env.ADSET_INDEX;
const ADSET_BASE_NAME = '리타겟';
const ADSET_START_INDEX = Number(process.env.ADSET_START_INDEX || ADSET_INDEX || 1);
const ADSET_COUNT = Number(process.env.ADSET_COUNT || process.env.adset_count || 1);
const AD_CREATIVE_COUNT = Number(process.env.ADSET_CREATIVE_COUNT || process.env.AD_CREATIVE_COUNT || process.env.ADVERTISE_COUNT || 5);
const MEDIA_FOLDER_PATH = process.env.MEDIA_FOLDER_PATH;
const SCHEDULE_TIME = process.env.SCHEDULE_TIME || '05:00';
const ADSET_DAILY_BUDGET = String(process.env.ADSET_DAILY_BUDGET || '').trim();
const AD_FORMAT = normalizeAdFormat(process.env.AD_FORMAT || process.env.AD_CREATIVE_FORMAT || process.env.AD_MEDIA_TYPE || 'image');
const CAMPAIGN_MODE = normalizeCampaignMode(process.env.CAMPAIGN_MODE);
const DRY_RUN = parseBoolean(process.env.DRY_RUN);
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const QUICK_TEST_CREATIVE_STEP = String(process.env.QUICK_TEST_CREATIVE_STEP || '').toLowerCase() === 'true';
const QUICK_TEST_AD_NAME = process.env.QUICK_TEST_AD_NAME || getAdName(1);

let firstCreativeMediaUploaded = false;
let activeCampaignPlan = null;
let imageOnlyPerAdAssets = [];
let videoOnlyAssets = [];

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

function validateEnv() {
  if (!DRY_RUN && !AD_ACCOUNT_ID) throw new Error('AD_ACCOUNT_ID is missing in .env');
  if (!CAMPAIGN_NAME) throw new Error('CAMPAIGN_NAME is missing in .env');
  if (!Number.isFinite(ADSET_START_INDEX)) throw new Error('ADSET_START_INDEX must be a number');
  if (!Number.isFinite(ADSET_COUNT) || ADSET_COUNT < 1) throw new Error('ADSET_COUNT must be >= 1');
  if (!Number.isFinite(AD_CREATIVE_COUNT) || AD_CREATIVE_COUNT < 1) throw new Error('AD_CREATIVE_COUNT must be >= 1');
  if (ADSET_DAILY_BUDGET && !/^\d+(\.\d+)?$/.test(ADSET_DAILY_BUDGET)) throw new Error('ADSET_DAILY_BUDGET must be a number');
}

function isBlogMixedCampaign() {
  return CAMPAIGN_MODE === CAMPAIGN_MODES.BLOG_MIXED;
}

function isVideoOnlyCampaign() {
  return CAMPAIGN_MODE === CAMPAIGN_MODES.VIDEO_ONLY;
}

function normalizeText(value) {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeAdFormat(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['video', 'movie', '동영상', '영상'].includes(normalized)) return 'video';
  if (normalizeCampaignMode(process.env.CAMPAIGN_MODE) === CAMPAIGN_MODES.VIDEO_ONLY) return 'video';
  return 'image';
}

function getCreativeFormatLabel(format = AD_FORMAT) {
  return format === 'video' ? '동영상 광고' : '이미지 광고';
}

function getCreativeFormatPattern(format = AD_FORMAT) {
  return format === 'video' ? /동영상 광고/ : /이미지 광고/;
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

async function ensureDirs() {
  await fs.mkdir(DIRS.screenshots, { recursive: true });
}


async function pause(page, label, ms = 2000) {
  console.log(`[PAUSE] ${label} - ${ms}ms`);
  await page.waitForTimeout(ms);
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
    throw new Error('로그인 화면이 감지되었습니다. 일반 Chrome에서 Meta 로그인 후 다시 실행해주세요.');
  }
}

async function trySearchBox(page, keyword) {
  const searchInput = page
    .locator('input[type="text"], input[type="search"], textarea')
    .filter({ hasNot: page.locator('[type="checkbox"], [role="switch"]') })
    .filter({ hasNot: page.locator('[aria-label*="빠른 보기" i], [aria-label*="저장" i]') })
    .first();

  const visible = await searchInput.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) {
    console.log('[STEP] 캠페인 검색창 미감지 - 목록에서 직접 탐색');
    return false;
  }

  console.log('[STEP] 캠페인 검색창 감지 - 검색어 입력 시도');
  await searchInput.click();
  await searchInput.fill('');
  await searchInput.fill(keyword);
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(3000);
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
  console.log('[DEBUG] 화면 캠페인 후보(최대 10개):');
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
  const createCandidates = page.locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli');
  const count = await createCandidates.count();

  for (let i = 0; i < count; i += 1) {
    const candidate = createCandidates.nth(i);
    const text = (await candidate.innerText().catch(() => '')).trim();
    const box = await candidate.boundingBox().catch(() => null);
    console.log('[DEBUG] create button candidate:', { index: i, text, box });

    if (text !== '만들기') continue;
    if (text.includes('보기 만들기')) continue;
    if (!box) continue;

    if (box.x < 300 && box.y > 150 && box.y < 300) {
      await candidate.click();
      return;
    }
  }

  throw new Error('좌측 상단 실제 +만들기 버튼을 찾지 못했습니다.');
}

async function isAdsetCreateOpen(page) {
  const byPlaceholder = await page.locator('input[placeholder="광고 세트 이름 지정"]').first().isVisible({ timeout: 1500 }).catch(() => false);
  if (byPlaceholder) return true;

  const textInputs = await page.locator('input[type="text"]').elementHandles();
  for (const input of textInputs) {
    const value = await input.getAttribute('value');
    if (value?.includes('리타겟') || value?.includes('광고세트')) return true;
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
    await page.screenshot({ path: path.join(DIRS.screenshots, 'adset-create-reopen-failed.png'), fullPage: true });
    await debugDump(page, 'adset create reopen failed');
    throw new Error('광고 세트 생성 화면 재진입 실패');
  }
  return true;
}

async function fillAdsetNameInAdsetModalOnly(page, adsetName) {
  await ensureAdsetCreateOpen(page);
  await pause(page, '광고 세트명 입력 전 대기', 2000);

  const broadLocator = page.locator(
    'input[placeholder="광고 세트 이름 지정"], input._58al._aghb[type="text"], input[type="text"][value*="리타겟"], input[type="text"][value*="광고세트"], input[type="text"][value*="광고 세트 이름 지정"], input[data-auto-logging-id]'
  );

  const broadCount = await broadLocator.count();
  console.log('[DEBUG] adset input broad candidate count:', broadCount);

  let targetInputHandle = null;
  const deadline = Date.now() + 180000; // 최대 3분

  while (Date.now() < deadline && !targetInputHandle) {
    const directLocator = page.locator('input[placeholder="광고 세트 이름 지정"], input._58al._aghb[type="text"]').first();
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
        value?.includes('리타겟') ||
        value?.includes('광고세트') ||
        value?.includes('광고 세트 이름 지정') ||
        className?.includes('_58al')
      ) {
        targetInputHandle = input;
        break;
      }
    }

    if (!targetInputHandle) {
      console.log('[WAIT] 광고 세트 이름 input 탐색 중... (2s 재시도)');
      await page.waitForTimeout(5000);
    }
  }

  if (!targetInputHandle) {
    await debugDump(page, 'adsetNameInput not found after 3min');
    await page.screenshot({ path: path.join(DIRS.screenshots, 'adset-name-input-not-found.png'), fullPage: true });
    throw new Error('광고 세트 이름 input을 3분 내에 찾지 못했습니다.');
  }

  await targetInputHandle.asElement().click();
  await page.waitForTimeout(500);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.waitForTimeout(300);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await page.keyboard.type(adsetName, { delay: 80 });
  await page.waitForTimeout(1000);

  let actualValue = await targetInputHandle.evaluate((el) => el.value || '');
  console.log('[DEBUG] actual adset input value:', actualValue);

  if (!actualValue.trim().includes(adsetName)) {
    console.log('[DEBUG] keyboard.type 미반영 - DOM value fallback 적용');
    await targetInputHandle.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, adsetName);

    await page.waitForTimeout(1000);
    actualValue = await targetInputHandle.evaluate((el) => el.value || '');
    console.log('[DEBUG] actual adset input value after fallback:', actualValue);
  }

  if (!actualValue.trim().includes(adsetName)) {
    await debugDump(page, 'adsetNameInput fill mismatch');
    throw new Error(`광고 세트명 입력 실패: expected=${adsetName}, actual=${actualValue}`);
  }

  await pause(page, '광고 세트명 입력 후 대기', 5000);
  await clickContinueButtonOnly(page);
  await page.screenshot({ path: path.join(DIRS.screenshots, '08-adset-name-and-continue.png'), fullPage: true });

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
    console.log(`[WAIT] 날짜 input 탐색 재시도 ${attempt}/6`);
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(2000);
  }

  if (!dateInput) {
    console.log('[DEBUG] 날짜 input 미감지 - 스케줄링 단계 미확인');
    await debugDump(page, 'schedule input not found');
    return false;
  }

  const currentDateText = await dateInput.inputValue().catch(() => '');
  console.log('[DEBUG] current date value:', currentDateText);

  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const nextDateText = `${tomorrow.getFullYear()}년 ${tomorrow.getMonth() + 1}월 ${tomorrow.getDate()}일`;

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

  const hourSpin = page.locator('input[role="spinbutton"][aria-label*="시간"]').first();
  const minuteSpin = page.locator('input[role="spinbutton"][aria-label*="분"]').first();

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
      if (value?.includes(':') || placeholder?.includes('시간') || ariaLabel?.includes('시간')) {
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

async function findBudgetInputHandle(page) {
  const placeholderInput = page.locator('input[placeholder="금액을 입력하세요"]').first();
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

    if (placeholder === '금액을 입력하세요' || ariaLabelledBy === 'js_dte js_dtr') {
      return input;
    }
  }

  return null;
}

async function fillAdsetDailyBudgetAfterSchedule(page) {
  if (!ADSET_DAILY_BUDGET) {
    console.log('[STEP] ADSET_DAILY_BUDGET empty - budget input skipped');
    return true;
  }

  await pause(page, 'schedule applied before budget input', 3000);

  const budgetStrategyLabel = page
    .locator('span.x1vvvo52.x1fvot60.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.x117nqv4.xeuugli')
    .filter({ hasText: /예산 전략/ })
    .first()
    .or(page.getByText(/예산 전략/).first());

  const budgetStrategyVisible = await budgetStrategyLabel.isVisible({ timeout: 3000 }).catch(() => false);
  console.log('[DEBUG] budget strategy label visible:', budgetStrategyVisible);

  const budgetInputHandle = await findBudgetInputHandle(page);
  if (!budgetInputHandle) {
    await debugDump(page, 'daily budget input not found');
    await page.screenshot({ path: path.join(DIRS.screenshots, 'daily-budget-input-not-found.png'), fullPage: true });
    throw new Error('ADSET_DAILY_BUDGET input not found after schedule step');
  }

  const filled = await fillInputHandle(page, budgetInputHandle, ADSET_DAILY_BUDGET, 'daily budget');
  if (!filled) {
    await debugDump(page, 'daily budget input fill mismatch');
    throw new Error(`ADSET_DAILY_BUDGET fill failed: expected=${ADSET_DAILY_BUDGET}`);
  }

  await pause(page, 'daily budget input applied', 2000);
  return true;
}




async function ensureCampaignStructureRoot(page) {
  console.log('[STEP] campaign_structure_tree_root 탐색');
  const root = page.locator('#campaign_structure_tree_root').first();

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const visible = await root.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[DEBUG] campaign_structure_tree_root visible attempt ${attempt}/8:`, visible);
    if (visible) {
      await pause(page, 'campaign_structure_tree_root 확인 후 안정화 대기', 3000);
      return true;
    }
    await page.waitForTimeout(3000);
  }

  await debugDump(page, 'campaign_structure_tree_root not found');
  throw new Error('id="campaign_structure_tree_root"를 찾지 못했습니다.');
}

async function openCorrectAdActionMenu(page, adsetName) {
  console.log('[STEP] row 기준 작업 메뉴 탐색');

  await ensureCampaignStructureRoot(page);
  await page.waitForTimeout(1500);

  const fastMenuBox = adsetName === '새 판매 광고'
    ? { x: 371, y: 159, width: 44, height: 36, label: '광고 복제 작업메뉴 빠른 좌표' }
    : { x: 407, y: 113, width: 44, height: 36, label: '광고 세트 작업메뉴 빠른 좌표' };

  async function isActionMenuOpen(timeout = 3000) {
    const actionHeading = page.locator('div[role="heading"]').filter({ hasText: /이 광고( 세트)?에 대한 작업/ }).first();
    const actionHeadingVisible = await actionHeading.isVisible({ timeout }).catch(() => false);
    const duplicateByClass = page.locator('div.x1mcwxda').filter({ hasText: /^복제$/ }).first();
    const duplicateVisible = await duplicateByClass.isVisible({ timeout }).catch(() => false);
    const bodyText = await page.locator('body').innerText().catch(() => '');

    console.log('[DEBUG] 작업 메뉴 클릭 후 body text:', bodyText.slice(0, 1200));
    console.log('[DEBUG] 광고세트 작업 heading visible:', actionHeadingVisible);
    console.log('[DEBUG] 복제 버튼 visible:', duplicateVisible);

    return actionHeadingVisible
      || duplicateVisible
      || bodyText.includes('이 광고 세트에 대한 작업')
      || bodyText.includes('이 광고에 대한 작업')
      || bodyText.includes('복제');
  }

  console.log('[DEBUG] 빠른 작업메뉴 좌표 클릭 시도:', fastMenuBox);
  await page.mouse.click(fastMenuBox.x + fastMenuBox.width / 2, fastMenuBox.y + fastMenuBox.height / 2);
  await page.waitForTimeout(3000);

  if (await isActionMenuOpen(3000)) {
    console.log('[STEP] 작업 메뉴 빠른 좌표 열기 성공');
    return;
  }

  console.log('[WARN] 빠른 좌표로 작업 메뉴 확인 실패 - 기존 row 탐색으로 fallback');

  const adRow = page.locator(`text=${adsetName}`).first();
  const adRowVisible = await adRow.isVisible({ timeout: 15000 }).catch(() => false);
  if (!adRowVisible) {
    throw new Error(`광고세트 row를 찾지 못했습니다: ${adsetName}`);
  }
  await page.waitForTimeout(1500);

  const adRowBox = await adRow.boundingBox();
  if (!adRowBox) throw new Error(`광고세트 row 위치를 찾지 못했습니다: ${adsetName}`);

  console.log('[DEBUG] 광고세트 row box:', { adsetName, adRowBox });

  const menuButtonSelector = '[role="button"].x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf';
  const menuIconSelector = '.x6s0dn4.x78zum5.x1q0g3np.xozqiw3.x2lwn1j.xeuugli.x1iyjqo2.x8va1my.x1hc1fzr.x13dflua.x6o7n8i.xxziih7.x12w9bfk.xl56j7k.xh8yej3';

  let opened = false;

  for (let attempt = 1; attempt <= 10 && !opened; attempt += 1) {
    console.log(`[STEP] 작업 메뉴 탐색/클릭 시도 ${attempt}/10`);

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
      await page.waitForTimeout(2500);
      continue;
    }

    const menuBox = await targetMenu.boundingBox();
    if (!menuBox) {
      await page.waitForTimeout(2500);
      continue;
    }

    const menuTypeLabel = adsetName === '새 판매 광고' ? '광고 복제 작업메뉴 찾기' : '광고 세트 작업메뉴 찾기';
    console.log(`[DEBUG] ${menuTypeLabel}:`, menuBox);
    await page.waitForTimeout(1000);
    await page.mouse.click(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
    await page.waitForTimeout(4000);

    if (await isActionMenuOpen(5000)) {
      opened = true;
      break;
    }

    await page.waitForTimeout(2500);
  }

  if (!opened) {
    await page.screenshot({ path: path.join(DIRS.screenshots, 'duplicate-menu-not-opened.png'), fullPage: true });
    throw new Error('작업 메뉴는 클릭했지만 복제 메뉴가 열리지 않았습니다.');
  }

  console.log('[STEP] 작업 메뉴 열기 성공');
}

async function setDuplicateCount(page, count = 9, adsetName) {
  console.log('[STEP] 복제 옵션 버튼 탐색:', { adsetName, count });
  await openCorrectAdActionMenu(page, adsetName);

  const duplicateButton = page.locator('div.x1mcwxda').filter({ hasText: /^복제$/ }).first();

  let duplicateClicked = false;
  for (let attempt = 1; attempt <= 10 && !duplicateClicked; attempt += 1) {
    await duplicateButton.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(5000);
    await duplicateButton.click({ force: true }).catch(async () => {
      const box = await duplicateButton.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(10000);

    const bodyText = await page.locator('body').innerText();
    const duplicateStillVisible = await duplicateButton.isVisible({ timeout: 2000 }).catch(() => false);
    if (!duplicateStillVisible || bodyText.includes('복제 개수') || bodyText.includes('계속')) {
      duplicateClicked = true;
      break;
    }

    console.log(`[WARN] 복제 클릭 후 상태 변화 없음, 재시도 ${attempt}/10`);
  }

  if (!duplicateClicked) {
    await page.screenshot({ path: path.join(DIRS.screenshots, 'duplicate-button-click-failed.png'), fullPage: true });
    throw new Error('복제 버튼 클릭에 실패했습니다.');
  }

  console.log('[STEP] 복제 개수 input 탐색');

  let duplicateInput = null;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await pause(page, `복제 input 탐색 전 대기 ${attempt}/10`, 3000);
    const inputs = await page.locator('input').elementHandles();

    for (const input of inputs) {
      const value = await input.getAttribute('value');
      const type = await input.getAttribute('type');
      const className = await input.getAttribute('class');

      console.log('[DEBUG] duplicate input candidate:', {
        attempt,
        type,
        value,
        className,
      });

      const isNumberOnly = value && /^\d+$/.test(value);
      const isNotDate = value && !value.includes('년') && !value.includes('월') && !value.includes('일');
      const isNotTime = value && !value.includes(':');

      if (isNumberOnly && isNotDate && isNotTime && value === '1') {
        duplicateInput = input;
        break;
      }
    }

    if (duplicateInput) break;

    console.log(`[WAIT] 복제 개수 input 탐색 재시도 ${attempt}/10`);
    await page.waitForTimeout(5000);
  }

  if (!duplicateInput) {
    await page.screenshot({
      path: path.join(DIRS.screenshots, 'duplicate-count-input-not-found.png'),
      fullPage: true,
    });
    throw new Error('복제 개수 input을 찾지 못했습니다.');
  }

  await duplicateInput.click();
  await page.waitForTimeout(1000);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.waitForTimeout(500);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);
  await page.keyboard.type(String(count), { delay: 80 });
  await page.waitForTimeout(2000);

  let actualValue = await duplicateInput.evaluate((el) => el.value);
  console.log('[DEBUG] duplicate count after keyboard input:', actualValue);

  if (actualValue !== String(count)) {
    console.log('[WARN] 키보드 입력으로 복제 개수 변경 실패 - DOM value 직접 변경 fallback');

    await duplicateInput.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(count));

    await page.waitForTimeout(2000);
    actualValue = await duplicateInput.evaluate((el) => el.value);
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

  const labelText = '새로운 광고에 기존 공감, 댓글 및 공유 표시하기';
  const label = page
    .locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2')
    .filter({ hasText: labelText })
    .first()
    .or(page.getByText(labelText).first());

  const labelVisible = await label.isVisible({ timeout: 5000 }).catch(() => false);
  if (!labelVisible) {
    console.log('[STEP] 기존 공감/댓글/공유 표시 옵션 미표시 - 건너뜀');
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
    console.log('[STEP] 기존 공감/댓글/공유 표시 옵션이 이미 해제됐거나 체크박스 미탐지');
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
  console.log('[STEP] 복제 모달 하단 "복제만들기" 버튼 확인 클릭');

  const duplicateCreateButton = page.locator('#pe_duplicate_create_button').first();

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const visible = await duplicateCreateButton.isVisible({ timeout: 3000 }).catch(() => false);
    const box = await duplicateCreateButton.boundingBox().catch(() => null);

    console.log('[DEBUG] 복제만들기 버튼 상태:', { attempt, visible, box });

    if (visible && box) {
      await page.waitForTimeout(5000);
      await duplicateCreateButton.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(7000);
      return true;
    }

    console.log(`[WAIT] 복제만들기 버튼 탐색 재시도 ${attempt}/10`);
    await page.waitForTimeout(3000);
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

      await page.waitForTimeout(5000);
      await candidate.click({ force: true }).catch(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(7000);
      return true;
    }

    console.log(`[WAIT] 복제 confirm fallback 탐색 재시도 ${attempt}/10`);
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: path.join(DIRS.screenshots, 'duplicate-confirm-not-found.png'), fullPage: true });
  throw new Error('복제 모달의 확인용 "복제만들기" 버튼을 찾지 못했습니다.');
}

async function clickContinueButtonOnly(page) {
  await pause(page, '계속 버튼 탐색 전 대기', 5000);
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
      console.log(`[WAIT] 계속 버튼 탐색 재시도 ${attempt}/8`);
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


async function enterAdsetFlow(page) {
  await ensureAdsetCreateOpen(page);
  await page.locator('input[placeholder="광고 세트 이름 지정"], input._58al._aghb').first().waitFor({ state: 'visible', timeout: 180000 });
}



async function selectImageAdModeWithRequestedClasses(page) {
  console.log('[STEP] 이미지 광고 버튼 선택 단계 시작');

  const surfaceWrapper = page.locator('span[data-surface-wrapper="1"]').first();
  const requestedWrapper = page
    .locator('div.x6s0dn4.x1q0g3np.xozqiw3.x2lwn1j.x1iyjqo2.xs83m0k.x1xsc7gk.x78zum5.xeuugli')
    .filter({ hasText: /이미지 광고/ })
    .first();

  const requestedLabel = page
    .locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2')
    .filter({ hasText: /^이미지 광고$/ })
    .first();

  const requestedIconOrButton = page
    .locator('div.x6s0dn4.x78zum5.x1q0g3np.xozqiw3.x2lwn1j.xeuugli.x1iyjqo2.x8va1my.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1y1aw1k.xwib8y2.xmzvs34.xf159sx.xo1l8bm.xbsr9hj.x1v911su')
    .filter({ hasText: /이미지 광고/ })
    .first();

  const autoLoggingButton = page
    .locator('[data-auto-logging-id="f1a363776"]')
    .filter({ hasText: /이미지 광고/ })
    .first();

  const ariaReadyButton = page
    .locator('[aria-busy="false"], [aria-busy="False"]')
    .filter({ hasText: /이미지 광고/ })
    .first();

  const longClassButton = page
    .locator('div.x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.x2lwn1j.xeuugli.x16tdsg8.xggy1nq.x1ja2u2z.x6s0dn4.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x3nfvp2.xdl72j9.x1q0g3np.x2lah0s.x193iq5w.x1n2onr6.x1hl2dhg.x87ps6o.xxymvpz.xlh3980.xvmahel.x1lku1pv.x1g40iwv.x1g2r6go.x16e9yqp.x12w9bfk.x15406qy.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1ob88yx.xaatb59.x1qgsegg.xo1l8bm.xbsr9hj.x1v911su.x1y1aw1k.xwib8y2.xv54qhq.x1g0dm76')
    .filter({ hasText: /이미지 광고/ })
    .first();

  const presentationArea = page
    .locator('div[role="presentation"].x3nfvp2.x120ccyz.x1heor9g.x2lah0s.x1c4vz4f')
    .first();

  const uploadButton = page
    .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
    .filter({ hasText: /^업로드$/ })
    .first()
    .or(page.getByRole('button', { name: /^업로드$/ }).first())
    .or(page.getByText(/^업로드$/).first());

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
        .filter({ hasText: /이미지 광고/ })
        .first(),
    },
    {
      name: 'role menuitem text',
      locator: page.getByRole('menuitem', { name: /이미지 광고/ }).first(),
    },
    {
      name: 'role button text',
      locator: page.getByRole('button', { name: /이미지 광고/ }).first(),
    },
    {
      name: 'plain text',
      locator: page.getByText(/^이미지 광고$/).first(),
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

    if (surfaceVisible && (presentationVisible || uploadVisible)) {
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
        .filter({ hasText: /^업로드$/ })
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
    .filter({ hasText: /^업로드$/ })
    .first()
    .or(page.getByRole('button', { name: /^업로드$/ }).first())
    .or(page.getByText(/^업로드$/).first());

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

    if (surfaceVisible && (presentationVisible || uploadVisible)) {
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

    await page.waitForTimeout(4000);
  }

  await debugDump(page, 'video ad button not clicked');
  throw new Error('동영상 광고 버튼을 찾거나 클릭하지 못했습니다.');
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
    throw new Error(`바탕화면에서 날짜 이미지 폴더를 찾지 못했습니다: ${folderNames.join(', ')}`);
  }

  const files = explicitFiles?.length ? explicitFiles : await collectUploadFiles(uploadFolder);
  if (!files.length) {
    throw new Error(`업로드 가능한 ${adFormat} 파일이 없습니다: ${uploadFolder}`);
  }

  console.log('[STEP] 업로드 이미지 폴더 선택:', {
    uploadFolder,
    targetAdName,
    adFormat,
    folderNames,
    fileCount: files.length,
    files,
  });

  console.log('[STEP] 이미지 광고 내부 - 업로드 버튼 탐색 시작');

  const presentationArea = page
    .locator('div[role="presentation"].x3nfvp2.x120ccyz.x1heor9g.x2lah0s.x1c4vz4f')
    .first();

  const presentationVisible = await presentationArea.isVisible({ timeout: 30000 }).catch(() => false);
  console.log('[DEBUG] 이미지 광고 presentation 영역 표시:', { presentationVisible });
  if (presentationVisible) {
    await presentationArea.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(1500);
  }

  const uploadButtonCandidates = [
    {
      name: 'upload data-surface button',
      locator: page
        .locator('div[role="button"][aria-busy="false"][data-surface*="creative-tool-asset-picker-upload-button"]')
        .filter({ hasText: /^업로드$/ })
        .first(),
    },
    {
      name: 'upload long class button',
      locator: page
        .locator('div.x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.x2lwn1j.xeuugli.x16tdsg8.xggy1nq.x1ja2u2z.x6s0dn4.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x3nfvp2.xdl72j9.x1q0g3np.x2lah0s.x193iq5w.x1n2onr6.x1hl2dhg.x87ps6o.xxymvpz.xlh3980.xvmahel.x1lku1pv.x1g40iwv.x1g2r6go.x16e9yqp.x12w9bfk.x15406qy.xjwep3j.x1t39747.x1wcsgtt.x1pczhz8.x1ob88yx.xaatb59.x1qgsegg.xo1l8bm.xbsr9hj.x1v911su.x1y1aw1k.xwib8y2.xv54qhq.x1g0dm76')
        .filter({ hasText: /^업로드$/ })
        .first(),
    },
    {
      name: 'role button upload',
      locator: page.getByRole('button', { name: /^업로드$/ }).first(),
    },
    {
      name: 'upload text div',
      locator: page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
        .filter({ hasText: /^업로드$/ })
        .first(),
    },
  ];

  let uploadButton = null;
  let uploadBox = null;
  for (let attempt = 1; attempt <= 12 && !uploadButton; attempt += 1) {
    console.log(`[STEP] 업로드 버튼 탐색/클릭 준비 ${attempt}/12`);
    for (const candidate of uploadButtonCandidates) {
      const visible = await candidate.locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;

      await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
      await page.waitForTimeout(700);
      const box = await candidate.locator.boundingBox().catch(() => null);
      console.log('[DEBUG] 업로드 버튼 후보:', { attempt, name: candidate.name, box });
      if (!box) continue;

      uploadButton = candidate.locator;
      uploadBox = box;
      break;
    }

    if (!uploadButton) await page.waitForTimeout(3000);
  }

  if (!uploadButton) {
    await debugDump(page, 'upload button not found');
    throw new Error('업로드 버튼을 찾지 못했습니다.');
  }

  console.log('[DEBUG] 업로드 버튼 box:', uploadBox);

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

  await page.waitForTimeout(adFormat === 'video' ? 20000 : 3000);
  console.log('[STEP] 바탕화면 날짜 폴더 이미지 전체 업로드 완료:', {
    uploadFolder,
    fileCount: files.length,
  });

  if (explicitFiles?.length) {
    if (!(await isOneMediaSelected(page))) {
      console.log('[STEP] uploaded media is not selected yet - clicking visible media once:', { targetAdName, adFormat });
      await clickVisibleMediaImageOnce(page, targetAdName);
    }
    await completeMediaPickerNextAndOriginalFlow(page, adFormat);
    return;
  }

  await searchAndSelectExistingMedia(page, targetAdName);
}

async function searchAndSelectExistingMedia(page, targetAdName) {
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactNameRegex = new RegExp(`^${escapeRegex(targetAdName)}(\\.[a-z0-9]+)?$`, 'i');

  console.log('[STEP] 정확한 업로드 이미지 검색/선택 시작:', { targetAdName });

  const mediaSearch = page
    .locator('input[placeholder="미디어 검색"], input[placeholder*="미디어"], input[type="search"]')
    .first();

  await mediaSearch.waitFor({ state: 'visible', timeout: 60000 });
  await mediaSearch.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(targetAdName, { delay: 40 });
  await page.waitForTimeout(8000);
  console.log('[STEP] 기존 미디어 정확 검색어 입력:', { targetAdName });
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
    console.log('[DEBUG] 정확 파일명 일치 미디어 후보:', {
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
    console.log('[STEP] 정확히 일치하는 업로드 이미지 선택 완료:', { targetAdName });
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  console.log('[WARN] 고립된 정확 파일명 카드를 찾지 못함 - 정확 검색 결과의 오늘 업로드 후보를 선택합니다:', { targetAdName });
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
      locator: page.locator('[role="button"]').filter({ hasNotText: /^다음$|^완료$|^업로드$/ }).first(),
    },
  ];

  for (const candidate of fallbackCandidates) {
    const visible = await candidate.locator.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) continue;

    await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(5000);
    const box = await candidate.locator.boundingBox().catch(() => null);
    console.log('[DEBUG] 오늘 업로드 이미지 fallback 선택 후보:', { targetAdName, name: candidate.name, box });
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
    console.log('[STEP] 오늘 업로드 이미지 fallback 선택 완료:', { targetAdName, candidate: candidate.name });
    await completeMediaPickerNextAndOriginalFlow(page);
    return;
  }

  console.log('[DEBUG] 정확 파일명 매칭 실패 - 검사한 값 샘플:', inspected.slice(0, 20));
  await debugDump(page, 'existing media not selected');
  throw new Error(`정확히 일치하는 기존 업로드 이미지 검색/선택 실패: ${targetAdName}`);
}

async function waitForOneMediaSelected(page, targetAdName) {
  const selectedLabel = page
    .locator('span.x1vvvo52.xw23nyj.x63nzvj.xbsr9hj.xq9mrsl.x1h4wwuj.x117nqv4.xeuugli')
    .filter({ hasText: /1개\s*선택됨/ })
    .first()
    .or(page.getByText(/1개\s*선택됨/).first());

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const selectedVisible = await selectedLabel.isVisible({ timeout: 2000 }).catch(() => false);
    const selectedText = selectedVisible ? await selectedLabel.innerText().catch(() => '') : '';
    console.log('[DEBUG] 미디어 1개 선택 확인:', { targetAdName, attempt, selectedVisible, selectedText });
    if (selectedVisible) {
      await page.waitForTimeout(5000);
      return true;
    }
    await page.waitForTimeout(2000);
  }

  await debugDump(page, 'one media selected label not found');
  throw new Error(`이미지 선택 후 1개 선택됨 상태를 확인하지 못했습니다: ${targetAdName}`);
}

async function isOneMediaSelected(page) {
  const selectedLabel = page
    .locator('span.x1vvvo52.xw23nyj.x63nzvj.xbsr9hj.xq9mrsl.x1h4wwuj.x117nqv4.xeuugli')
    .filter({ hasText: /1개\s*선택됨/ })
    .first()
    .or(page.getByText(/1개\s*선택됨/).first());

  return selectedLabel.isVisible({ timeout: 1000 }).catch(() => false);
}

async function clickVisibleMediaImageOnce(page, targetAdName) {
  await page.waitForTimeout(5000);
  const result = await page.evaluate(() => {
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

    const scoreTarget = (el) => {
      const styleAttr = el.getAttribute('style') || '';
      const cachekey = el.getAttribute('cachekey') || '';
      let score = 0;
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
        return {
          index,
          tagName: el.tagName,
          className: el.getAttribute('class') || '',
          cachekey: el.getAttribute('cachekey') || '',
          style: el.getAttribute('style') || '',
          score: scoreTarget(el),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          parentBoxes,
        };
      });

    targets.sort((a, b) => (b.score - a.score) || (b.box.x - a.box.x) || (a.box.y - b.box.y));
    return { found: targets.length > 0, target: targets[0] || null, count: targets.length };
  }).catch((error) => ({ found: false, error: error.message }));

  console.log('[DEBUG] 보이는 이미지 단순 클릭 후보:', { targetAdName, result });
  if (!result.found || !result.target) return false;

  const { box } = result.target;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(7000);

  if (await isOneMediaSelected(page)) {
    console.log('[STEP] 보이는 이미지 단순 클릭 선택 완료:', { targetAdName });
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
    console.log('[DEBUG] 이미지 좌표 후보 클릭:', { targetAdName, candidate });
    await page.mouse.click(candidate.x, candidate.y);
    await page.waitForTimeout(5000);
    if (await isOneMediaSelected(page)) {
      console.log('[STEP] 이미지 좌표 후보 클릭 선택 완료:', { targetAdName, candidate });
      return true;
    }
  }

  console.log('[WARN] 보이는 이미지 단순 클릭 후 선택 미확인:', { targetAdName });
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

  console.log('[DEBUG] 파일명 span 기반 미디어 후보:', { targetAdName, result });
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
    console.log('[DEBUG] 파일명 span 이미지 DOM 강제 클릭 결과:', { targetAdName, forced });
    await page.waitForTimeout(7000);
  }

  await waitForOneMediaSelected(page, targetAdName);
  console.log('[STEP] 파일명 span 확인 후 이미지 선택 완료:', { targetAdName });
  return true;
}

async function clickMediaCandidateAndVerifySelected(page, locator, targetAdName, name) {
  const visible = await locator.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) return false;

  await locator.scrollIntoViewIfNeeded().catch(() => null);
  await page.waitForTimeout(5000);
  const box = await locator.boundingBox().catch(() => null);
  console.log('[DEBUG] 미디어 명시 후보:', { targetAdName, name, box });
  if (!box) return false;

  await locator.click({ force: true }).catch(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
  await page.waitForTimeout(7000);
  await waitForOneMediaSelected(page, targetAdName);
  console.log('[STEP] 미디어 명시 후보 선택 완료:', { targetAdName, name });
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
  console.log('[DEBUG] 오른쪽 끝 미디어 타일 선택 후보:', {
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
    console.log('[DEBUG] 미디어 타일 DOM 강제 클릭 결과:', { targetAdName, forced });
    await page.waitForTimeout(7000);
  }

  await waitForOneMediaSelected(page, targetAdName);
  console.log('[STEP] 오른쪽 끝 미디어 타일 선택 완료:', { targetAdName });
  return true;
}

async function clickMediaPickerButton(page, buttonText, attemptLabel, dataSurfacePart = '') {
  const escapedText = buttonText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const textPattern = new RegExp(`^${escapedText}$`);
  const candidates = [
    {
      name: `${buttonText} data-surface`,
      locator: dataSurfacePart
        ? page
          .locator(`div[role="button"][aria-busy="false"][data-surface*="${dataSurfacePart}"]`)
          .filter({ hasText: textPattern })
          .first()
        : page.locator('__never_matches__').first(),
    },
    {
      name: `${buttonText} role button`,
      locator: page.getByRole('button', { name: textPattern }).first(),
    },
    {
      name: `${buttonText} text div`,
      locator: page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli')
        .filter({ hasText: textPattern })
        .first(),
    },
    {
      name: `${buttonText} plain text`,
      locator: page.getByText(textPattern).first(),
    },
  ];

  for (const candidate of candidates) {
    const visible = await candidate.locator.isVisible({ timeout: 2500 }).catch(() => false);
    if (!visible) continue;

    await candidate.locator.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(700);
    const box = await candidate.locator.boundingBox().catch(() => null);
    console.log('[DEBUG] 미디어 선택 버튼 후보:', { buttonText, attemptLabel, name: candidate.name, box });
    if (!box) continue;

    await candidate.locator.click({ force: true }).catch(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(1000);
    console.log('[STEP] 미디어 선택 버튼 클릭 완료:', { buttonText, attemptLabel, candidate: candidate.name });
    return true;
  }

  return false;
}

async function clickMediaPickerNextButton(page, attemptLabel) {
  return clickMediaPickerButton(page, '다음', attemptLabel, 'ads-omp-primary-button');
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
    console.log('[STEP] 건너뛰고 계속하기 버튼 클릭 완료:', { attemptLabel });
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
  console.log('[STEP] 원본(original) 라디오 선택 완료:', { selectedCount });
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

async function completeVideoMediaPickerFlow(page) {
  const selectedNext = await clickMediaPickerNextButton(page, 'video-after-media-select');
  if (!selectedNext) {
    await debugDump(page, 'next button not found after video media select');
    throw new Error('동영상 선택 후 다음 버튼을 찾지 못했습니다.');
  }

  const skipped = await clickMediaPickerSkipAndContinueButton(page, 'video-skip-processing');
  if (!skipped) {
    await debugDump(page, 'skip and continue button not found after video next');
    throw new Error('동영상 다음 단계 후 건너뛰고 계속하기 버튼을 찾지 못했습니다.');
  }

  await page.waitForTimeout(1000);
  await selectAllOriginalRadios(page);
  const originalStatus = await getOriginalRadioStatus(page);
  console.log('[STEP] 동영상 original 비율 선택 상태 확인:', {
    total: originalStatus.length,
    checked: originalStatus.filter((radio) => radio.checked).length,
    originalStatus,
  });

  const cropNext = await clickMediaPickerNextButton(page, 'video-after-original');
  if (!cropNext) {
    await debugDump(page, 'next button not found after video original');
    throw new Error('동영상 original 선택 후 다음 버튼을 찾지 못했습니다.');
  }

  const doneClicked = await clickMediaPickerDoneButton(page, 'video-generation-complete');
  if (!doneClicked) {
    await debugDump(page, 'done button not found after video generation');
    throw new Error('동영상 생성 단계 완료 버튼을 찾지 못했습니다.');
  }

  await page.waitForTimeout(1000);
  console.log('[STEP] 동영상 업로드/건너뛰기/original/완료 흐름 완료');
}

async function completeMediaPickerNextAndOriginalFlow(page, adFormat = 'image') {
  if (adFormat === 'video') {
    await completeVideoMediaPickerFlow(page);
    return;
  }

  const selectedNext = await clickMediaPickerNextButton(page, 'after-media-select');
  if (!selectedNext) {
    await debugDump(page, 'next button not found after media select');
    throw new Error('이미지 선택 후 다음 버튼을 찾지 못했습니다.');
  }

  await page.waitForTimeout(400);
  await selectAllOriginalRadios(page);

  const cropNext = await clickMediaPickerNextButton(page, 'after-original-crop');
  if (!cropNext) {
    await debugDump(page, 'next button not found after original crop');
    throw new Error('원본 자르기 선택 후 다음 버튼을 찾지 못했습니다.');
  }

  const textNext = await clickMediaPickerNextButton(page, 'after-text-step');
  if (!textNext) {
    await debugDump(page, 'next button not found after text step');
    throw new Error('문구 단계 다음 버튼을 찾지 못했습니다.');
  }

  const doneClicked = await clickMediaPickerDoneButton(page, 'image-generation-complete');
  if (!doneClicked) {
    await debugDump(page, 'done button not found after image generation');
    throw new Error('이미지 생성 단계 완료 버튼을 찾지 못했습니다.');
  }

  await page.waitForTimeout(500);
  console.log('[STEP] 이미지 선택/자르기/문구/생성 완료 흐름 완료');
}

async function fillLandingUrlOnly(page, targetAdName, landingUrl = '') {
  const targetUrl = landingUrl || `https://repurely.com/surl/P/100?utm_source=f&utm_medium=f&utm_campaign=${getLandingCampaignName(targetAdName)}`;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    console.log(`[STEP] 랜딩 URL input 탐색 시도 ${attempt}/6`);
    const landingInput = page
      .locator('input[placeholder="http://www.example.com/page"], input[placeholder*="example.com/page"]')
      .or(page.getByLabel(/웹사이트 URL|website url/i))
      .or(page.getByPlaceholder(/웹사이트 URL|website url/i))
      .first();

    const landingVisible = await landingInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (landingVisible) {
      console.log('[STEP] 랜딩 URL 입력 시작');
      await landingInput.click({ force: true });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(targetUrl, { delay: 40 });
      await page.waitForTimeout(3000);
      console.log('[STEP] 랜딩 URL 입력 완료:', { targetUrl });
      return;
    }

    // 직접 화면에서 URL 섹션을 노출시키기 위한 보정
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(2500);

    if (attempt === 3) {
      console.log('[WARN] 랜딩 URL input 미감지 - 크리에이티브 설정 재진입 후 재시도');
      await openCreativeSettingsAndFillLandingUrl(page, targetAdName);
      return;
    }
  }

  throw new Error('랜딩 URL input을 찾지 못했습니다.');
}

async function openCreativeSettingsAndFillLandingUrl(page, targetAdName, landingUrl = '', adFormat = AD_FORMAT) {
  const creativeSettings = page.locator('div.x78zum5.xdt5ytf.x2lwn1j.xeuugli.xkh2ocl').filter({ hasText: /크리에이티브 설정/ }).first().or(page.locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli.x1iyjqo2').filter({ hasText: /^크리에이티브 설정$/ }).first());
  const creativeAdPattern = getCreativeFormatPattern(adFormat);
  const creativeAdTab = page.locator('div.x1vvvo52.x1fvot60.xo1l8bm.xxio538.xbsr9hj.xq9mrsl.x1mzt3pk.x1vvkbs.x13faqbe.xeuugli.x1iyjqo2').filter({ hasText: creativeAdPattern }).first();
  const uploadButton = page.locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli').filter({ hasText: /^업로드$/ }).first();

  let creativeOpened = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    console.log(`[STEP] 크리에이티브 설정 진입 시도 ${attempt}/10`);
    const creativeVisible = await creativeSettings.isVisible({ timeout: 10000 }).catch(() => false);
    if (!creativeVisible) {
      console.log(`[WAIT] 크리에이티브 설정 버튼 탐색 재시도 ${attempt}/10`);
      await page.waitForTimeout(5000);
      continue;
    }

    await page.waitForTimeout(5000);
    const settingBox = await creativeSettings.boundingBox().catch(() => null);
    console.log('[DEBUG] 크리에이티브 설정 버튼 box:', settingBox);

    let clicked = false;
    await creativeSettings.click({ force: true }).then(() => { clicked = true; }).catch(() => null);

    if (!clicked && settingBox) {
      const clickTargets = [
        { x: settingBox.x + settingBox.width / 2, y: settingBox.y + settingBox.height / 2 },
        { x: settingBox.x + settingBox.width / 2 + 12, y: settingBox.y + settingBox.height / 2 },
        { x: settingBox.x + settingBox.width / 2 - 12, y: settingBox.y + settingBox.height / 2 },
        { x: settingBox.x + settingBox.width / 2, y: settingBox.y + settingBox.height / 2 + 8 },
        { x: settingBox.x + settingBox.width / 2, y: settingBox.y + settingBox.height / 2 - 8 },
      ];

      for (const [idx, pt] of clickTargets.entries()) {
        console.log('[DEBUG] 크리에이티브 설정 좌표 클릭 시도:', { attempt, index: idx + 1, pt });
        await page.mouse.click(pt.x, pt.y).catch(() => null);
        await page.waitForTimeout(2000);

        const checkCreativeAdMode = await creativeAdTab.isVisible({ timeout: 1000 }).catch(() => false);
        const checkUpload = await uploadButton.isVisible({ timeout: 1000 }).catch(() => false);
        if (checkCreativeAdMode || checkUpload) {
          clicked = true;
          break;
        }
      }
    }

    await page.waitForTimeout(7000);

    const openedByCreativeAdMode = await creativeAdTab.isVisible({ timeout: 5000 }).catch(() => false);
    const openedByUpload = await uploadButton.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('[DEBUG] creative settings opened check:', { adFormat, openedByCreativeAdMode, openedByUpload });

    if (openedByCreativeAdMode && openedByUpload) {
      creativeOpened = true;
      console.log('[STEP] 크리에이티브 설정 진입 성공');
      break;
    }

    console.log(`[WAIT] 크리에이티브 설정 진입 확인 재시도 ${attempt}/10`);
    await page.waitForTimeout(5000);
  }

  if (!creativeOpened) {
    await debugDump(page, 'creative settings not opened after retries');
    throw new Error('크리에이티브 설정 진입 실패: 이미지 광고/업로드 확인 불가');
  }

  console.log('[STEP] creative settings opened - selecting ad mode from env');
  await selectCreativeAdModeWithRequestedClasses(page, adFormat);
  await page.waitForTimeout(4000);

  const targetUrl = landingUrl || `https://repurely.com/surl/P/100?utm_source=f&utm_medium=f&utm_campaign=${getLandingCampaignName(targetAdName)}`;
  const landingInput = page.locator('input[placeholder="http://www.example.com/page"]').first();
  const landingVisible = await landingInput.isVisible({ timeout: 10000 }).catch(() => false);
  if (landingVisible) {
    console.log('[STEP] 랜딩 URL 입력 시작');
    await landingInput.click({ force: true });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(targetUrl, { delay: 40 });
    await page.waitForTimeout(3000);
    console.log('[STEP] 랜딩 URL 입력 완료:', { targetUrl });
  } else {
    throw new Error('랜딩 URL input을 찾지 못했습니다.');
  }
}


async function enterCreativeInsideEditor(page, adFormat = AD_FORMAT) {
  console.log('[STEP] creative internal entry started:', { adFormat, label: getCreativeFormatLabel(adFormat) });

  const creativeSettings = page
    .locator('div.x78zum5.xdt5ytf.x2lwn1j.xeuugli.xkh2ocl')
    .filter({ hasText: /크리에이티브 설정/ })
    .first()
    .or(
      page
        .locator('div.x1vvvo52.x1fvot60.xk50ysn.xxio538.x1heor9g.xuxw1ft.x6ikm8r.x10wlt62.xlyipyv.x1h4wwuj.xeuugli.x1iyjqo2')
        .filter({ hasText: /^크리에이티브 설정$/ })
        .first(),
    )
    .or(page.getByText(/^크리에이티브 설정$/).first());

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    console.log(`[STEP] 크리에이티브 설정 버튼 클릭 시도 ${attempt}/10`);
    const visible = await creativeSettings.isVisible({ timeout: 10000 }).catch(() => false);
    if (!visible) {
      console.log(`[WAIT] 크리에이티브 설정 버튼 대기 ${attempt}/10`);
      await page.waitForTimeout(5000);
      continue;
    }

    await creativeSettings.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(2000);
    const box = await creativeSettings.boundingBox().catch(() => null);
    console.log('[DEBUG] 크리에이티브 설정 버튼 box:', box);

    await creativeSettings.click({ force: true }).catch(async () => {
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await page.waitForTimeout(6000);

    const creativeFormatVisible = await page.getByText(getCreativeFormatPattern(adFormat)).first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log('[DEBUG] creative settings click exposed ad mode:', { attempt, adFormat, creativeFormatVisible });
    if (creativeFormatVisible) {
      await selectCreativeAdModeWithRequestedClasses(page, adFormat);
      await page.waitForTimeout(4000);
      console.log('[STEP] creative settings -> ad mode entry completed:', { adFormat });
      return;
    }
  }

  await debugDump(page, 'creative settings button did not expose image ad button');
  throw new Error('크리에이티브 설정 버튼 클릭 후 이미지 광고 버튼을 찾지 못했습니다.');
}

async function renameAdsetsAndAdsSequentially(page, adsetStartIndex = 1, adsetCount = 10, adCreativeCount = 5) {
  console.log('[STEP] 광고세트/광고소재 순차 이름 변경 시작');

  let adsetIndex = adsetStartIndex;
  let adCreativeIndex = 1;
  const effectiveAdsetCount = adsetCount + 1;
  const effectiveCreativeCount = adCreativeCount + 1;
  const adsetEndIndex = adsetStartIndex + effectiveAdsetCount - 1;
  const maxCreativeTotal = effectiveAdsetCount * effectiveCreativeCount;
  const totalRenameTarget = (effectiveAdsetCount * effectiveCreativeCount) + effectiveAdsetCount;
  const maxRenameAttempts = totalRenameTarget;
  const processedAdsetRows = new Set();

  for (let attempt = 1; attempt <= maxRenameAttempts; attempt += 1) {
    await page.waitForTimeout(5000);
    let progressedThisAttempt = false;

    const rows = await page.locator('[role="row"]').elementHandles();
    if (!rows.length) {
      console.log(`[WAIT] row 미탐지 재시도 ${attempt}/${maxRenameAttempts}`);
      continue;
    }

    for (const row of rows) {
      const rowText = (await row.innerText().catch(() => '')).trim();
      if (!rowText) continue;

      const rowBox = await row.boundingBox().catch(() => null);
      if (!rowBox) continue;

      const rowId = await row
        .evaluate((el) => el.getAttribute('data-id') || el.id || el.querySelector('[data-id]')?.getAttribute('data-id') || '')
        .catch(() => '');
      const rowKey = rowId || `${Math.round(rowBox.x)}:${Math.round(rowBox.y)}:${rowText.slice(0, 80)}`;
      const targetAdsetName = adsetIndex <= adsetEndIndex
        ? (isBlogMixedCampaign() ? buildBlogAdsetName(adsetIndex, process.env) : (isVideoOnlyCampaign() ? buildVideoOnlyAdsetName(adsetIndex, process.env) : getAdsetName(adsetIndex)))
        : '';
      const isAlreadyTargetAdset = targetAdsetName && normalizeText(rowText).includes(normalizeText(targetAdsetName));
      const isAdsetCopy = rowText.includes('광고세트') && rowText.includes('사본');
      const isAdCopy = rowText.includes('새 판매 광고') || rowText.includes('광고 - 사본') || rowText.includes('광고명');
      const isBlogAdsetNameRow = isBlogMixedCampaign() && /f_i_b_o_l_\d{4}_\d+/i.test(rowText);
      const isBlogAdsetCopyRow = isBlogAdsetNameRow && /사본|copy/i.test(rowText);
      const isImageOnlyAdsetNameRow = !isBlogMixedCampaign() && /\d{4}\s+리타겟\s+\d+번\s+광고세트/i.test(rowText);
      const isVideoOnlyAdsetNameRow = isVideoOnlyCampaign() && /\d{4}\s+직접랜딩\s+광고세트\s*-\s*\d+/i.test(rowText);
      const shouldRenameAdsetRow = (isAdsetCopy || isBlogAdsetNameRow || isImageOnlyAdsetNameRow || isVideoOnlyAdsetNameRow) && adsetIndex <= adsetEndIndex;

      if (processedAdsetRows.has(rowKey) && (rowText.includes('광고세트') || rowText.includes(ADSET_BASE_NAME) || isBlogAdsetNameRow)) {
        console.log('[DEBUG] 이미 처리한 광고세트 row 건너뜀:', { rowKey, rowText: rowText.slice(0, 120) });
        continue;
      }

      if (isAlreadyTargetAdset && !isBlogAdsetCopyRow && isBlogMixedCampaign() && adsetIndex <= adsetEndIndex) {
        processedAdsetRows.add(rowKey);
        console.log('[STEP] 광고세트명 이미 변경됨 - 다음 광고세트로 이동:', { targetAdsetName, rowKey });
        adsetIndex += 1;
        progressedThisAttempt = true;
        continue;
      }

      if (shouldRenameAdsetRow) {
        await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
        await page.waitForTimeout(7000);

        const adsetInput = page.locator('input[placeholder="여기에 광고 세트 이름을 입력하세요..."], input[placeholder="광고 세트 이름 지정"]').first();
        const visible = await adsetInput.isVisible({ timeout: 5000 }).catch(() => false);
        if (visible) {
          await adsetInput.click({ force: true });
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.press('Backspace');
          await page.keyboard.type(targetAdsetName, { delay: 60 });
          await page.waitForTimeout(5000);
          const actualAdsetName = await adsetInput.inputValue().catch(() => '');
          console.log('[STEP] 광고세트명 변경:', { targetAdsetName, actualAdsetName });
          if (!actualAdsetName.includes(targetAdsetName)) {
            throw new Error(`광고세트명 입력 확인 실패: expected=${targetAdsetName}, actual=${actualAdsetName}`);
          }
          processedAdsetRows.add(rowKey);
          adsetIndex += 1;
          progressedThisAttempt = true;
          continue;
        }
      }

      if (isAdCopy && adCreativeIndex <= maxCreativeTotal) {
        await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
        await page.waitForTimeout(7000);

        const adNameInput = page.locator('input[placeholder="여기에 광고 이름을 입력하세요..."], input[placeholder*="광고 이름"], input[value*="새 판매 광고"]').first();
        const visible = await adNameInput.isVisible({ timeout: 5000 }).catch(() => false);
        if (!visible) continue;

        const blogAdPlan = isBlogMixedCampaign() ? getBlogAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
        const videoAdPlan = isVideoOnlyCampaign() ? getVideoOnlyAdPlanBySequence(activeCampaignPlan, adCreativeIndex) : null;
        if (isBlogMixedCampaign() && !blogAdPlan) {
          throw new Error(`BLOG_MIXED ad plan not found for creative sequence ${adCreativeIndex}`);
        }
        if (isVideoOnlyCampaign() && !videoAdPlan) {
          throw new Error(`VIDEO_ONLY ad plan not found for creative sequence ${adCreativeIndex}`);
        }
        const targetPlan = blogAdPlan || videoAdPlan;
        const targetAdName = targetPlan?.name || getAdName(adCreativeIndex);
        const targetLandingUrl = targetPlan?.landingUrl || '';
        const targetAdFormat = targetPlan?.type || AD_FORMAT;
        const targetAssetPath = targetPlan?.assetPath || '';

        await adNameInput.click({ force: true });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(targetAdName, { delay: 60 });
        await page.waitForTimeout(5000);
        console.log('[STEP] 광고소재명 변경:', { targetAdName });
        const actualAdName = await adNameInput.inputValue().catch(() => '');
        console.log('[DEBUG] 광고소재명 입력 확인:', { targetAdName, actualAdName });
        if (!actualAdName.includes(targetAdName)) {
          throw new Error(`광고소재명 입력 확인 실패: expected=${targetAdName}, actual=${actualAdName}`);
        }

        console.log('[STEP] ad creative plan:', {
          campaignMode: CAMPAIGN_MODE,
          adsetIndex: targetPlan?.adsetIndex,
          adsetName: targetPlan?.adsetName,
          adType: targetAdFormat,
          targetAdName,
          targetLandingUrl,
          targetAssetPath,
        });

        await fillLandingUrlOnly(page, targetAdName, targetLandingUrl);
        await page.waitForTimeout(5000);
        console.log('[STEP] 랜딩 URL 단계 완료 후 안정화 대기 완료:', { targetAdName });

        await enterCreativeInsideEditor(page, targetAdFormat);
        await page.waitForTimeout(5000);
        console.log('[STEP] creative format step completed:', { targetAdName, targetAdFormat });

        if (isBlogMixedCampaign() || isVideoOnlyCampaign()) {
          await page.waitForTimeout(5000);
          await attachMediaFromFolderIfConfigured(page, targetAdName, [targetAssetPath], targetAdFormat);
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
          await page.waitForTimeout(3000);
          await attachMediaFromFolderIfConfigured(page, targetAdName, [imageAssetPath], 'image');
          console.log('[STEP] IMAGE_ONLY PER_AD media upload completed:', {
            targetAdName,
            targetAssetPath: imageAssetPath,
          });
        } else if (adCreativeIndex === 1 && !firstCreativeMediaUploaded) {
          await page.waitForTimeout(5000);
          await attachMediaFromFolderIfConfigured(page, targetAdName);
          firstCreativeMediaUploaded = true;
          console.log('[STEP] 첫 번째 광고소재 미디어 업로드 완료');
        } else {
          await page.waitForTimeout(3000);
          await searchAndSelectExistingMedia(page, targetAdName);
          console.log('[STEP] 기존 업로드 이미지 선택 완료:', { targetAdName });
        }

        await page.waitForTimeout(7000);
        console.log('[STEP] 광고소재 미디어 처리 전체 완료 - 다음 광고 탐색 전 대기 완료:', { targetAdName });

        adCreativeIndex += 1;
        progressedThisAttempt = true;
      }
    }

    console.log('[DEBUG] 순차 변경 진행도:', {
      adsetIndex,
      adsetEndIndex,
      adCreativeIndex,
      maxCreativeTotal,
      effectiveAdsetCount,
      adCreativeCount,
      effectiveCreativeCount,
      totalRenameTarget,
    });

    if (adsetIndex > adsetEndIndex && adCreativeIndex > maxCreativeTotal) {
      console.log('[STEP] 광고세트/광고소재 순차 이름 변경 완료');
      return true;
    }

    console.log(`[WAIT] 순차 이름 변경 재탐색 ${attempt}/${maxRenameAttempts}`, { progressedThisAttempt });
    await page.mouse.wheel(0, progressedThisAttempt ? 250 : 700);
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: path.join(DIRS.screenshots, 'adset-ad-rename-sequence-failed.png'), fullPage: true });
  throw new Error('광고세트/광고소재 순차 이름 변경 실패');
}


async function runCreativeStepOnly(page) {
  console.log('[STEP] QUICK_TEST_CREATIVE_STEP=true - 크리에이티브 단계만 실행');
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
  await page.screenshot({ path: path.join(DIRS.screenshots, 'quick-creative-step-done.png'), fullPage: true });
}

async function runFlow(page) {
  if (QUICK_TEST_CREATIVE_STEP) {
    await runCreativeStepOnly(page);
    return;
  }

  console.log('[STEP] Ads Manager 접속');
  await page.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'domcontentloaded' });
  await ensureLoggedInOrThrow(page);
  await page.screenshot({ path: PATHS.step1, fullPage: true });

  console.log(`[STEP] 광고계정 이동: act=${AD_ACCOUNT_ID}`);
  await page.goto(`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT_ID}`, { waitUntil: 'domcontentloaded' });
  await pause(page, '광고계정 이동 후 대기', 3000);
  console.log('[DEBUG] URL:', page.url());
  console.log('[DEBUG] TITLE:', await page.title());
  await page.screenshot({ path: PATHS.step2, fullPage: true });

  await trySearchBox(page, CAMPAIGN_NAME);
  const campaignTarget = await findCampaignTarget(page, CAMPAIGN_NAME);
  if (!campaignTarget) {
    await logCampaignCandidates(page, 10);
    throw new Error(`CAMPAIGN_NAME partial match 실패: ${CAMPAIGN_NAME}`);
  }

  await campaignTarget.click();
  await page.screenshot({ path: PATHS.step3, fullPage: true });
  await page.waitForLoadState('domcontentloaded');
  await page.screenshot({ path: PATHS.step4, fullPage: true });

  for (let n = 0; n < 1; n += 1) {
    const index = (isBlogMixedCampaign() || isVideoOnlyCampaign()) ? n + 1 : ADSET_START_INDEX + n;
    const adsetName = isBlogMixedCampaign()
      ? buildBlogAdsetName(index, process.env)
      : (isVideoOnlyCampaign() ? buildVideoOnlyAdsetName(index, process.env) : getAdsetName(index));
    console.log(`[STEP] ${n + 1}/1 광고 세트 생성 시작: ${adsetName}`);

    await clickRealCreateButton(page);
    await pause(page, '만들기 버튼 클릭 후 대기', 3000);
    await page.screenshot({ path: PATHS.step5, fullPage: true });
    await enterAdsetFlow(page);
    await pause(page, '광고 세트 생성 화면 진입 후 대기', 3000);
    await page.screenshot({ path: PATHS.step6, fullPage: true });

    await fillAdsetNameInAdsetModalOnly(page, adsetName);

    const scheduleReady = await updateDateAndTimeBeforeContinue(page);
    if (!scheduleReady) {
      throw new Error('스케줄링 영역 확인 실패: 날짜 input을 찾지 못했습니다.');
    }
    await fillAdsetDailyBudgetAfterSchedule(page);

    const adCreativeDuplicateCount = isBlogMixedCampaign()
      ? Math.max((activeCampaignPlan?.totalAdsPerAdset || 5) - 1, 0)
      : (isVideoOnlyCampaign() ? Math.max((activeCampaignPlan?.totalAdsPerAdset || AD_CREATIVE_COUNT + 1) - 1, 0) : Math.max(AD_CREATIVE_COUNT, 0));
    if (adCreativeDuplicateCount > 0) {
      await pause(page, '스케줄링 후 새 판매 광고 복제 설정 전 대기', 5000);
      await setDuplicateCount(page, adCreativeDuplicateCount, '새 판매 광고');
      await pause(page, '새 판매 광고 복제 설정 후 대기', 7000);
    }

    const adsetDuplicateCount = isBlogMixedCampaign()
      ? Math.max((activeCampaignPlan?.adsetCount || ADSET_COUNT) - 1, 0)
      : (isVideoOnlyCampaign() ? Math.max((activeCampaignPlan?.adsetCount || ADSET_COUNT + 1) - 1, 0) : Math.max(ADSET_COUNT, 0));
    if (adsetDuplicateCount > 0) {
      await pause(page, '스케줄링 후 광고세트 복제 설정 전 대기', 5000);
      await setDuplicateCount(page, adsetDuplicateCount, adsetName);
      await pause(page, '광고세트 복제 설정 후 대기', 7000);
    }

    if (n === 0) {
      await renameAdsetsAndAdsSequentially(page, (isBlogMixedCampaign() || isVideoOnlyCampaign()) ? 1 : ADSET_START_INDEX, adsetDuplicateCount, adCreativeDuplicateCount);
    }

  }

  await page.screenshot({ path: PATHS.success, fullPage: true });

}

async function main() {
  validateEnv();
  const validation = await validateCampaignConfig(process.env, { baseDir: process.cwd() });
  activeCampaignPlan = validation.plan;
  if (validation.mode === CAMPAIGN_MODES.IMAGE_ONLY && activeCampaignPlan?.uploadMode === 'PER_AD') {
    imageOnlyPerAdAssets = activeCampaignPlan.imageAssets || [];
  }
  if (validation.mode === CAMPAIGN_MODES.VIDEO_ONLY) {
    videoOnlyAssets = activeCampaignPlan.videoAssets || [];
  }
  console.log('[CONFIG] campaign mode:', validation.mode);
  if (imageOnlyPerAdAssets.length) {
    console.log('[CONFIG] image-only upload mode: PER_AD');
    console.log('[CONFIG] image-only per-ad asset count:', imageOnlyPerAdAssets.length);
  }

  if (DRY_RUN) {
    if (validation.mode === CAMPAIGN_MODES.BLOG_MIXED || validation.mode === CAMPAIGN_MODES.VIDEO_ONLY) {
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
    return;
  }

  await ensureDirs();
  console.log(`[OPEN] 기존 Chrome 세션에 CDP attach: ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);

  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('연결된 Chrome context가 없습니다.');
    const page = context.pages()[0] ?? (await context.newPage());
    await runFlow(page);
  } catch (error) {
    console.error('[OPEN] 실행 실패:', error);
    try {
      const context = browser.contexts()[0];
      const page = context?.pages()?.[0];
      if (page) await page.screenshot({ path: PATHS.error, fullPage: true });
    } catch {}
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[FATAL ERROR]', error);
  process.exit(1);
});
