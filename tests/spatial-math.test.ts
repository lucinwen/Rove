import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pose, Vec3 } from '../shared/protocol.ts';
import { sampleSpace } from '../shared/space.ts';
import {
  applyFloorAlignment, approachPosition, computeFloorAlignment, desktopHeadHeight, entrancePosition,
  headingFromQuaternion, movementLimits, observerFraming, transformBounds, transformModelPoint,
} from '../web/src/spatial-math.ts';

// Numerical coordinate tests only. These do not simulate a headset, scan, or persistent anchor.
function close(actual: number[], expected: number[], tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${value} ≠ ${expected[index]} at ${index}`));
}
const pose = (position: Vec3, yaw: number): Pose => ({ position, orientation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] });

test('manual floor alignment maps the real head X/Z to the shared entrance and preserves physical height', () => {
  const head = pose([2, 1.72, 3], Math.PI / 2);
  const alignment = computeFloorAlignment(head, [-0.65, 0, 0.4]);
  assert.ok(alignment);
  close([alignment.yaw], [-Math.PI / 2]);
  close(alignment.offset, [2.35, 0, -1.6]);
  const aligned = applyFloorAlignment(head, alignment);
  close(aligned.position, [-0.65, 1.72, 0.4]);
  close(aligned.orientation, [0, 0, 0, 1]);
  close([headingFromQuaternion(aligned.orientation)!], [0]);
});

test('head and hand use the same rigid mapping around a nonzero physical origin', () => {
  const head = pose([2, 1.72, 3], Math.PI / 2);
  const hand = pose([1.6, 1.42, 3], Math.PI / 2);
  const alignment = computeFloorAlignment(head, [0.65, 0, 0.4])!;
  const sharedHead = applyFloorAlignment(head, alignment), sharedHand = applyFloorAlignment(hand, alignment);
  close(sharedHand.position, [0.65, 1.42, 0]);
  const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((value, index) => value - b[index]));
  close([distance(sharedHead.position, sharedHand.position)], [distance(head.position, hand.position)]);
  close(sharedHead.orientation, sharedHand.orientation);
});

test('alignment handles yaw wrap and refuses vertical or invalid heading instead of guessing', () => {
  const head = pose([1, 1.6, 1], Math.PI - 0.03);
  const alignment = computeFloorAlignment(head, [0, 0, 0], -Math.PI + 0.04)!;
  close([alignment.yaw], [0.07]);
  close([headingFromQuaternion(applyFloorAlignment(head, alignment).orientation)!], [-Math.PI + 0.04]);
  const vertical: Pose = { position: [0, 1.6, 0], orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] };
  assert.equal(computeFloorAlignment(vertical, [0, 0, 0]), null);
  assert.equal(headingFromQuaternion([0, 0, 0, 2]), null);
  assert.equal(computeFloorAlignment(pose([Number.NaN, 1.6, 0], 0), [0, 0, 0]), null);
});

test('model transform is scale then Y rotation then explicit offset, without hidden centring', () => {
  const transform = { scale: 2, yaw: Math.PI / 2, offset: [10, -1, 20] as Vec3 };
  close(transformModelPoint([1, 2, 3], transform), [16, 3, 18]);
  close(transformModelPoint([0, 0, 0], transform), transform.offset);
  const bounds = transformBounds({ min: [0, -1, -2], max: [2, 3, 1] }, transform);
  close(bounds.min, [6, -3, 16]);
  close(bounds.max, [12, 5, 20]);
});

test('room dimensions constrain canonical entrances, movement and desktop height across supported sizes', () => {
  for (const width of [1, 2, 5.2, 20]) for (const depth of [1, 3, 20]) for (const height of [1.5, 2.8, 5]) {
    const space = { ...sampleSpace('test'), width, depth, height };
    const limits = movementLimits(space);
    assert.ok(limits.x + 0.44 < width / 2);
    assert.ok(limits.z + 0.44 < depth / 2);
    const host = entrancePosition('host', space), guest = entrancePosition('guest', space);
    assert.ok(host[0] < 0 && guest[0] > 0);
    close([host[0]], [-guest[0]]);
    assert.ok(Math.abs(host[0]) <= limits.x && Math.abs(host[2]) <= limits.z);
    assert.equal(host[1], 0);
    assert.ok(desktopHeadHeight(space) < height);
    const view = observerFraming(space);
    assert.ok(view.position[0] > width / 2 && view.position[2] > depth / 2);
    assert.ok(view.maxDistance > Math.hypot(...view.position));
  }
});

test('desktop approach faces the pair for reachable right-hand contact and avoids an occupied destination', () => {
  const space = sampleSpace('test');
  const host = approachPosition('host', space, null)!, guest = approachPosition('guest', space, null)!;
  const hand = (seat: typeof host) => transformModelPoint([0.06, -0.28, -0.42], {
    scale: 1, yaw: seat.yaw, offset: [seat.position[0], 1.55, seat.position[2]],
  });
  const left = hand(host), right = hand(guest);
  close([Math.hypot(...left.map((value, index) => value - right[index]))], [0.12]);
  const occupied = approachPosition('host', space, [-0.42, 1.55, 0.1])!;
  assert.ok(Math.hypot(occupied.position[0] + 0.42, occupied.position[2] - 0.1) >= 0.38);
  assert.equal(approachPosition('host', { width: 1, depth: 1, height: 1.5 }, null), null);
});
