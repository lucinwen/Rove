import { CLIP_DURATION, ROOM_BOUNDS, type ClientMessage, type Pose, type PoseFrame, type Signal } from './protocol.ts';

type Obj = Record<string, unknown>;
const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Obj, allowed: string[]) => Object.keys(x).every(key => allowed.includes(key));
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const roomId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const eventId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9-]{36}$/.test(x);
const name = (x: unknown): x is string => text(x, 24) && x.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(x);

function pose(value: unknown): value is Pose {
  if (!object(value) || !keys(value, ['position', 'orientation'])) return false;
  const p = value.position, q = value.orientation;
  if (!Array.isArray(p) || p.length !== 3 || !p.every(number)) return false;
  if (!Array.isArray(q) || q.length !== 4 || !q.every(number)) return false;
  const norm = Math.hypot(...q);
  return Math.abs(p[0]) <= ROOM_BOUNDS.x && Math.abs(p[2]) <= ROOM_BOUNDS.z &&
    p[1] >= ROOM_BOUNDS.minY && p[1] <= ROOM_BOUNDS.maxY && norm >= 0.9 && norm <= 1.1;
}

export function validPose(value: unknown): value is PoseFrame {
  if (!object(value) || !keys(value, ['head', 'left', 'right', 'source', 'tracked', 'seq'])) return false;
  if (!pose(value.head) || !pose(value.left) || !pose(value.right)) return false;
  if (!['desktop', 'webxr'].includes(value.source as string) || typeof value.tracked !== 'boolean') return false;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return false;
  // Reject impossible hand displacement before the frame can influence contacts.
  const head = value.head;
  return [value.left, value.right].every(hand => Math.hypot(...hand.position.map((v, i) => v - head.position[i])) <= 1.65);
}

function signal(value: unknown): value is Signal {
  if (!object(value) || !keys(value, ['description', 'candidate'])) return false;
  if (Number(value.description !== undefined) + Number(value.candidate !== undefined) !== 1) return false;
  if (value.description !== undefined) {
    const d = value.description;
    return object(d) && keys(d, ['type', 'sdp']) && (d.type === 'offer' || d.type === 'answer') && text(d.sdp, 48_000) && d.sdp.length > 0;
  }
  const c = value.candidate;
  return object(c) && keys(c, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']) && text(c.candidate, 2048) &&
    (c.sdpMid === null || text(c.sdpMid, 256)) &&
    (c.sdpMLineIndex === null || (Number.isInteger(c.sdpMLineIndex) && (c.sdpMLineIndex as number) >= 0 && (c.sdpMLineIndex as number) <= 1024)) &&
    (c.usernameFragment === undefined || c.usernameFragment === null || text(c.usernameFragment, 256));
}

/** Closed-schema wire validation: unknown fields are rejected, not forwarded. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!object(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'create': return keys(value, ['type', 'name', 'preset']) && name(value.name) && ['rose', 'sage'].includes(value.preset as string) ? value as ClientMessage : null;
    case 'inspect': return keys(value, ['type', 'roomId']) && roomId(value.roomId) ? value as ClientMessage : null;
    case 'join': return keys(value, ['type', 'roomId', 'name']) && roomId(value.roomId) && name(value.name) ? value as ClientMessage : null;
    case 'leave': case 'stop': case 'resume': return keys(value, ['type']) ? value as ClientMessage : null;
    case 'consent': return keys(value, ['type', 'enabled']) && typeof value.enabled === 'boolean' ? value as ClientMessage : null;
    case 'pose': return keys(value, ['type', 'pose']) && validPose(value.pose) ? value as ClientMessage : null;
    case 'touch-response': return keys(value, ['type', 'requestId', 'accepted']) && eventId(value.requestId) && typeof value.accepted === 'boolean' ? value as ClientMessage : null;
    case 'haptic-result': return keys(value, ['type', 'eventId', 'mode', 'ok']) && eventId(value.eventId) && ['visual', 'gamepad'].includes(value.mode as string) && typeof value.ok === 'boolean' ? value as ClientMessage : null;
    case 'signal': return keys(value, ['type', 'signal']) && signal(value.signal) ? value as ClientMessage : null;
    case 'playback': return keys(value, ['type', 'action', 'position']) && ['play', 'pause', 'seek'].includes(value.action as string) && number(value.position) && value.position >= 0 && value.position <= CLIP_DURATION ? value as ClientMessage : null;
    case 'ping': return keys(value, ['type', 'sentAt']) && number(value.sentAt) && value.sentAt >= 0 && value.sentAt <= Number.MAX_SAFE_INTEGER ? value as ClientMessage : null;
    default: return null;
  }
}
