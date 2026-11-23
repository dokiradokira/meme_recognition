export const actions = ['hands-up', 'arms-out', 'wave', 'arms-crossed', 'hand-on-chin'] as const;
export type Action = typeof actions[number];
export type Landmark = { x: number; y: number; visibility: number };
type Point = Pick<Landmark, 'x' | 'y'>;
type Arm = { shoulder: Point; elbow?: Point; wrist?: Point; hand?: Point };
type Sample = { x: number; y: number; time: number };
type StaticAction = Exclude<Action, 'wave'>;
type Joint = 'head' | 'mouth' | 'shoulders' | 'elbows' | 'wrists';
type Interruption = 'changed' | 'ambiguous' | 'occlusion-timeout' | 'no-person' | 'frame-gap';
type Candidate = { action: StaticAction; elapsed: number; lastMatch: number; paused: boolean };
export type Feedback = {
  state: 'no-person' | 'missing' | 'framing' | 'searching' | 'holding' | 'matched' | 'ambiguous';
  action?: Action;
  missing?: Joint[];
  interruption?: Interruption;
  waveHint?: 'motion' | 'both-hands';
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const HOLD = 300;
const OCCLUSION = 150;
const RELEASE = 250;
const COOLDOWN = 300;
const WAVE_WINDOW = 1050;
const WAVE_SWEEP = 0.22;

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
  const center = midpoint(left, right);
  const relative = (point: Point): Point => ({
    x: (point.x - center.x) / scale,
    y: (point.y - center.y) / scale,
  });
  const at = (index: number) => {
    const point = pixel(index);
    return point && relative(point);
  };
  const mouthLeft = at(9);
  const mouthRight = at(10);
  const arm = (shoulder: Point, elbow: number, wrist: number, index: number, pinky: number): Arm => {
    const finger = at(index);
    const outerFinger = at(pinky);
    return {
      shoulder: relative(shoulder),
      elbow: at(elbow),
      wrist: at(wrist),
      hand: finger && outerFinger ? midpoint(finger, outerFinger) : finger ?? outerFinger,
    };
  };
  return {
    head: at(0),
    mouth: mouthLeft && mouthRight ? midpoint(mouthLeft, mouthRight) : undefined,
    arms: [arm(left, 13, 15, 19, 17), arm(right, 14, 16, 20, 18)] as const,
  };
}

function extended(arm: Arm, other: Arm) {
  const { shoulder, elbow, wrist } = arm;
  if (!wrist) return undefined;
  const side = Math.sign(shoulder.x - other.shoulder.x);
  if ((wrist.x - shoulder.x) * side < 0.6 || Math.abs(wrist.y - shoulder.y) > 0.38) return false;
  if (!elbow) return undefined;
  const length = distance(shoulder, elbow) + distance(elbow, wrist);
  return (elbow.x - shoulder.x) * side >= 0.2 && distance(shoulder, wrist) >= length * 0.86;
}

function crosses(arm: Arm, other: Arm) {
  const { shoulder, elbow, wrist } = arm;
  if (elbow && elbow.y - shoulder.y < 0.2) return false;
  if (!wrist) return undefined;
  const side = Math.sign(other.shoulder.x - shoulder.x);
  if (wrist.x * side < 0.02 || Math.abs(wrist.x - other.shoulder.x) > 0.6 ||
    wrist.y - other.shoulder.y < 0.12 || wrist.y - other.shoulder.y > 0.8) return false;
  return elbow ? (wrist.x - elbow.x) * side >= 0.35 : undefined;
}

function touchesChin({ shoulder, elbow, wrist, hand }: Arm, nose: Point, mouth: Point) {
  if (!wrist) return undefined;
  const chinDepth = mouth.y - nose.y;
  if (chinDepth < 0.04 || chinDepth > 0.28) return false;
  const contact = hand ?? wrist;
  // Shoulders set the scale. The nose-to-mouth distance estimates the chin's height.
  if (Math.abs(wrist.x - mouth.x) > 0.38 || wrist.y < mouth.y + 0.04 ||
      wrist.y > mouth.y + chinDepth + 0.35 || Math.abs(contact.x - mouth.x) > 0.24 ||
      contact.y < mouth.y + 0.03 || contact.y > mouth.y + chinDepth + 0.17) return false;
  if (!elbow) return undefined;
  const length = distance(shoulder, elbow) + distance(elbow, wrist);
  return elbow.y - wrist.y >= 0.25 && distance(shoulder, wrist) <= length * 0.86;
}

function armsRaised(arms: readonly Arm[]) {
  return arms.every(({ wrist, shoulder }) => wrist && wrist.y <= shoulder.y - 0.24);
}

function hasReversal(samples: Sample[]) {
  let minimum = Infinity;
  let maximum = -Infinity;
  let peak = -Infinity;
  let valley = Infinity;
  const heights = samples.map(({ y }) => y);
  if (Math.max(...heights) - Math.min(...heights) > 0.45) return false;
  for (const { x } of samples) {
    if (peak - x >= WAVE_SWEEP || x - valley >= WAVE_SWEEP) return true;
    if (x - minimum >= WAVE_SWEEP) peak = Math.max(peak, x);
    if (maximum - x >= WAVE_SWEEP) valley = Math.min(valley, x);
    minimum = Math.min(minimum, x);
    maximum = Math.max(maximum, x);
  }
  return false;
}

const staticActions = ['hands-up', 'arms-out', 'arms-crossed'] as const;

function staticMatch(action: typeof staticActions[number], pose: NonNullable<ReturnType<typeof normalize>>) {
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

const requiredJoints: Record<Action, Joint[]> = {
  'hands-up': ['shoulders', 'head', 'wrists'],
  'arms-out': ['shoulders', 'elbows', 'wrists'],
  'arms-crossed': ['shoulders', 'elbows', 'wrists'],
  'hand-on-chin': ['shoulders', 'head', 'mouth', 'elbows', 'wrists'],
  wave: ['shoulders', 'wrists'],
};

export class Recognizer {
  feedback: Feedback = { state: 'no-person' };
  private history: [Sample[], Sample[]] = [[], []];
  private candidate?: Candidate;
  private lockedWaveHand?: number;
  private lockedChinHand?: number;
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
    const chinHands = pose?.head && pose.mouth
      ? [touchesChin(pose.arms[0], pose.head, pose.mouth), touchesChin(pose.arms[1], pose.head, pose.mouth)]
      : undefined;
    const chinHand = chinHands?.indexOf(true) ?? -1;
    const matches = new Map<Action, boolean | undefined>();
    const missing: Joint[] = [];
    let waveHint: Feedback['waveHint'];
    let waveHand = -1;
    if (pose) {
      const [left, right] = pose.arms;
      if (!pose.head) missing.push('head');
      if (!pose.mouth) missing.push('mouth');
      if (!left.elbow || !right.elbow) missing.push('elbows');
      if (!left.wrist || !right.wrist) missing.push('wrists');
      for (const action of staticActions) matches.set(action, staticMatch(action, pose));
      if (chinHand >= 0) matches.set('hand-on-chin', chinHands?.lastIndexOf(true) === chinHand);
      else if (chinHands?.every((match) => match === false)) matches.set('hand-on-chin', false);
      const raised = ({ wrist, shoulder }: Arm) => wrist && wrist.y <= shoulder.y - 0.12;
      const bothHandsRaised = armsRaised(pose.arms);
      if (bothHandsRaised) waveHint = 'both-hands';
      pose.arms.forEach((arm, index) => {
        const { wrist, shoulder } = arm;
        const nearHead = wrist && pose.head && Math.abs(wrist.x - pose.head.x) < 0.42 && wrist.y < pose.head.y + 0.33;
        if (!wrist || !raised(arm) || bothHandsRaised || nearHead || chinHands?.[index] === true) {
          this.history[index] = [];
          return;
        }
        const samples = this.history[index].filter((sample) => time - sample.time <= WAVE_WINDOW);
        samples.push({ x: wrist.x - shoulder.x, y: wrist.y - shoulder.y, time });
        this.history[index] = samples;
        waveHint = 'motion';
        if (hasReversal(samples)) waveHand = index;
      });
      if (left.wrist || right.wrist) matches.set('wave', waveHand >= 0);
    } else {
      this.history = [[], []];
      if (points.length && pose === undefined) missing.push('shoulders');
    }

    for (const [action, releasedAt] of this.locked) {
      let match = matches.get(action);
      if (action === 'hand-on-chin' && match === undefined && this.lockedChinHand !== undefined) {
        match = chinHands?.[this.lockedChinHand];
      }
      const incomplete = action === 'wave' && this.lockedWaveHand !== undefined
        ? !pose?.arms[this.lockedWaveHand].wrist
        : action !== 'hand-on-chin' && missing.some((joint) => requiredJoints[action].includes(joint));
      if (incomplete || match !== false) this.locked.set(action, null);
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
      if (waveHint) {
        this.report('searching', 'wave', [], waveHint);
      } else {
        const commonMissing = missing.filter((joint) => joint !== 'mouth');
        this.report(commonMissing.length ? 'missing' : pose === null ? 'framing' : 'searching', undefined, commonMissing);
      }
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
    if (action === 'wave') this.lockedWaveHand = waveHand;
    if (action === 'hand-on-chin') this.lockedChinHand = chinHand;
    this.lastTrigger = time;
    this.report('matched', action);
    return { action, time };
  }

  private resetCandidate(reason: Interruption) {
    if (this.candidate) this.interruption = reason;
    this.candidate = undefined;
  }

  private report(state: Feedback['state'], action?: Action, missing: Joint[] = [], waveHint?: Feedback['waveHint']) {
    this.feedback = { state, action, missing, interruption: this.interruption, waveHint };
  }

}
