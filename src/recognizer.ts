export const actions = ['hands-up', 'arms-out', 'wave', 'arms-crossed'] as const;
export type Action = typeof actions[number];
export type Landmark = { x: number; y: number; visibility: number };
type Point = Pick<Landmark, 'x' | 'y'>;
type Arm = { shoulder: Point; elbow?: Point; wrist?: Point };
type Sample = { x: number; time: number };
type Diagnosis = 'no-person' | 'low-quality' | 'tracking' | 'ambiguous';

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const HOLD = 300;
const RELEASE = 250;
const COOLDOWN = 300;
const WAVE_WINDOW = 800;

function normalize(points: Landmark[], width: number, height: number) {
  const pixel = (index: number): Point | undefined => {
    const point = points[index];
    if (!point || !(point.visibility >= 0.55) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    return { x: point.x * width, y: point.y * height };
  };
  const left = pixel(11);
  const right = pixel(12);
  if (!left || !right) return;
  const scale = distance(left, right);
  if (scale < height * 0.075 || Math.abs(left.x - right.x) < scale * 0.65) return;
  const center = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const relative = (point: Point): Point => ({
    x: (point.x - center.x) / scale,
    y: (point.y - center.y) / scale,
  });
  const at = (index: number) => {
    const point = pixel(index);
    return point && relative(point);
  };
  return {
    head: at(0),
    arms: [
      { shoulder: relative(left), elbow: at(13), wrist: at(15) },
      { shoulder: relative(right), elbow: at(14), wrist: at(16) },
    ] as const,
  };
}

function extended(arm: Arm, other: Arm) {
  const { shoulder, elbow, wrist } = arm;
  if (!elbow || !wrist) return false;
  const side = Math.sign(shoulder.x - other.shoulder.x);
  const length = distance(shoulder, elbow) + distance(elbow, wrist);
  return (wrist.x - shoulder.x) * side >= 0.6 &&
    Math.abs(wrist.y - shoulder.y) <= 0.28 &&
    distance(shoulder, wrist) >= length * 0.94;
}

function crosses(arm: Arm, other: Arm) {
  const { shoulder, elbow, wrist } = arm;
  if (!elbow || !wrist) return false;
  const side = Math.sign(other.shoulder.x - shoulder.x);
  return wrist.x * side > 0.08 &&
    Math.abs(wrist.x - other.shoulder.x) <= 0.6 &&
    wrist.y - other.shoulder.y >= 0.12 && wrist.y - other.shoulder.y <= 0.8 &&
    elbow.y - shoulder.y >= 0.2;
}

function hasReversal(samples: Sample[]) {
  let minimum = Infinity;
  let maximum = -Infinity;
  let peak = -Infinity;
  let valley = Infinity;
  for (const { x } of samples) {
    if (peak - x >= 0.28 || x - valley >= 0.28) return true;
    if (x - minimum >= 0.28) peak = Math.max(peak, x);
    if (maximum - x >= 0.28) valley = Math.min(valley, x);
    minimum = Math.min(minimum, x);
    maximum = Math.max(maximum, x);
  }
  return false;
}

export class Recognizer {
  diagnosis: Diagnosis = 'no-person';
  private history: [Sample[], Sample[]] = [[], []];
  private candidate?: { action: Action; since: number };
  private locked = new Map<Action, number | null>();
  private lastTime = -Infinity;
  private lastTrigger = -Infinity;

  update(points: Landmark[], width: number, height: number, time: number) {
    if (time <= this.lastTime) return;
    if (time - this.lastTime >= HOLD) {
      this.candidate = undefined;
      this.history = [[], []];
      for (const action of this.locked.keys()) this.locked.set(action, null);
    }
    this.lastTime = time;

    const pose = normalize(points, width, height);
    const confident = new Set<Action>();
    const observable = new Set<Action>();
    this.diagnosis = points.length ? 'low-quality' : 'no-person';
    if (pose) {
      const { head, arms } = pose;
      const [left, right] = arms;
      if (left.wrist && right.wrist && head) {
        observable.add('hands-up');
        if (arms.every(({ wrist }) => wrist && wrist.y <= head.y - 0.12)) confident.add('hands-up');
      }
      if (arms.every(({ elbow, wrist }) => elbow && wrist)) {
        observable.add('arms-out');
        observable.add('arms-crossed');
        if (extended(left, right) && extended(right, left)) confident.add('arms-out');
        if (crosses(left, right) && crosses(right, left)) confident.add('arms-crossed');
      }
      if (left.wrist && right.wrist) {
        observable.add('wave');
        arms.forEach(({ wrist, shoulder }, index) => {
          const other = arms[1 - index];
          if (!wrist || wrist.y > shoulder.y - 0.12 || !other.wrist || other.wrist.y < other.shoulder.y) {
            this.history[index] = [];
            return;
          }
          const samples = this.history[index].filter((sample) => time - sample.time <= WAVE_WINDOW);
          samples.push({ x: wrist.x - shoulder.x, time });
          this.history[index] = samples;
          if (hasReversal(samples)) confident.add('wave');
        });
      } else {
        this.history = [[], []];
      }
      if (observable.size) this.diagnosis = confident.size > 1 ? 'ambiguous' : 'tracking';
    } else {
      this.history = [[], []];
    }

    for (const [action, releasedAt] of this.locked) {
      if (confident.has(action) || !observable.has(action)) this.locked.set(action, null);
      else if (releasedAt === null) this.locked.set(action, time);
      else if (time - releasedAt >= RELEASE) this.locked.delete(action);
    }

    const [action] = confident;
    if (confident.size !== 1) {
      this.candidate = undefined;
      return;
    }
    if (this.candidate?.action !== action) this.candidate = { action, since: time };
    if (this.locked.has(action) || time - this.lastTrigger < COOLDOWN) return;
    if (action !== 'wave' && time - this.candidate.since < HOLD) return;
    this.locked.set(action, null);
    this.lastTrigger = time;
    return { action, time };
  }
}
