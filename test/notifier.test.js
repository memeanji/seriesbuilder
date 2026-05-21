import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAutomationError,
  notifyError,
  notifyStop,
  notifySuccess,
  notifyVideoUploadTimeout,
  notifyWithConfig,
} from '../src/notifier.js';

const enabledEnv = {
  ENABLE_DESKTOP_ALERT: 'true',
  NOTIFY_ON_SUCCESS: 'true',
  NOTIFY_ON_ERROR: 'true',
  NOTIFY_ON_STOP: 'true',
  NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT: 'true',
  NOTIFICATION_APP_NAME: 'Test App',
  NOTIFICATION_SUCCESS_TITLE: 'Success',
  NOTIFICATION_ERROR_TITLE: 'Stopped',
  NOTIFICATION_TIMEOUT_TITLE: 'Upload delayed',
};

test('ENABLE_DESKTOP_ALERT=false skips desktop notification', async () => {
  let desktopCalls = 0;
  const result = await notifyWithConfig('success', 'done', '', {
    env: { ...enabledEnv, ENABLE_DESKTOP_ALERT: 'false' },
    adapters: {
      desktop: async () => { desktopCalls += 1; },
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(desktopCalls, 0);
});

test('notify_success calls desktop adapter', async () => {
  const calls = [];
  const result = await notifySuccess('complete', 'detail', {
    env: enabledEnv,
    adapters: {
      desktop: async (payload) => calls.push(['desktop', payload.title]),
    },
  });

  assert.equal(result.sent, true);
  assert.deepEqual(calls, [['desktop', 'Success']]);
});

test('notify_error calls error title', async () => {
  const calls = [];
  await notifyError('failed', 'detail', {
    env: enabledEnv,
    adapters: {
      desktop: async (payload) => calls.push(payload.title),
    },
  });

  assert.deepEqual(calls, ['Stopped']);
});

test('notifier adapter failure does not throw', async () => {
  const result = await notifySuccess('complete', '', {
    env: enabledEnv,
    adapters: {
      desktop: async () => { throw new Error('desktop unavailable'); },
      console: () => null,
    },
  });

  assert.equal(result.fallback, true);
});

test('ValidationError-like messages classify as stop', () => {
  assert.equal(classifyAutomationError(new Error('CAMPAIGN_BUDGET must be a positive integer')), 'stop');
  assert.equal(classifyAutomationError(new Error('Video file not found for ad name: test')), 'stop');
});

test('VideoUploadTimeout-like messages classify as video_upload_timeout', () => {
  assert.equal(
    classifyAutomationError(new Error('Video upload completion was not confirmed within 60s for f_v_b_o_l_0521_5')),
    'video_upload_timeout',
  );
});

test('general exceptions classify as error', () => {
  assert.equal(classifyAutomationError(new Error('Cannot click creative settings')), 'error');
});

test('notify_stop and notify_video_upload_timeout use expected titles', async () => {
  const titles = [];
  await notifyStop('validation stopped', '', {
    env: enabledEnv,
    adapters: { desktop: async (payload) => titles.push(payload.title) },
  });
  await notifyVideoUploadTimeout('upload timeout', '', {
    env: enabledEnv,
    adapters: { desktop: async (payload) => titles.push(payload.title) },
  });

  assert.deepEqual(titles, ['Stopped', 'Upload delayed']);
});
