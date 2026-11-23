import { expect, test } from '@playwright/test';
import { pose } from './fixtures.mjs';

async function injectCamera(page) {
  await page.addInitScript(() => {
    window.detectorCloses = 0;
    window.streams = [];
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
      const interval = setInterval(() => {
        if (track.readyState === 'ended') {
          clearInterval(interval);
          return;
        }
        context.fillRect(0, 0, canvas.width, canvas.height);
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
  await expect(page.locator('#diagnosis')).toHaveText('未检测到人物');
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
  await expect(page.locator('#diagnosis')).toHaveText('未检测到人物');
  expect(successful).toContain('/pose/pose_landmarker_lite.task');
  expect(successful.some((path) => /^\/pose\/wasm\/.*\.wasm$/.test(path))).toBe(true);
  expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
  await actionButton(page, '关闭摄像头').click();
  await expect(page.getByRole('status')).toHaveText('待开启');
  await begin(page);
  await expect(page.locator('#diagnosis')).toHaveText('未检测到人物');
});

test('the initial UI fits a small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '姿势派对' })).toBeVisible();
  await expect(page.locator('#actions li')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
