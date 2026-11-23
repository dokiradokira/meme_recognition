import { expect, test } from '@playwright/test';
import { pose } from './fixtures.mjs';

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
          if (window.paintCamera) window.paintCamera(context);
          else context.fillRect(0, 0, canvas.width, canvas.height);
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

test('four actions replace the result, tracking loss retains it, and restart clears it', async ({ page }) => {
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
  await expect(page.locator('#skeleton')).toBeVisible();
  await actionButton(page, '关闭摄像头').click();
  await expect(page.getByText('等待第一个动作')).toBeVisible();
  await expect(page.locator('#preview')).toBeHidden();
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
  await expect(page.locator('#actions li')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('image mode imports a local reference, ignores unrelated frames, and only triggers once per presentation', async ({ page }) => {
  const poseRequests = [];
  page.on('request', (request) => {
    if (/\/pose\/|\/assets\/pose-/.test(new URL(request.url()).pathname)) poseRequests.push(request.url());
  });
  await injectCamera(page);
  await page.goto('http://localhost:4174');
  const mode = page.getByRole('combobox', { name: '模式' });
  const feedback = page.locator('#recognition-feedback');
  const empty = page.getByText('等待识别图片');
  await mode.selectOption('image');
  await begin(page);
  await expect(feedback).toHaveText('请先导入参考图');
  await expect(page.locator('#image-target')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '本人定格' })).toBeHidden();

  await page.evaluate(() => {
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      const url = create.call(URL, blob);
      if (blob instanceof File) window.testReferenceUrl = url;
      return url;
    };
  });
  const referencePath = process.env.MEME_TEST_REFERENCE;
  if (referencePath) {
    await page.getByLabel('参考图').setInputFiles(referencePath);
  } else {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 288;
      const context = canvas.getContext('2d');
      context.fillStyle = '#213545';
      context.fillRect(0, 0, 288, 288);
      context.fillStyle = '#ffe38c';
      context.beginPath();
      context.ellipse(157, 137, 105, 72, -0.45, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#093b21';
      context.fillRect(187, 62, 27, 98);
      return canvas.toDataURL().split(',')[1];
    });
    await page.getByLabel('参考图').setInputFiles({
      name: 'synthetic-reference.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
    });
  }
  await expect(page.locator('#reference-status')).toContainText('已导入');
  await page.evaluate(async () => {
    const reference = new Image();
    reference.src = window.testReferenceUrl;
    await reference.decode();
    window.paintCamera = (context) => {
      context.fillStyle = '#272727';
      context.fillRect(0, 0, 640, 480);
      if (window.photoMode === 'different') {
        const gradient = context.createLinearGradient(176, 96, 464, 384);
        gradient.addColorStop(0, '#eeeeee');
        gradient.addColorStop(1, '#090909');
        context.fillStyle = gradient;
        context.fillRect(176, 96, 288, 288);
      }
      if (window.photoMode === 'match') {
        context.drawImage(reference, 176, 96, 288, 288);
        context.fillStyle = 'rgb(0 0 0 / 20%)';
        context.fillRect(176, 96, 288, 288);
      }
    };
    window.photoResults = [];
    const caption = document.querySelector('#meme-caption');
    new MutationObserver(() => {
      if (caption.textContent) window.photoResults.push(caption.textContent);
    }).observe(caption, { childList: true });
  });
  const paint = async (change) => {
    const frame = await page.evaluate((next) => {
      window.photoMode = next;
      return window.videoFrames;
    }, change);
    await expect.poll(() => page.evaluate(() => window.videoFrames)).toBeGreaterThan(frame + 23);
  };
  await paint('different');
  await expect(empty).toBeVisible();
  await paint('match');
  await expect(page.locator('#meme-caption')).toHaveText('让我想想');
  await expect(page.locator('#meme-image')).toBeVisible();
  expect(await page.evaluate(() => window.photoResults)).toEqual(['让我想想']);
  await paint('different');
  await expect(page.locator('#meme-caption')).toHaveText('让我想想');
  await paint('match');
  expect(await page.evaluate(() => window.photoResults)).toEqual(['让我想想', '让我想想']);
  expect(poseRequests).toEqual([]);

  await page.getByLabel('参考图').setInputFiles({
    name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('invalid'),
  });
  await expect(page.locator('#reference-status')).toContainText('已保留上一张参考图');
  await page.evaluate(() => { window.photoMode = undefined; });
  await mode.selectOption('pose');
  await expect(feedback).toContainText('未检测到人物');
  await expect(page.locator('#image-target')).toBeHidden();
  await expect(page.getByText('等待第一个动作')).toBeVisible();
  expect(await page.evaluate(() => window.streams[0].getVideoTracks()[0].readyState)).toBe('ended');

  await mode.selectOption('image');
  await expect(feedback).toContainText('完整对齐方框');
  await paint('match');
  await expect(page.locator('#meme-caption')).toHaveText('让我想想');
  expect(await page.evaluate(() => window.streams[1].getVideoTracks()[0].readyState)).toBe('ended');
  await actionButton(page, '关闭摄像头').click();
  await expect(empty).toBeVisible();
  await expect(page.locator('#image-target')).toBeHidden();
});
