import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseNotifyBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

export function getNotificationConfig(env = process.env) {
  return {
    enabled: parseNotifyBoolean(env.ENABLE_DESKTOP_ALERT, false),
    appName: env.NOTIFICATION_APP_NAME || 'Meta Ads Automation',
    successTitle: env.NOTIFICATION_SUCCESS_TITLE || '작업 완료',
    errorTitle: env.NOTIFICATION_ERROR_TITLE || '작업 중단',
    timeoutTitle: env.NOTIFICATION_TIMEOUT_TITLE || '업로드 지연',
    notifyOnSuccess: parseNotifyBoolean(env.NOTIFY_ON_SUCCESS, true),
    notifyOnError: parseNotifyBoolean(env.NOTIFY_ON_ERROR, true),
    notifyOnStop: parseNotifyBoolean(env.NOTIFY_ON_STOP, true),
    notifyOnVideoUploadTimeout: parseNotifyBoolean(env.NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT, true),
  };
}

function compactMessage(message, detail) {
  const parts = [message, detail].filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
  const combined = parts.join('\n');
  return combined.length > 420 ? `${combined.slice(0, 417)}...` : combined;
}

function titleForType(type, config) {
  if (type === 'success') return config.successTitle;
  if (type === 'video_upload_timeout') return config.timeoutTitle;
  return config.errorTitle;
}

function enabledForType(type, config) {
  if (!config.enabled) return false;
  if (type === 'success') return config.notifyOnSuccess;
  if (type === 'error') return config.notifyOnError;
  if (type === 'stop') return config.notifyOnStop;
  if (type === 'video_upload_timeout') return config.notifyOnVideoUploadTimeout;
  return true;
}

async function runDesktopNotification({ title, message, config }) {
  const platform = os.platform();
  if (platform === 'darwin') {
    await execFileAsync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(config.appName)} subtitle ${JSON.stringify(title)}`,
    ], { timeout: 5000 });
    return true;
  }

  if (platform === 'win32') {
    const payload = Buffer.from(JSON.stringify({ title, message }), 'utf8').toString('base64');
    const psScript = [
      `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
      '$title = [string]$payload.title',
      '$message = [string]$payload.message',
      'try {',
      '  $wshell = New-Object -ComObject WScript.Shell;',
      '  $wshell.Popup($message, 8, $title, 64) | Out-Null;',
      '} catch {',
      '  Add-Type -AssemblyName PresentationFramework -ErrorAction Stop;',
      '  [System.Windows.MessageBox]::Show($message, $title) | Out-Null;',
      '}',
    ].join('\n');
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand,
    ], { timeout: 12000 });
    return true;
  }

  await execFileAsync('notify-send', [title, message], { timeout: 5000 });
  return true;
}

export async function notifyWithConfig(type, message, detail = '', options = {}) {
  const config = getNotificationConfig(options.env || process.env);
  const title = options.title || titleForType(type, config);
  const body = compactMessage(message, detail);
  const adapters = options.adapters || {};

  if (!enabledForType(type, config)) {
    console.log('[NOTIFY] skipped:', { type, enabled: config.enabled });
    return { sent: false, skipped: true, title, message: body };
  }

  try {
    if (adapters.desktop) {
      await adapters.desktop({ title, message: body, config, type });
    } else {
      await runDesktopNotification({ title, message: body, config });
    }
    console.log('[NOTIFY] sent:', { type, title, message: body });
    return { sent: true, title, message: body };
  } catch (error) {
    console.warn('[NOTIFY] desktop notification failed:', error.message);
    try {
      if (adapters.console) adapters.console({ title, message: body, type, error });
      else console.log(`[${config.appName}] ${title}: ${body}`);
    } catch (fallbackError) {
      console.warn('[NOTIFY] console fallback failed:', fallbackError.message);
    }
    return { sent: false, fallback: true, title, message: body, error };
  }
}

export function notifySuccess(message, detail, options) {
  return notifyWithConfig('success', message, detail, options);
}

export function notifyError(message, detail, options) {
  return notifyWithConfig('error', message, detail, options);
}

export function notifyStop(message, detail, options) {
  return notifyWithConfig('stop', message, detail, options);
}

export function notifyVideoUploadTimeout(message, detail, options) {
  return notifyWithConfig('video_upload_timeout', message, detail, options);
}

export function notifyInfo(title, message, options = {}) {
  return notifyWithConfig('info', message, '', { ...options, title });
}

export function classifyAutomationError(error) {
  const message = String(error?.message || error || '');
  if (/Video upload completion was not confirmed|video upload ambiguous|60s|upload timeout|업로드.*60초|업로드 지연/i.test(message)) {
    return 'video_upload_timeout';
  }
  if (/validation|validate|CAMPAIGN_|ADSET_|LANDING_URL|Video file not found|requires|must be|누락|검증|limit guard|안전 제한/i.test(message)) {
    return 'stop';
  }
  return 'error';
}
