const COLUMNS = 9;
const ROWS = 8;
const CELL = 4;
const MAX_DISTANCE = 8;
const REQUIRED_FRAMES = 4;

export function imageArea(width: number, height: number) {
  const size = Math.round(Math.min(width, height) * 0.6);
  return { x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), size };
}

export function differenceHash(rgba: Uint8ClampedArray, cellSize = 1): bigint | null {
  const width = COLUMNS * cellSize;
  const height = ROWS * cellSize;
  const luma = new Float64Array(COLUMNS * ROWS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const cell = Math.floor(y / cellSize) * COLUMNS + Math.floor(x / cellSize);
      luma[cell] += (rgba[offset] * 299 + rgba[offset + 1] * 587 + rgba[offset + 2] * 114) /
        (1000 * cellSize * cellSize);
    }
  }
  if (Math.max(...luma) - Math.min(...luma) < 22) return null;

  let hash = 0n;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS - 1; col++) {
      const index = row * COLUMNS + col;
      hash = (hash << 1n) | (luma[index] - luma[index + 1] > 2 ? 1n : 0n);
    }
  }
  return hash;
}

export function hashDistance(a: bigint, b: bigint) {
  let distance = 0;
  for (let difference = a ^ b; difference; difference &= difference - 1n) distance++;
  return distance;
}

export class MatchGate {
  private count = 0;
  private locked = false;
  private lastTime = -Infinity;

  get confirmed() {
    return this.locked;
  }

  update(match: boolean, time: number) {
    if (time <= this.lastTime) return false;
    if (time - this.lastTime > 250) this.count = 0;
    this.lastTime = time;
    if (match === this.locked) {
      this.count = 0;
      return false;
    }
    if (++this.count < REQUIRED_FRAMES) return false;
    this.count = 0;
    this.locked = match;
    return match;
  }
}

export class ImageMatcher {
  private sampler = document.createElement('canvas');
  private context = this.sampler.getContext('2d', { willReadFrequently: true });
  private gate = new MatchGate();
  private reference: bigint | null = null;

  constructor() {
    this.sampler.width = COLUMNS * CELL;
    this.sampler.height = ROWS * CELL;
    if (this.context) this.context.imageSmoothingQuality = 'high';
  }

  async load(file: File, isCurrent: () => boolean) {
    const bitmap = await createImageBitmap(file);
    try {
      const hash = this.sample(bitmap, 0, 0, bitmap.width, bitmap.height);
      if (hash === null) throw new Error('Invalid reference image');
      if (isCurrent()) {
        this.reference = hash;
        this.reset();
      }
    } finally {
      bitmap.close();
    }
  }

  reset() {
    this.gate = new MatchGate();
  }

  update(video: HTMLVideoElement, time: number) {
    if (this.reference === null) return 'no-reference';
    const { x, y, size } = imageArea(video.videoWidth, video.videoHeight);
    const hash = this.sample(video, x, y, size, size);
    const match = hash !== null && hashDistance(hash, this.reference) <= MAX_DISTANCE;
    if (this.gate.update(match, time)) return 'trigger';
    return match ? (this.gate.confirmed ? 'match' : 'aligning') : 'search';
  }

  private sample(source: CanvasImageSource, x: number, y: number, width: number, height: number) {
    if (!this.context || width <= 0 || height <= 0) return null;
    const { width: sampleWidth, height: sampleHeight } = this.sampler;
    this.context.fillStyle = '#fff';
    this.context.fillRect(0, 0, sampleWidth, sampleHeight);
    this.context.drawImage(source, x, y, width, height, 0, 0, sampleWidth, sampleHeight);
    return differenceHash(this.context.getImageData(0, 0, sampleWidth, sampleHeight).data, CELL);
  }
}
