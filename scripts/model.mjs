import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../public/pose/', import.meta.url);
const file = new URL('pose_landmarker_lite.task', directory);
const source = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const expected = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
const valid = (data) => createHash('sha256').update(data).digest('hex') === expected;
const cached = await readFile(file).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});

if (!cached || !valid(cached)) {
  console.log('Downloading MediaPipe Pose Landmarker Lite…');
  const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!valid(data)) throw new Error('Model SHA-256 verification failed');
  await mkdir(directory, { recursive: true });
  await writeFile(file, data);
}

await cp(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url),
  new URL('wasm/', directory), { recursive: true });
