import { loadDetector } from './pose';
import { Recognizer } from './recognizer';

type Frame = { id: number; time: number; jpeg: string };
const host = (window as unknown as {
  chrome: { webview: {
    postMessage(message: object): void;
    addEventListener(type: 'message', callback: (event: MessageEvent<Frame>) => void): void;
  } };
}).chrome.webview;

async function start() {
  const detector = await loadDetector();
  const recognizer = new Recognizer();
  host.addEventListener('message', async ({ data: { id, time, jpeg } }) => {
    try {
      const bytes = Uint8Array.from(atob(jpeg), (byte) => byte.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const width = bitmap.width;
      const height = bitmap.height;
      const started = performance.now();
      let points;
      try {
        points = detector.detect(bitmap, time);
      } finally {
        bitmap.close();
      }
      const result = recognizer.update(points, width, height, time);
      host.postMessage({ kind: 'frame', id, action: result?.action, points, inferenceMs: performance.now() - started });
    } catch (error) {
      host.postMessage({ kind: 'error', id, error: String(error) });
    }
  });
  host.postMessage({ kind: 'ready' });
}

void start().catch((error: unknown) => host.postMessage({ kind: 'error', error: String(error) }));
