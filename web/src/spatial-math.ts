import type { Pose, Quat, Role, Vec3 } from '../../shared/protocol.ts';
import type { SpaceConfig } from '../../shared/space.ts';

export type FloorAlignment = { yaw: number; offset: Vec3 };
export type Bounds3 = { min: Vec3; max: Vec3 };
type Dimensions = Pick<SpaceConfig, 'width' | 'depth' | 'height'>;

export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Heading of the head's -Z forward direction. A nearly vertical gaze cannot define heading. */
export function headingFromQuaternion(q: Quat): number | null {
  if (q.length !== 4 || !q.every(Number.isFinite)) return null;
  const norm = Math.hypot(...q);
  if (norm < 0.9 || norm > 1.1) return null;
  const [x, y, z, w] = q.map(value => value / norm);
  const forwardX = -2 * (x * z + y * w);
  const forwardZ = -(1 - 2 * (x * x + y * y));
  if (Math.hypot(forwardX, forwardZ) < 0.15) return null;
  return Math.atan2(-forwardX, -forwardZ);
}

export function rotateY(position: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * position[0] + s * position[2], position[1], -s * position[0] + c * position[2]];
}

/** Manual local-floor alignment. Floor height stays unchanged; this does not estimate a room map. */
export function computeFloorAlignment(rawHead: Pose, sharedEntry: Vec3, desiredYaw = 0): FloorAlignment | null {
  if (!rawHead.position.every(Number.isFinite) || !sharedEntry.every(Number.isFinite) || !Number.isFinite(desiredYaw)) return null;
  const currentYaw = headingFromQuaternion(rawHead.orientation);
  if (currentYaw === null) return null;
  const yaw = wrapAngle(desiredYaw - currentYaw);
  const rotated = rotateY(rawHead.position, yaw);
  return { yaw, offset: [sharedEntry[0] - rotated[0], 0, sharedEntry[2] - rotated[2]] };
}

export function applyFloorAlignment(raw: Pose, alignment: FloorAlignment): Pose {
  const position = rotateY(raw.position, alignment.yaw).map((value, index) => value + alignment.offset[index]) as Vec3;
  const [x, y, z, w] = raw.orientation;
  const s = Math.sin(alignment.yaw / 2), c = Math.cos(alignment.yaw / 2);
  return { position, orientation: [c * x + s * z, c * y + s * w, c * z - s * x, c * w - s * y] };
}

/** Explicit model transform: scale -> yaw -> translation. No implicit centre or floor correction. */
export function transformModelPoint(point: Vec3, transform: Pick<SpaceConfig, 'scale' | 'yaw' | 'offset'>): Vec3 {
  const rotated = rotateY(point.map(value => value * transform.scale) as Vec3, transform.yaw);
  return rotated.map((value, index) => value + transform.offset[index]) as Vec3;
}

export function transformBounds(bounds: Bounds3, transform: Pick<SpaceConfig, 'scale' | 'yaw' | 'offset'>): Bounds3 {
  const points: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    points.push(transformModelPoint([x, y, z], transform));
  }
  return {
    min: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))) as Vec3,
    max: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]))) as Vec3,
  };
}

export function movementLimits(space: Dimensions): { x: number; z: number } {
  return { x: Math.max(0.02, space.width / 2 - 0.46), z: Math.max(0.02, space.depth / 2 - 0.46) };
}

export function entrancePosition(role: Role, space: Dimensions): Vec3 {
  const limits = movementLimits(space);
  return [(role === 'host' ? -1 : 1) * Math.min(0.65, limits.x * 0.7), 0, Math.min(0.4, limits.z * 0.35)];
}

export function desktopHeadHeight(space: Dimensions): number {
  return Math.min(1.55, space.height - 0.12);
}

/** Fixed desktop rehearsal seats, with a clear fallback when the peer occupies a landing point. */
export function approachPosition(role: Role, space: Dimensions, peer: Vec3 | null): { position: Vec3; yaw: number } | null {
  const limits = movementLimits(space);
  if (limits.x < 0.42) return null;
  const side = role === 'host' ? -1 : 1;
  const x = side * 0.42, z = Math.min(0.1, limits.z);
  const candidates: Vec3[] = [[x, 0, z], [side * Math.min(0.85, limits.x), 0, z],
    [x, 0, Math.min(0.6, limits.z)], [x, 0, Math.max(-0.5, -limits.z)]];
  const position = candidates.find(point => !peer || Math.hypot(point[0] - peer[0], point[2] - peer[2]) >= 0.38);
  if (!position) return null;
  const yaw = peer && position !== candidates[0] ? Math.atan2(position[0] - peer[0], position[2] - peer[2]) : side * Math.PI / 2;
  return { position, yaw };
}

export function observerFraming(space: Dimensions): { position: Vec3; target: Vec3; maxDistance: number } {
  const largest = Math.max(space.width, space.depth, space.height * 1.7);
  return {
    position: [largest * 0.93, Math.max(space.height * 1.2, largest * 0.7), largest * 1.17],
    target: [0, Math.min(1.2, space.height * 0.38), -space.depth * 0.035],
    maxDistance: Math.max(8, largest * 3.2),
  };
}
