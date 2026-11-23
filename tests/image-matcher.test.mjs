import assert from 'node:assert/strict';
import { test } from 'node:test';
import { differenceHash, hashDistance, imageArea, MatchGate } from '../src/image-matcher.ts';

function pixels(transform) {
  const bytes = new Uint8ClampedArray(9 * 8 * 4);
  for (let i = 0; i < 9 * 8; i++) {
    const value = transform((i * 41) % 256);
    bytes.set([value, value, value, 255], i * 4);
  }
  return bytes;
}

test('square sampling uses the center of either video orientation', () => {
  assert.deepEqual(imageArea(640, 480), { x: 176, y: 96, size: 288 });
  assert.deepEqual(imageArea(480, 640), { x: 96, y: 176, size: 288 });
});

test('the difference hash retains brightness-scaled structure and rejects flat or inverted samples', () => {
  const reference = differenceHash(pixels((value) => value));
  const dim = differenceHash(pixels((value) => value * 0.7));
  const inverted = differenceHash(pixels((value) => 255 - value));
  assert.equal(hashDistance(reference, dim), 0);
  assert.equal(hashDistance(reference, inverted), 64);
  assert.equal(differenceHash(pixels(() => 90)), null);
});

test('matching and removal require consecutive fresh frames and each presentation triggers only once', () => {
  const gate = new MatchGate();
  const times = (match, timestamps) => timestamps.map((time) => gate.update(match, time));
  assert.deepEqual(times(true, [0, 65, 130]), [false, false, false]);
  assert.equal(gate.update(true, 130), false);
  assert.deepEqual(times(true, [500, 565, 630, 695, 760]), [false, false, false, true, false]);
  assert.equal(gate.confirmed, true);
  assert.deepEqual(times(false, [825, 890, 955]), [false, false, false]);
  assert.equal(gate.update(true, 1020), false);
  assert.deepEqual(times(false, [1085, 1150, 1215, 1280]), [false, false, false, false]);
  assert.equal(gate.confirmed, false);
  assert.deepEqual(times(true, [1345, 1410, 1475, 1540]), [false, false, false, true]);
});
