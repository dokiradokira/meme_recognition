import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { actions, Recognizer } from '../src/recognizer.ts';
import { pose } from './fixtures.mjs';

test('natural variations from the v2 report are recognized', () => {
  const out = pose('arms-out');
  // The wrists are visible and extended but about 0.30 shoulder widths below the shoulders.
  out[15].y = out[16].y = 215 / 480;
  assert.equal(frames(new Recognizer(), out, 0, 1000).length, 1, 'slightly lowered arms');
  out[13].y = out[14].y = 170 / 480;
  assert.equal(frames(new Recognizer(), out, 0, 1000).length, 1, 'natural elbow bend');

  const crossed = pose('arms-crossed');
  // The wrist passes the midline, but by less than 0.08 shoulder widths.
  crossed[15].x = 314 / 640;
  assert.equal(frames(new Recognizer(), crossed, 0, 1000).length, 1, 'shallow wrist crossing');

  for (const variant of ['other wrist out of frame', 'other wrist slightly above shoulder', 'short sweep', 'slow sweep']) {
    const recognizer = new Recognizer();
    const sweep = variant === 'short sweep' ? [0, 12, 26, 12, 0] : [0, 15, 40, 15, 0];
    const interval = variant === 'slow sweep' ? 250 : 100;
    const events = sweep.flatMap((offset, index) => {
      const points = pose('wave-left', offset);
      if (variant === 'other wrist out of frame') points[16].visibility = 0.54;
      if (variant === 'other wrist slightly above shoulder') points[16].y = 183 / 480;
      return recognizer.update(points, 640, 480, index * interval) ?? [];
    });
    assert.deepEqual(events.map(({ action }) => action), ['wave'], variant);
  }
});

test('relaxed arm rules reject downward reaches, a one-sided shoulder touch, hair adjustment and two raised hands', () => {
  const down = pose('arms-out');
  down[15].y = down[16].y = 244 / 480;
  assert.deepEqual(frames(new Recognizer(), down, 0, 1000), []);
  const shoulderTouch = pose('arms-crossed');
  shoulderTouch[16].x = 260 / 640;
  assert.deepEqual(frames(new Recognizer(), shoulderTouch, 0, 1000), []);
  for (const movement of ['hair', 'two-hands', 'small-motion']) {
    const recognizer = new Recognizer();
    const offsets = movement === 'small-motion' ? [0, 5, 15, 5, 0] : [0, 15, 40, 15, 0];
    const events = offsets.flatMap((offset, index) => {
      const points = pose('wave-left', offset);
      if (movement === 'hair') {
        points[15].x = (300 + offset) / 640;
        points[15].y = 107 / 480;
      }
      if (movement === 'two-hands') points[16].y = 155 / 480;
      return recognizer.update(points, 640, 480, index * 100) ?? [];
    });
    assert.deepEqual(events, [], movement);
    assert.equal(recognizer.feedback.waveHint, {
      hair: undefined, 'two-hands': 'both-hands', 'small-motion': 'motion',
    }[movement]);
  }
});

test('wave rearms when the active hand lowers even with the other wrist out of frame', () => {
  const recognizer = new Recognizer();
  const withOtherHidden = (points) => {
    points[16].visibility = 0;
    return points;
  };
  const perform = (start) => [0, 15, 40, 15, 0].flatMap((offset, index) =>
    recognizer.update(withOtherHidden(pose('wave-left', offset)), 640, 480, start + index * 100) ?? []);
  assert.equal(perform(0).length, 1);
  assert.deepEqual(frames(recognizer, withOtherHidden(pose('neutral')), 450, 750), []);
  assert.equal(perform(800).length, 1);
});

function frames(recognizer, points, start, end, width = 640, height = 480) {
  const events = [];
  for (let time = start; time <= end; time += 50) {
    const event = recognizer.update(points, width, height, time);
    if (event) events.push(event);
  }
  return events;
}

for (const action of ['hands-up', 'arms-out', 'arms-crossed']) {
  test(`${action} requires 300 ms and only fires once while held`, () => {
    assert.deepEqual(frames(new Recognizer(), pose(action, 0, 1280, 720), 0, 1200, 1280, 720),
      [{ action, time: 300 }]);
  });
}

for (const hand of ['wave-left', 'wave-right']) {
  test(`${hand} requires both legs of a horizontal reversal`, () => {
    const recognizer = new Recognizer();
    const events = [0, 15, 37, 22, 5, 0, 40, 2].flatMap((offset, index) =>
      recognizer.update(pose(hand, offset), 640, 480, index * 100) ?? []);
    assert.deepEqual(events, [{ action: 'wave', time: 400 }]);
  });
}

test('different hands, expired samples, missing wrists and one-way motion cannot complete a wave', () => {
  const recognizer = new Recognizer();
  for (let time = 0; time <= 1250; time += 50) {
    const points = time < 400 ? pose('wave-left', time / 10) :
      time < 800 ? pose('wave-right', (time - 400) / 10) :
      time === 800 ? [] : pose('wave-left', (1250 - time) / 10);
    assert.equal(recognizer.update(points, 640, 480, time), undefined);
  }
  const slow = new Recognizer();
  for (let time = 0; time <= 1900; time += 50) {
    const offset = 35 * (1 - Math.abs(time - 950) / 950);
    assert.equal(slow.update(pose('wave-left', offset), 640, 480, time), undefined);
  }
});

test('short occlusion pauses confirmation, and triggering requires a matching frame', () => {
  const recognizer = new Recognizer();
  const hidden = pose('hands-up');
  hidden[15].visibility = 0.1;
  assert.deepEqual(frames(recognizer, pose('hands-up'), 0, 250), []);
  assert.deepEqual(frames(recognizer, hidden, 300, 350), []);
  assert.equal(recognizer.feedback.state, 'missing');
  assert.equal(recognizer.feedback.action, 'hands-up');
  assert.deepEqual(recognizer.feedback.missing, ['wrists']);
  assert.deepEqual(frames(recognizer, pose('hands-up'), 400, 450),
    [{ action: 'hands-up', time: 450 }]);
});

test('continuous occlusion expires the candidate even when it ends before the next frame', () => {
  for (const end of [350, 400]) {
    const recognizer = new Recognizer();
    const hidden = pose('arms-crossed');
    hidden[15].visibility = 0.54;
    assert.deepEqual(frames(recognizer, pose('arms-crossed'), 0, 200), []);
    assert.deepEqual(frames(recognizer, hidden, 250, end), []);
    assert.deepEqual(frames(recognizer, pose('arms-crossed'), end + 50, end + 350),
      [{ action: 'arms-crossed', time: end + 350 }]);
    assert.equal(recognizer.feedback.interruption, 'occlusion-timeout');
  }
});

test('visible evidence of a different pose resets confirmation even with a missing elbow', () => {
  const recognizer = new Recognizer();
  const changed = pose('neutral');
  changed[13].visibility = 0.54;
  assert.deepEqual(frames(recognizer, pose('arms-out'), 0, 200), []);
  assert.deepEqual(frames(recognizer, changed, 250, 250), []);
  assert.equal(recognizer.feedback.interruption, 'changed');
  assert.deepEqual(frames(recognizer, pose('arms-out'), 300, 600),
    [{ action: 'arms-out', time: 600 }]);
});

test('leaving the frame clears a candidate even inside the occlusion allowance', () => {
  const recognizer = new Recognizer();
  assert.deepEqual(frames(recognizer, pose('hands-up'), 0, 250), []);
  assert.deepEqual(frames(recognizer, [], 300, 300), []);
  assert.equal(recognizer.feedback.interruption, 'no-person');
  assert.deepEqual(frames(recognizer, pose('hands-up'), 350, 650),
    [{ action: 'hands-up', time: 650 }]);
});

test('occlusion cannot unlock a held pose but a confirmed release can', () => {
  const recognizer = new Recognizer();
  assert.equal(frames(recognizer, pose('hands-up'), 0, 400).length, 1);
  assert.deepEqual(frames(recognizer, [], 450, 1000), []);
  assert.deepEqual(frames(recognizer, pose('hands-up'), 1050, 1450), []);
  assert.deepEqual(frames(recognizer, pose('neutral'), 1500, 1750), []);
  assert.deepEqual(frames(recognizer, pose('hands-up'), 1800, 2100),
    [{ action: 'hands-up', time: 2100 }]);
});

test('a missing elbow does not release a horizontal pose that has already triggered', () => {
  const recognizer = new Recognizer();
  const uncertain = pose('neutral');
  uncertain[13].visibility = 0.54;
  const spread = pose('arms-out');
  assert.equal(frames(recognizer, spread, 0, 400).length, 1);
  assert.deepEqual(frames(recognizer, uncertain, 450, 800), []);
  assert.deepEqual(frames(recognizer, spread, 850, 1200), []);
  assert.deepEqual(frames(recognizer, pose('neutral'), 1250, 1500), []);
  assert.deepEqual(frames(recognizer, spread, 1550, 1850), [{ action: 'arms-out', time: 1850 }]);
});

test('an overlapping wave resets static confirmation', () => {
  const recognizer = new Recognizer();
  const overlapping = (horizontal) => {
    const points = pose('arms-out');
    points[13] = { x: 420 / 640, y: 175 / 480, visibility: 0.99 };
    points[15] = { x: horizontal / 640, y: 167 / 480, visibility: 0.99 };
    return points;
  };
  assert.equal(recognizer.update(overlapping(470), 640, 480, 0), undefined);
  assert.equal(recognizer.update(overlapping(510), 640, 480, 100), undefined);
  assert.equal(recognizer.update(overlapping(470), 640, 480, 200), undefined);
  assert.equal(recognizer.feedback.state, 'ambiguous');
  assert.equal(recognizer.feedback.interruption, 'ambiguous');
  assert.deepEqual(frames(recognizer, pose('arms-out'), 250, 550), [{ action: 'arms-out', time: 550 }]);
});

test('switches actions and applies global cooldown to a completed wave', () => {
  const recognizer = new Recognizer();
  assert.deepEqual(frames(recognizer, pose('hands-up'), 0, 300), [{ action: 'hands-up', time: 300 }]);
  for (const [time, offset] of [[350, 0], [400, 45], [450, 0], [500, 0], [550, 0]]) {
    assert.equal(recognizer.update(pose('wave-left', offset), 640, 480, time), undefined);
  }
  assert.deepEqual(frames(recognizer, pose('wave-left'), 600, 600), [{ action: 'wave', time: 600 }]);
  assert.deepEqual(frames(recognizer, pose('arms-out'), 650, 950), [{ action: 'arms-out', time: 950 }]);
});

test('all 20 ordered pairs switch directly with stable landmarks', () => {
  const perform = (recognizer, action, start) => {
    if (action !== 'wave') return frames(recognizer, pose(action), start, start + 450);
    return [0, 15, 40, 15, 0, 0, 0, 0, 0, 0].flatMap((offset, index) =>
      recognizer.update(pose('wave-left', offset), 640, 480, start + index * 50) ?? []);
  };
  for (const first of actions) {
    for (const second of actions.filter((action) => action !== first)) {
      const recognizer = new Recognizer();
      const events = [...perform(recognizer, first, 0), ...perform(recognizer, second, 500)];
      assert.deepEqual(events.map(({ action }) => action), [first, second], `${first} → ${second}`);
    }
  }
});

test('periodic missing elbow frames no longer leave the first result stuck', () => {
  const recognizer = new Recognizer();
  const stable = pose('arms-out');
  const occluded = pose('arms-out');
  occluded[13].visibility = 0.54;
  assert.deepEqual(frames(recognizer, pose('hands-up'), 0, 400), [{ action: 'hands-up', time: 300 }]);
  const events = [];
  for (let time = 450; time <= 2400; time += 50) {
    const points = (time - 450) % 250 === 200 ? occluded : stable;
    const event = recognizer.update(points, 640, 480, time);
    if (event) events.push(event);
  }
  assert.deepEqual(events, [{ action: 'arms-out', time: 850 }]);
});

test('missing subject, small shoulder span and gaps never complete a stale candidate', () => {
  const recognizer = new Recognizer();
  const tooFar = pose('hands-up').map((point) => ({
    ...point, x: 0.5 + (point.x - 0.5) / 4, y: 0.5 + (point.y - 0.5) / 4,
  }));
  assert.deepEqual(frames(recognizer, tooFar, 0, 500), []);
  assert.equal(recognizer.feedback.state, 'framing');
  assert.deepEqual(frames(recognizer, [], 550, 900), []);
  assert.equal(recognizer.feedback.state, 'no-person');
  assert.deepEqual(frames(recognizer, pose('hands-up'), 950, 1150), []);
  assert.deepEqual(frames(recognizer, pose('hands-up'), 1500, 1750), []);
  assert.deepEqual(frames(recognizer, pose('hands-up'), 1800, 1800), [{ action: 'hands-up', time: 1800 }]);
});

test('every action has complete metadata and the original assets are present', async () => {
  const manifest = JSON.parse(await readFile(new URL('../src/memes.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), [...actions].sort());
  for (const [action, { name, hint, caption, freezeCaption, image, alt, source }] of Object.entries(manifest)) {
    assert.ok([name, hint, caption, freezeCaption, image, alt, source].every(Boolean));
    if (action === 'hand-on-chin') {
      assert.equal(image, 'local-memes/thinking-meme.jpg');
      assert.equal(caption, '让我想想');
      continue;
    }
    assert.match(image, /^memes\/[a-z-]+\.png$/);
    const png = await readFile(new URL(`../public/${image}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  }
});

test('either hand can hold the chin, even if the non-acting wrist or finger landmarks are out of view', () => {
  const left = pose('hand-on-chin');
  left[16].visibility = left[17].visibility = left[19].visibility = 0;
  for (const points of [left, pose('chin-right')]) {
    assert.deepEqual(frames(new Recognizer(), points, 0, 1000), [{ action: 'hand-on-chin', time: 300 }]);
  }
});

test('chin hold stays deduplicated during occlusion and rearms after lowering the active hand', () => {
  const recognizer = new Recognizer();
  const rest = pose('neutral');
  const held = pose('hand-on-chin');
  const occluded = pose('hand-on-chin');
  for (const points of [rest, held, occluded]) points[16].visibility = 0;
  occluded[15].visibility = 0;
  assert.deepEqual(frames(recognizer, held, 0, 200), []);
  assert.deepEqual(frames(recognizer, occluded, 250, 250), []);
  assert.deepEqual(frames(recognizer, held, 300, 400), [{ action: 'hand-on-chin', time: 400 }]);
  assert.deepEqual(frames(recognizer, occluded, 450, 850), []);
  assert.deepEqual(frames(recognizer, held, 900, 1200), []);
  assert.deepEqual(frames(recognizer, rest, 1250, 1550), []);
  assert.deepEqual(frames(recognizer, held, 1600, 2000), [{ action: 'hand-on-chin', time: 1900 }]);
});

test('chin rule rejects brief face passes and near-face negative examples', () => {
  for (const [label, wrist, hand] of [
    ['nose touch', [326, 127], [320, 119]],
    ['covered mouth', [329, 158], [322, 137]],
    ['drinking with hand off-center', [351, 156], [350, 139]],
    ['hair adjustment', [351, 113], [349, 100]],
  ]) {
    const points = pose('hand-on-chin');
    for (const [index, [x, y]] of [[15, wrist], [17, hand], [19, hand]]) {
      points[index] = { x: x / 640, y: y / 480, visibility: 0.99 };
    }
    assert.ok(frames(new Recognizer(), points, 0, 900).every(({ action }) => action !== 'hand-on-chin'), label);
  }
  const recognizer = new Recognizer();
  assert.deepEqual(frames(recognizer, pose('hand-on-chin'), 0, 200), []);
  assert.deepEqual(frames(recognizer, pose('neutral'), 250, 700), []);
});
