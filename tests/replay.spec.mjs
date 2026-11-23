import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const directory = process.env.MEME_REPLAY_DIR;
const origin = 'http://localhost:4174';
const clipUrl = origin + '/replay-input.webm';
const handsUp = '我投降';
const armsOut = '我宣布个事';

for (const [file, expected] of [
  ['switch.webm', [handsUp, armsOut]],
  ['brief-occlusion.webm', [handsUp, armsOut]],
  ['persistent-occlusion.webm', [handsUp]],
]) {
  test('production MediaPipe replay: ' + file, async ({ page }) => {
    test.skip(!directory, 'Set MEME_REPLAY_DIR to the directory of consented recordings.');
    test.setTimeout(45_000);
    await page.route(clipUrl, (route) => route.fulfill({
      path: resolve(directory, file),
      contentType: 'video/webm',
    }));
    await page.addInitScript((url) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const source = document.createElement('video');
        source.muted = true;
        source.playsInline = true;
        source.preload = 'auto';
        await new Promise((resolve, reject) => {
          source.addEventListener('loadeddata', resolve, { once: true });
          source.addEventListener('error', () => reject(new Error('Cannot load replay clip')), { once: true });
          source.src = url;
        });

        const canvas = document.createElement('canvas');
        canvas.width = source.videoWidth;
        canvas.height = source.videoHeight;
        const context = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        const draw = () => context.drawImage(source, 0, 0);
        draw();
        const interval = setInterval(() => {
          if (track.readyState === 'ended') {
            clearInterval(interval);
            source.pause();
          } else {
            draw();
          }
        }, 33);
        window.replaySource = source;
        return stream;
      };
    }, clipUrl);

    await page.goto(origin);
    await page.evaluate(() => {
      const caption = document.querySelector('#meme-caption');
      window.replayResults = [];
      new MutationObserver(() => {
        if (caption.textContent) window.replayResults.push(caption.textContent);
      }).observe(caption, { childList: true });
    });
    await page.getByRole('button', { name: '开启摄像头' }).click();
    await expect(page.locator('#recognition-feedback')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(async () => {
      const source = window.replaySource;
      const ended = new Promise((resolve) => source.addEventListener('ended', resolve, { once: true }));
      await source.play();
      await ended;
    });
    expect(await page.evaluate(() => window.replayResults)).toEqual(expected);
    await expect(page.locator('#meme-caption')).toHaveText(expected.at(-1));
    await page.getByRole('button', { name: '关闭摄像头' }).click();
  });
}
