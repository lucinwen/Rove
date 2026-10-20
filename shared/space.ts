import type { Vec3 } from './protocol.ts';

/** The playable volume stays centred at [0, 0, 0], with the floor at Y=0.
 * scale/yaw/offset transform the uploaded model into those shared metre units. */
export type SpaceConfig = {
  source: 'sample' | 'measured' | 'glb';
  name: string;
  width: number;
  depth: number;
  height: number;
  assetId: string | null;
  scale: number;
  yaw: number;
  offset: Vec3;
};
export type RoomSpace = SpaceConfig & { revision: number; ownerId: string };
export type SpaceProposal = { id: string; fromId: string; space: SpaceConfig; expiresAt: number };
export type SpaceBounds = { x: number; z: number; minY: number; maxY: number };
export const MAX_SPACE_BYTES = 20 * 1024 * 1024;
export const MAX_SPACE_WIDTH = 20;
export const MAX_SPACE_DEPTH = 20;
export const MAX_SPACE_HEIGHT = 5;
export const SPACE_PROPOSAL_TTL_MS = 60_000;
export const MAX_SPACE_BOUNDS: SpaceBounds = { x: 10, z: 10, minY: 0, maxY: 5 };

export function spaceBounds(space: Pick<SpaceConfig, 'width' | 'depth' | 'height'>): SpaceBounds {
  return { x: space.width / 2, z: space.depth / 2, minY: 0, maxY: space.height };
}

export function sampleSpace(ownerId: string, revision = 0): RoomSpace {
  return { source: 'sample', name: 'Rove 示例空间', width: 5.2, depth: 5.2, height: 2.8, assetId: null, scale: 1, yaw: 0, offset: [0, 0, 0], ownerId, revision };
}

/** Closed client configuration: ownership and coordinate revision are server-owned. */
export function validSpaceConfig(value: unknown): value is SpaceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).every(key => ['source', 'name', 'width', 'depth', 'height', 'assetId', 'scale', 'yaw', 'offset'].includes(key))) return false;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!['sample', 'measured', 'glb'].includes(v.source as string) || typeof v.name !== 'string' || v.name.trim().length === 0 || v.name.length > 64 || /[\u0000-\u001f\u007f]/.test(v.name)) return false;
  if (!finite(v.width) || v.width < 1 || v.width > MAX_SPACE_WIDTH || !finite(v.depth) || v.depth < 1 || v.depth > MAX_SPACE_DEPTH || !finite(v.height) || v.height < 1.5 || v.height > MAX_SPACE_HEIGHT) return false;
  if (!finite(v.scale) || v.scale < 0.01 || v.scale > 100 || !finite(v.yaw) || Math.abs(v.yaw) > Math.PI) return false;
  if (!Array.isArray(v.offset) || v.offset.length !== 3 || !v.offset.every(finite) || Math.abs(v.offset[0]) > 10 || Math.abs(v.offset[1]) > 5 || Math.abs(v.offset[2]) > 10) return false;
  return v.source === 'glb' ? typeof v.assetId === 'string' && /^[a-f0-9]{32}$/.test(v.assetId) : v.assetId === null;
}

export { validateGLB, type GLBValidation } from './glb.ts';
