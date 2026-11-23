export const actions = ['hands-up', 'arms-out', 'wave', 'arms-crossed'] as const;
export type Action = typeof actions[number];
export type Landmark = { x: number; y: number; visibility: number };
type Point = Pick<Landmark, 'x' | 'y'>;
type Arm = { shoulder: Point; elbow?: Point; wrist?: Point };
type Sample = { x: number; time: number };
type StaticAction = Exclude<Action, 'wave'>;
type Joint = 'head' | 'shoulders' | 'elbows' | 'wrists';
type Interruption = 'changed' | 'ambiguous' | 'occlusion-timeout' | 'no-person' | 'frame-gap';
type Candidate = { action: StaticAction; elapsed: number; lastMatch: number; paused: boolean };
export type Feedback = {
  state: 'no-person' | 'missing' | 'framing' | 'searching' | 'holding' | 'matched' | 'ambiguous';
  action?: Action;
  missing?: Joint[];
  interruption?: Interruption;
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const HOLD = 300;
const OCCLUSION = 150;
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
  if (scale < height * 0.075 || Math.abs(left.x - right.x) < scale * 0.65) return null;
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
  if (!wrist) return undefined;
  const side = Math.sign(shoulder.x - other.shoulder.x);
  if ((wrist.x - shoulder.x) * side < 0.6 || Math.abs(wrist.y - shoulder.y) > 0.28) return false;
  if (!elbow) return undefined;
  const length = distance(shoulder, elbow) + distance(elbow, wrist);
  return distance(shoulder, wrist) >= length * 0.94;
}

function crosses(arm: Arm, other: Arm) {
  const { shoulder, elbow, wrist } = arm;
  if (elbow && elbow.y - shoulder.y < 0.2) return false;
  if (!wrist) return undefined;
  const side = Math.sign(other.shoulder.x - shoulder.x);
  if (wrist.x * side <= 0.08 || Math.abs(wrist.x - other.shoulder.x) > 0.6 ||
    wrist.y - other.shoulder.y < 0.12 || wrist.y - other.shoulder.y > 0.8) return false;
  return elbow ? true : undefined;
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

function staticMatch(action: StaticAction, pose: NonNullable<ReturnType<typeof normalize>>) {
  const { head, arms: [left, right] } = pose;
  if (action === 'hands-up') {
    if (!head) return undefined;
    if ([left.wrist, right.wrist].some((wrist) => wrist && wrist.y > head.y - 0.12)) return false;
    return left.wrist && right.wrist ? true : undefined;
  }
  const matchArm = action === 'arms-out' ? extended : crosses;
  const a = matchArm(left, right);
  const b = matchArm(right, left);
  if (a === false || b === false) return false;
  return a === true && b === true ? true : undefined;
}

const staticActions = ['hands-up', 'arms-out', 'arms-crossed'] as const;
const requiredJoints: Record<Action, Joint[]> = {
  'hands-up': ['shoulders', 'head', 'wrists'],
  'arms-out': ['shoulders', 'elbows', 'wrists'],
  'arms-crossed': ['shoulders', 'elbows', 'wrists'],
  wave: ['shoulders', 'wrists'],
};

export class Recognizer {
  feedback: Feedback = { state: 'no-person' };
  private history: [Sample[], Sample[]] = [[], []];
  private candidate?: Candidate;
  private interruption?: Interruption;
  private locked = new Map<Action, number | null>();
  private lastTime = -Infinity;
  private lastTrigger = -Infinity;

  update(points: Landmark[], width: number, height: number, time: number) {
    if (time <= this.lastTime) return;
    if (time - this.lastTime >= HOLD) {
      this.resetCandidate('frame-gap');
      this.history = [[], []];
      for (const action of this.locked.keys()) this.locked.set(action, null);
    }
    this.lastTime = time;

    const pose = normalize(points, width, height);
    const matches = new Map<Action, boolean | undefined>();
    const missing: Joint[] = [];
    if (pose) {
      const [left, right] = pose.arms;
      if (!pose.head) missing.push('head');
      if (!left.elbow || !right.elbow) missing.push('elbows');
      if (!left.wrist || !right.wrist) missing.push('wrists');
      for (const action of staticActions) matches.set(action, staticMatch(action, pose));
      if (left.wrist && right.wrist) {
        let wave = false;
        pose.arms.forEach(({ wrist, shoulder }, index) => {
          const other = pose.arms[1 - index];
          if (!wrist || wrist.y > shoulder.y - 0.12 || !other.wrist || other.wrist.y < other.shoulder.y) {
            this.history[index] = [];
            return;
          }
          const samples = this.history[index].filter((sample) => time - sample.time <= WAVE_WINDOW);
          samples.push({ x: wrist.x - shoulder.x, time });
          this.history[index] = samples;
          if (hasReversal(samples)) wave = true;
        });
        matches.set('wave', wave);
      } else {
        this.history = [[], []];
      }
    } else {
      this.history = [[], []];
      if (points.length && pose === undefined) missing.push('shoulders');
    }

    for (const [action, releasedAt] of this.locked) {
      const incomplete = missing.some((joint) => requiredJoints[action].includes(joint));
      if (incomplete || matches.get(action) !== false) this.locked.set(action, null);
      else if (releasedAt === null) this.locked.set(action, time);
      else if (time - releasedAt >= RELEASE) this.locked.delete(action);
    }

    const confident = actions.filter((action) => matches.get(action) === true);
    const [action] = confident;
    const candidate = this.candidate;
    if (!points.length) {
      this.resetCandidate('no-person');
      this.report('no-person');
      return;
    }
    if (confident.length > 1) {
      this.resetCandidate('ambiguous');
      this.report('ambiguous');
      return;
    }
    if (candidate) {
      const match = matches.get(candidate.action);
      if (pose === null || match === false || (action && action !== candidate.action)) {
        this.resetCandidate('changed');
      } else if (candidate.paused && time - candidate.lastMatch > OCCLUSION) {
        this.resetCandidate('occlusion-timeout');
      } else if (match === undefined) {
        if (time - candidate.lastMatch <= OCCLUSION) {
          candidate.paused = true;
          this.report('missing', candidate.action, missing.filter((joint) => requiredJoints[candidate.action].includes(joint)));
          return;
        }
        this.resetCandidate('occlusion-timeout');
      }
    }

    if (!action) {
      this.report(missing.length ? 'missing' : pose === null ? 'framing' : 'searching', undefined, missing);
      return;
    }
    if (this.locked.has(action)) {
      this.report('matched', action);
      return;
    }
    if (action !== 'wave') {
      if (!this.candidate) {
        this.candidate = { action, elapsed: 0, lastMatch: time, paused: false };
      } else {
        if (!this.candidate.paused) this.candidate.elapsed += time - this.candidate.lastMatch;
        this.candidate.lastMatch = time;
        this.candidate.paused = false;
      }
      if (this.candidate.elapsed < HOLD) {
        this.report('holding', action);
        return;
      }
    }
    if (time - this.lastTrigger < COOLDOWN) {
      this.report(action === 'wave' ? 'searching' : 'holding', action);
      return;
    }
    this.candidate = undefined;
    this.locked.set(action, null);
    this.lastTrigger = time;
    this.report('matched', action);
    return { action, time };
  }

  private resetCandidate(reason: Interruption) {
    if (this.candidate) this.interruption = reason;
    this.candidate = undefined;
  }

  private report(state: Feedback['state'], action?: Action, missing: Joint[] = []) {
    this.feedback = { state, action, missing, interruption: this.interruption };
  }

}
