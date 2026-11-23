import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { pose } from './fixtures.mjs';

const hasThinkingImage = existsSync(new URL('../local-memes/thinking-meme.jpg', import.meta.url));

async function injectCamera(page) {
  await page.addInitScript(() => {
    window.detectorCloses = 0;
    window.streams = [];
    window.videoFrames = 0;
    window.cameras = [
      { kind: 'videoinput', deviceId: 'front', label: '前置摄像头' },
      { kind: 'videoinput', deviceId: 'external', label: '外置摄像头' },
    ];
    navigator.mediaDevices.enumerateDevices = async () => {
      if (window.delayDevices) await new Promise((resolve) => { window.finishDevices = resolve; });
      return window.cameras;
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (window.cameraError) throw new DOMException('', window.cameraError);
      window.constraints = constraints;
      if (window.delayCamera) await new Promise((resolve) => { window.finishCamera = resolve; });
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const [track] = stream.getVideoTracks();
      const deviceId = constraints.video.deviceId?.exact ?? 'front';
      track.getSettings = () => ({ deviceId });
      const interval = setInterval(() => {
        if (track.readyState === 'ended') {
          clearInterval(interval);
          return;
        }
        if (!window.freezeVideo) {
          context.fillRect(0, 0, canvas.width, canvas.height);
          window.videoFrames++;
        }
      }, 33);
      window.streams.push(stream);
      return stream;
    };
  });
}

async function injectDetector(page) {
  await injectCamera(page);
  await page.route(/\/src\/pose\.ts(?:\?|$)/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `export async function loadDetector() {
      if (window.loadError) throw new Error('failed model');
      if (window.delayModel) await new Promise((resolve) => { window.finishModel = resolve; });
      return {
        detect: () => window.poseSequence?.shift() ?? window.pose ?? [],
        close: () => { window.detectorCloses++; },
      };
    }`,
  }));
  await page.goto('/');
}

const actionButton = (page, name) => page.getByRole('button', { name });
async function begin(page) {
  await actionButton(page, '开启摄像头').click();
  await expect(page.getByRole('status')).toHaveText('识别中');
}

test('five gestures share one session, and the chin result repeats with optional freeze', async ({ page }) => {
  await injectDetector(page);
  await page.getByText('骨架调试').click();
  await begin(page);
  for (const [action, caption] of [
    ['hands-up', '我投降'], ['arms-out', '我宣布个事'], ['arms-crossed', '这事我不同意'],
  ]) {
    await page.evaluate((points) => { window.pose = points; }, pose(action));
    await expect(page.locator('#meme-caption')).toHaveText(caption);
    await expect.poll(() => page.locator('#meme-image').evaluate((image) => image.naturalWidth)).toBe(420);
  }
  await page.evaluate((sequence) => {
    window.pose = [];
    window.poseSequence = sequence;
  }, [0, 15, 40, 15, 0].map((offset) => pose('wave-left', offset)));
  await expect(page.locator('#meme-caption')).toHaveText('嗨，看到我了吗');
  await expect(page.locator('#recognition-feedback')).toContainText('未检测到人物');
  await expect(page.locator('#meme-caption')).toHaveText('嗨，看到我了吗');
  await page.evaluate((points) => { window.pose = points; }, pose('hand-on-chin'));
  await expect(page.locator('#meme-caption')).toHaveText('让我想想');
  await expect(page.locator('#meme-action')).toHaveText('手抵下巴');
  await expect(page.locator('#freeze-frame')).toBeHidden();
  if (hasThinkingImage) {
    await expect.poll(() => page.locator('#meme-image').evaluate((image) => image.naturalWidth)).toBe(300);
    await expect(page.locator('#meme-image')).toHaveAttribute('alt', '黄色角色用一只手抵着下巴思考');
  } else {
    await expect(page.locator('#meme-image')).toBeHidden();
  }
  await page.getByRole('checkbox', { name: '本人定格' }).check();
  await page.evaluate((points) => { window.pose = points; }, pose('arms-out'));
  await expect(page.locator('#meme-caption')).toHaveText('我宣布个事');
  await page.evaluate((points) => { window.pose = points; }, pose('chin-right'));
  await expect(page.locator('#meme-caption')).toHaveText('让我想想');
  await expect(page.locator('#freeze-frame')).toBeVisible();
  await expect(page.locator('#freeze-caption')).toHaveText('让我想想');
  expect(await page.evaluate(() => window.streams.length)).toBe(1);
  await expect(page.locator('#skeleton')).toBeVisible();
  await actionButton(page, '关闭摄像头').click();
  await expect(page.getByText('等待第一个动作')).toBeVisible();
  await expect(page.locator('#preview')).toBeHidden();
  await expect(page.locator('#freeze-frame')).toBeHidden();
  await expect(page.locator('#freeze-canvas')).toHaveAttribute('width', '0');
  expect(await page.evaluate(() => ({
    track: window.streams[0].getVideoTracks()[0].readyState,
    audio: window.constraints.audio,
    closes: window.detectorCloses,
    source: document.querySelector('video').srcObject,
  }))).toEqual({ track: 'ended', audio: false, closes: 1, source: null });
  await begin(page);
  await expect(page.getByText('等待第一个动作')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.streams[1].getVideoTracks()[0].readyState)).toBe('ended');
});

test('intermittent elbow occlusion recovers in one session, while persistent occlusion preserves the last result', async ({ page }) => {
  await injectDetector(page);
  await page.getByText('骨架调试').click();
  await page.evaluate((points) => { window.pose = points; }, pose('hands-up'));
  await begin(page);
  await expect(page.locator('#meme-caption')).toHaveText('我投降');
  await page.evaluate((points) => { window.pose = points; }, pose('arms-out'));
  await expect(page.locator('#recognition-feedback')).toContainText('请保持「双臂横举」');
  const occluded = pose('arms-out');
  occluded[13].visibility = 0.54;
  await page.evaluate((points) => { window.pose = points; }, occluded);
  await expect(page.locator('#recognition-feedback')).toHaveText('请露出手肘');
  await expect(page.locator('#diagnosis')).toContainText('关键点遮挡超时');
  await expect(page.locator('#meme-caption')).toHaveText('我投降');
  const stable = pose('arms-out');
  await page.evaluate(({ stable, occluded }) => {
    window.poseSequence = Array.from({ length: 30 }, (_, index) => index % 4 === 3 ? occluded : stable);
  }, { stable, occluded });
  await expect(page.locator('#meme-caption')).toHaveText('我宣布个事');
  expect(await page.evaluate(() => window.poseSequence.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.streams.length)).toBe(1);
});

test('freeze is opt-in and late animation callbacks cannot clear the next action', async ({ page }) => {
  await injectDetector(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.animate;
    window.finishEffects = [];
    HTMLCanvasElement.prototype.animate = function (...args) {
      if (this.id !== 'freeze-canvas') return original.apply(this, args);
      return {
        finished: new Promise((resolve) => window.finishEffects.push(resolve)),
        cancel() {},
      };
    };
  });
  const toggle = page.getByRole('checkbox', { name: '本人定格' });
  const frozen = page.locator('#freeze-frame');
  const setPose = (action) => page.evaluate((points) => { window.pose = points; }, pose(action));
  await setPose('hands-up');
  await begin(page);
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#meme-caption')).toHaveText('我投降');
  await expect(frozen).toBeHidden();
  await toggle.check();

  await setPose('arms-out');
  await expect(frozen).toBeVisible();
  await expect(page.locator('#freeze-caption')).toHaveText('我宣布个事');
  await expect(page.locator('#freeze-canvas')).toHaveAttribute('width', '640');
  await expect(page.locator('#preview')).toBeVisible();
  await setPose('arms-crossed');
  await expect(page.locator('#freeze-caption')).toHaveText('这事我不同意');
  await page.evaluate(() => window.finishEffects[0]());
  await expect(frozen).toBeVisible();
  await page.evaluate(() => window.finishEffects[1]());
  await expect(frozen).toBeHidden();
  await expect(page.locator('#freeze-canvas')).toHaveAttribute('width', '0');
  await expect(page.locator('#meme-caption')).toHaveText('这事我不同意');
});

test('all four actions get the current freeze caption and the first action can repeat in one session', async ({ page }) => {
  await injectDetector(page);
  const toggle = page.getByRole('checkbox', { name: '本人定格' });
  const frozen = page.locator('#freeze-frame');
  const caption = page.locator('#meme-caption');
  await begin(page);
  await toggle.check();
  for (const [action, expected] of [
    ['hands-up', '我投降'], ['arms-out', '我宣布个事'], ['arms-crossed', '这事我不同意'],
    ['wave', '嗨，看到我了吗'], ['hands-up', '我投降'],
  ]) {
    if (action === 'wave') {
      await page.evaluate((sequence) => {
        window.pose = sequence.at(-1);
        window.poseSequence = sequence;
      }, [0, 15, 40, 15, 0].map((offset) => pose('wave-left', offset)));
    } else {
      await page.evaluate((points) => { window.pose = points; }, pose(action));
    }
    await expect(caption).toHaveText(expected);
    await expect(page.locator('#freeze-caption')).toHaveText(expected);
    await expect(frozen).toBeVisible();
  }
  expect(await page.evaluate(() => window.streams.length)).toBe(1);
  await actionButton(page, '关闭摄像头').click();
  await expect(frozen).toBeHidden();
  await expect(page.locator('#freeze-canvas')).toHaveAttribute('width', '0');
});


test('reduced motion displays a static freeze, and tracking loss, opt-out and capture failure fall back to the cat', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await injectDetector(page);
  const toggle = page.getByRole('checkbox', { name: '本人定格' });
  const frozen = page.locator('#freeze-frame');
  const setPose = (action) => page.evaluate((points) => { window.pose = points; }, action ? pose(action) : []);
  const resetHold = async () => {
    await setPose('arms-out');
    await expect(page.locator('#meme-caption')).toHaveText('我宣布个事');
  };
  await begin(page);
  await toggle.check();
  await setPose('hands-up');
  await expect(frozen).toBeVisible();
  expect(await frozen.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  await setPose();
  await expect(page.locator('#recognition-feedback')).toContainText('未检测到人物');
  await expect(frozen).toBeHidden();
  await expect(page.locator('#meme-caption')).toHaveText('我投降');

  await resetHold();
  await setPose('hands-up');
  await expect(frozen).toBeVisible();
  await toggle.uncheck();
  await expect(frozen).toBeHidden();

  await resetHold();
  await toggle.check();
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.id === 'freeze-canvas') throw new Error('capture failed');
      return original.apply(this, args);
    };
  });
  await setPose('hands-up');
  await expect(page.locator('#meme-caption')).toHaveText('我投降');
  await expect(frozen).toBeHidden();
  await expect(page.locator('#meme-image')).toBeVisible();
});

test('switching cameras releases the prior stream, ignores late device lists and clears the current effect', async ({ page }) => {
  await injectDetector(page);
  await begin(page);
  const devices = page.getByRole('combobox', { name: '摄像头' });
  await expect(devices).toHaveValue('front');
  await page.getByRole('checkbox', { name: '本人定格' }).check();
  await page.evaluate((points) => { window.pose = points; }, pose('hands-up'));
  await expect(page.locator('#freeze-frame')).toBeVisible();
  await page.evaluate(() => {
    window.pose = [];
    window.delayDevices = true;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.finishDevices))).toBe(true);
  await page.evaluate(() => { window.delayDevices = false; });
  await devices.selectOption('external');
  await expect(devices).toHaveValue('external');
  await page.evaluate(() => window.finishDevices());
  await expect(devices).toHaveValue('external');
  await expect(page.getByText('等待第一个动作')).toBeVisible();
  await expect(page.locator('#freeze-canvas')).toHaveAttribute('width', '0');
  expect(await page.evaluate(() => ({
    requested: window.constraints.video.deviceId.exact,
    tracks: window.streams.map((stream) => stream.getVideoTracks()[0].readyState),
    closes: window.detectorCloses,
  }))).toEqual({ requested: 'external', tracks: ['ended', 'live'], closes: 1 });

  await page.evaluate(() => window.streams[0].getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await expect(page.getByRole('status')).toHaveText('识别中');
  await actionButton(page, '关闭摄像头').click();
  expect(await page.evaluate(() => window.streams[1].getVideoTracks()[0].readyState)).toBe('ended');
});

test('a stalled video is reported separately from disconnection and can be restarted', async ({ page }) => {
  await injectDetector(page);
  await begin(page);
  await expect(page.locator('#recognition-feedback')).toContainText('未检测到人物');
  await page.evaluate(() => { window.freezeVideo = true; });
  await expect(page.getByRole('alert')).toContainText('长时间没有更新', { timeout: 6000 });
  expect(await page.evaluate(() => window.streams[0].getVideoTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => { window.freezeVideo = false; });
  await actionButton(page, '重试').click();
  await expect(page.locator('#recognition-feedback')).toContainText('未检测到人物');
  expect(await page.evaluate(() => window.streams.length)).toBe(2);
});


test('permission denial, device busy, and disconnection each support retry', async ({ page }) => {
  await injectDetector(page);
  await page.evaluate(() => { window.cameraError = 'NotAllowedError'; });
  await actionButton(page, '开启摄像头').click();
  await expect(page.getByRole('alert')).toContainText('权限被拒绝');
  await page.evaluate(() => { window.cameraError = 'NotReadableError'; });
  await actionButton(page, '重试').click();
  await expect(page.getByRole('alert')).toContainText('占用摄像头');
  await page.evaluate(() => { window.cameraError = undefined; });
  await actionButton(page, '重试').click();
  await expect(page.getByRole('status')).toHaveText('识别中');
  await page.evaluate(() => window.streams[0].getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await expect(page.getByRole('alert')).toContainText('摄像头已断开');
  expect(await page.evaluate(() => window.streams[0].getVideoTracks()[0].readyState)).toBe('ended');
  await actionButton(page, '重试').click();
  await expect(page.getByRole('status')).toHaveText('识别中');
});

test('model failure stops capture, late model instances close, and retry starts clean', async ({ page }) => {
  await injectDetector(page);
  await page.evaluate(() => { window.loadError = true; });
  await actionButton(page, '开启摄像头').click();
  await expect(page.getByRole('alert')).toContainText('姿态模型加载失败');
  expect(await page.evaluate(() => window.streams[0].getVideoTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => { window.loadError = false; window.delayModel = true; });
  await actionButton(page, '重试').click();
  await expect(page.getByRole('status')).toContainText('正在加载姿态模型');
  await expect.poll(() => page.evaluate(() => Boolean(window.finishModel))).toBe(true);
  await actionButton(page, '关闭摄像头').click();
  await page.evaluate(() => { window.delayModel = false; window.finishModel(); });
  await expect.poll(() => page.evaluate(() => window.detectorCloses)).toBe(1);
  await begin(page);
  await expect(page.getByText('等待第一个动作')).toBeVisible();
});

test('cancelling during permission wait stops the late stream', async ({ page }) => {
  await injectDetector(page);
  await page.evaluate(() => { window.delayCamera = true; });
  await actionButton(page, '开启摄像头').click();
  await expect.poll(() => page.evaluate(() => Boolean(window.finishCamera))).toBe(true);
  await actionButton(page, '关闭摄像头').click();
  await page.evaluate(() => { window.delayCamera = false; window.finishCamera(); });
  await expect.poll(() => page.evaluate(() => window.streams[0]?.getVideoTracks()[0].readyState)).toBe('ended');
  await expect(page.getByRole('status')).toHaveText('待开启');
  await begin(page);
});

test('image failure preserves both text fields', async ({ page }) => {
  await page.route('**/memes/hands-up.png', (route) => route.fulfill({ status: 404 }));
  await injectDetector(page);
  await page.evaluate((points) => { window.pose = points; }, pose('hands-up'));
  await begin(page);
  await expect(page.locator('#meme-caption')).toHaveText('我投降');
  await expect(page.locator('#meme-action')).toHaveText('双手举高');
  await expect(page.locator('#meme-image')).toBeHidden();
});

test('missing chin art still displays the fifth gesture and caption', async ({ page }) => {
  await page.route('**/local-memes/thinking-meme.jpg', (route) => route.fulfill({ status: 404 }));
  await injectDetector(page);
  await page.evaluate((points) => { window.pose = points; }, pose('hand-on-chin'));
  await begin(page);
  await expect(page.locator('#meme-action')).toHaveText('手抵下巴');
  await expect(page.locator('#meme-caption')).toHaveText('让我想想');
  await expect(page.locator('#meme-image')).toBeHidden();
});

test('production runs the real model and WASM from its own origin', async ({ page }) => {
  const origin = 'http://localhost:4174';
  const requests = [];
  const successful = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('response', (response) => {
    if (response.ok()) successful.push(new URL(response.url()).pathname);
  });
  await injectCamera(page);
  await page.goto(origin);
  await page.getByText('骨架调试').click();
  await begin(page);
  await expect(page.locator('#recognition-feedback')).toContainText('未检测到人物');
  expect(successful).toContain('/pose/pose_landmarker_lite.task');
  expect(successful.some((path) => /^\/pose\/wasm\/.*\.wasm$/.test(path))).toBe(true);
  expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
  await actionButton(page, '关闭摄像头').click();
  await expect(page.getByRole('status')).toHaveText('待开启');
  await begin(page);
  await expect(page.locator('#recognition-feedback')).toContainText('未检测到人物');
});

test('the initial UI fits a small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '姿势派对' })).toBeVisible();
  await expect(page.locator('#actions li')).toHaveCount(5);
  await expect(page.getByRole('combobox', { name: '模式' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
