import type { RoomSpace, SpaceConfig, SpaceProposal } from './space.ts';
export type { RoomSpace, SpaceConfig, SpaceProposal } from './space.ts';
/** Rove wire protocol v1, additive v0.2 capabilities. Metres, right-handed, +Y up.
 * A space revision identifies the shared origin; old-revision poses never cross it. */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Pose = { position: Vec3; orientation: Quat };
export type PoseFrame = { head: Pose; left: Pose; right: Pose; source: 'desktop' | 'webxr'; tracked: boolean; seq: number; spaceRevision?: number };
export type RoomPreset = 'rose' | 'sage';
export type Role = 'host' | 'guest';
export type Member = { id: string; name: string; role: Role; consent: boolean };
export type Playback = { playing: boolean; position: number; updatedAt: number; revision: number };
export type RoomState = { id: string; preset: RoomPreset; members: Member[]; playback: Playback; touchEnabled: boolean; stopped: boolean; space: RoomSpace; spaceProposal: SpaceProposal | null; spaceReady: string[]; presentation: { ownerId: string | null; revision: number } };
export type TouchEvent = { id: string; from: string; to: string; hand: 'left' | 'right'; intensity: number; durationMs: number; serverTime: number };
export type TouchRequest = { id: string; from: string; to: string; hand: 'left' | 'right'; expiresAt: number };
export type Signal = { channel?: 'camera' | 'screen'; presentationRevision?: number; description?: { type: 'offer' | 'answer'; sdp: string }; candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null } };
export type ClientMessage =
  | { type: 'create'; name: string; preset: RoomPreset }
  | { type: 'inspect'; roomId: string }
  | { type: 'join'; roomId: string; name: string }
  | { type: 'leave' }
  | { type: 'consent'; enabled: boolean }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'pose'; pose: PoseFrame }
  | { type: 'touch-response'; requestId: string; accepted: boolean }
  | { type: 'haptic-result'; eventId: string; mode: 'visual' | 'gamepad'; ok: boolean }
  | { type: 'signal'; signal: Signal }
  | { type: 'space-propose'; space: SpaceConfig }
  | { type: 'space-response'; proposalId: string; accepted: boolean }
  | { type: 'space-ready'; revision: number }
  | { type: 'presentation'; active: boolean }
  | { type: 'playback'; action: 'play' | 'pause' | 'seek'; position: number }
  | { type: 'ping'; sentAt: number };
export type ServerMessage =
  | { type: 'welcome'; peerId: string; protocol: 1; sessionToken: string }
  | { type: 'preview'; roomId: string; preset: RoomPreset; available: boolean }
  | { type: 'joined'; selfId: string; state: RoomState; serverTime: number }
  | { type: 'state'; state: RoomState; serverTime: number }
  | { type: 'pose'; peerId: string; pose: PoseFrame; serverTime: number }
  | { type: 'signal'; peerId: string; signal: Signal }
  | { type: 'touch'; event: TouchEvent }
  | { type: 'touch-request'; request: TouchRequest }
  | { type: 'touch-cancelled'; requestId: string; reason: string }
  | { type: 'haptic-result'; peerId: string; eventId: string; mode: 'visual' | 'gamepad'; ok: boolean }
  | { type: 'playback'; playback: Playback; serverTime: number }
  | { type: 'pong'; sentAt: number; serverTime: number }
  | { type: 'ended'; reason: string }
  | { type: 'error'; code: string; message: string };
export const PROTOCOL_VERSION = 1;
export const CLIP_DURATION = 24;
export const POSE_STALE_MS = 1000;
export const TOUCH_DISTANCE = 0.22;
export const ROOM_BOUNDS = { x: 2.6, z: 2.6, minY: 0, maxY: 2.8 };
export function playbackPosition(playback: Playback, now: number): number {
  const elapsed = playback.playing ? Math.max(0, (now - playback.updatedAt) / 1000) : 0;
  return Math.min(CLIP_DURATION, Math.max(0, playback.position + elapsed));
}
