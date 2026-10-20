/** Browser-API doubles verify resource ownership, routing and async cancellation.
 * These tests are NOT real browser/WebRTC/audio-device or cross-network evidence. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MediaLink } from '../web/src/media.ts';
import { ScreenShare } from '../web/src/screen-share.ts';
import { SpatialAudio } from '../web/src/spatial-audio.ts';
import type { Pose, Signal } from '../shared/protocol.ts';

let sequence = 0;
class Track {
  id = `track-${++sequence}`;
  readyState = 'live';
  contentHint = '';
  stopped = 0;
  onended: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  constructor(readonly kind: 'audio' | 'video') {}
  stop() { this.readyState = 'ended'; this.stopped++; }
  endFromBrowser() { this.readyState = 'ended'; this.onended?.(); }
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  addTrack(track: Track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track: Track) { this.tracks = this.tracks.filter(item => item !== track); }
}
class Peer {
  static instances: Peer[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: Track }) => void) | null = null;
  senders: { track: Track | null; stream: Stream }[] = [];
  candidates: unknown[] = [];
  private negotiating = false;
  constructor() { Peer.instances.push(this); }
  setConfiguration() {}
  addTrack(track: Track, stream: Stream) {
    const sender = { track, stream }; this.senders.push(sender); this.negotiate(); return sender;
  }
  removeTrack(sender: { track: Track | null }) { sender.track = null; this.negotiate(); }
  getSenders() { return this.senders; }
  async setLocalDescription() {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: 'v=0\r\na=ice-ufrag:test\r\n' };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(candidate: unknown) { this.candidates.push(candidate); }
  async getStats() { return new Map(); }
  restartIce() {}
  close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
  private negotiate() {
    if (this.negotiating) return;
    this.negotiating = true;
    queueMicrotask(() => { this.negotiating = false; this.onnegotiationneeded?.(); });
  }
}
class NodeDouble {
  connections: unknown[] = [];
  disconnects = 0;
  connect(node: unknown) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; this.disconnects++; }
}
const param = (value = 0) => ({ value });
class Panner extends NodeDouble {
  panningModel = ''; distanceModel = ''; refDistance = 0; maxDistance = 0; rolloffFactor = 0;
  coneInnerAngle = 0; coneOuterAngle = 0;
  positionX = param(); positionY = param(); positionZ = param();
}
class Context {
  static instances: Context[] = [];
  static resumeResult: (() => Promise<void>) | null = null;
  state = 'suspended';
  destination = {};
  currentTime = 0;
  onstatechange: (() => void) | null = null;
  closed = 0;
  sources: { stream: Stream; node: NodeDouble }[] = [];
  panner = new Panner();
  listener = { positionX: param(), positionY: param(), positionZ: param(),
    forwardX: param(), forwardY: param(), forwardZ: param(-1), upX: param(), upY: param(1), upZ: param() };
  constructor() { Context.instances.push(this); }
  createPanner() { return this.panner; }
  createMediaStreamSource(stream: Stream) {
    const node = new NodeDouble(); this.sources.push({ stream, node }); return node;
  }
  async resume() {
    await Context.resumeResult?.();
    if (this.state === 'closed') throw new Error('closed');
    this.state = 'running'; this.onstatechange?.();
  }
  async close() { this.state = 'closed'; this.closed++; this.onstatechange?.(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function video() {
  return { srcObject: null, muted: false, autoplay: false, playsInline: false, controls: false,
    play: async () => {} } as unknown as HTMLVideoElement;
}
function stream(...tracks: Track[]) { return new Stream(tracks) as unknown as MediaStream; }
function pose(position: Pose['position'], orientation: Pose['orientation'] = [0, 0, 0, 1]): Pose {
  return { position, orientation };
}
function browser(t: TestContext, display: () => Promise<MediaStream>, camera: () => Promise<MediaStream> = async () => stream()) {
  Peer.instances = []; Context.instances = []; Context.resumeResult = null;
  const values = { RTCPeerConnection: Peer, MediaStream: Stream, AudioContext: Context,
    navigator: { mediaDevices: { getDisplayMedia: display, getUserMedia: camera } } };
  for (const [name, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test('screen capture waits for ownership, uses a separate connection and never replaces camera/audio', async t => {
  const mic = new Track('audio'), camera = new Track('video');
  const screen = new Track('video'), contentAudio = new Track('audio');
  browser(t, async () => stream(screen, contentAudio), async () => stream(mic, camera));
  const signals: Signal[] = [], local = video(), remote = video(), localScreen = video(), remoteScreen = video();
  const media = new MediaLink(local, remote, signal => signals.push(signal), () => {});
  t.after(() => media.dispose());
  let ended = 0; media.onScreenEnded = () => ended++;
  media.configure('self', 'peer', 'host', []);
  media.setPresentation(null, 0); media.setScreenVideos(localScreen, remoteScreen);
  await media.enable('video'); await tick();
  const cameraPeer = Peer.instances[0];
  assert.deepEqual(cameraPeer.senders.map(sender => sender.track), [mic, camera]);
  assert.equal(await media.prepareScreen(), true);
  assert.equal(Peer.instances.length, 1, 'selection does not negotiate or send pixels');
  media.setPresentation(null, 0);
  assert.equal(screen.readyState, 'live', 'unrelated same-revision room state preserves preparation');
  media.publishScreen();
  assert.equal(Peer.instances.length, 1, 'publish before grant does nothing');
  media.setPresentation('self', 1); media.publishScreen(); media.publishScreen(); await tick();
  const screenPeer = Peer.instances[1];
  assert.equal(Peer.instances.length, 2);
  assert.deepEqual(screenPeer.senders.map(sender => sender.track), [screen, contentAudio]);
  assert.ok(signals.some(signal => signal.channel === 'screen' && signal.presentationRevision === 1));
  assert.ok(signals.some(signal => signal.channel === 'camera' && signal.presentationRevision === undefined));
  media.stopScreen(); await tick();
  await media.receiveSignal({ channel: 'screen', presentationRevision: 1, description: { type: 'answer', sdp: 'late' } });
  await media.receiveSignal({ channel: 'screen', presentationRevision: 1, candidate: { candidate: 'late', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal(Peer.instances.length, 2, 'late signalling before stop acknowledgement cannot recreate the sender');
  assert.equal(ended, 1);
  assert.equal(screenPeer.signalingState, 'closed');
  assert.equal(screen.readyState, 'ended'); assert.equal(contentAudio.readyState, 'ended');
  assert.equal(mic.readyState, 'live'); assert.equal(camera.readyState, 'live');
  assert.notEqual(cameraPeer.signalingState, 'closed');
  assert.equal(localScreen.srcObject, null);
});

test('stop, leave, peer replacement and disposal cancel late screen permission without reopening capture', async t => {
  const permissions: ReturnType<typeof deferred<MediaStream>>[] = [];
  let calls = 0;
  browser(t, () => { calls++; const permission = deferred<MediaStream>(); permissions.push(permission); return permission.promise; });
  for (const action of ['stop', 'leave', 'replace', 'dispose'] as const) {
    const media = new MediaLink(video(), video(), () => {}, () => {});
    let ended = 0; media.onScreenEnded = () => ended++;
    media.configure('self', 'peer', 'host', []); media.setPresentation(null, 0);
    const previousCalls = calls;
    const pending = media.prepareScreen();
    assert.equal(calls, previousCalls + 1, 'chooser invoked synchronously within the caller gesture');
    if (action === 'stop') media.stopScreen();
    if (action === 'leave') media.configure('self', null, 'host', []);
    if (action === 'replace') media.configure('self', 'another-peer', 'host', []);
    if (action === 'dispose') media.dispose();
    const screen = new Track('video'), audio = new Track('audio');
    permissions.at(-1)!.resolve(stream(screen, audio));
    assert.equal(await pending, false);
    assert.equal(screen.readyState, 'ended'); assert.equal(audio.readyState, 'ended');
    assert.equal(ended, 1);
    media.dispose();
  }
});

test('native browser stop ends every captured screen track once and permits a new explicit selection', async t => {
  const firstVideo = new Track('video'), firstAudio = new Track('audio'), secondVideo = new Track('video');
  let selections = 0;
  browser(t, async () => ++selections === 1 ? stream(firstVideo, firstAudio) : stream(secondVideo));
  const share = new ScreenShare(() => {}); t.after(() => share.dispose());
  const messages: string[] = []; let ended = 0;
  share.onEnded = () => ended++; share.onStatus = message => messages.push(message);
  share.configure('self', 'peer', []); share.setPresentation(null, 0);
  assert.equal(await share.prepare(), true);
  share.setPresentation('self', 1); share.publish(); await tick();
  firstVideo.endFromBrowser();
  assert.equal(firstAudio.readyState, 'ended'); assert.equal(ended, 1);
  share.stop(); assert.equal(ended, 1, 'repeated stop has no duplicate UI revocation');
  share.setPresentation(null, 2);
  assert.equal(await share.prepare(), true);
  assert.ok(messages.some(message => message.includes('未提供声音')));
  assert.equal(secondVideo.readyState, 'live');
});

test('camera and presentation receive tracks never share a stream or video element', async t => {
  browser(t, async () => stream());
  const local = video(), remote = video(), localScreen = video(), remoteScreen = video();
  const media = new MediaLink(local, remote, () => {}, () => {}); t.after(() => media.dispose());
  media.configure('self', 'peer', 'guest', []); media.setScreenVideos(localScreen, remoteScreen);
  media.setPresentation('peer', 1);
  await media.receiveSignal({ channel: 'screen', presentationRevision: 1, description: { type: 'offer', sdp: 'v=0' } });
  const cameraTrack = new Track('video'), microphone = new Track('audio');
  const contentTrack = new Track('video'), contentAudio = new Track('audio');
  Peer.instances[0].ontrack?.({ track: cameraTrack }); Peer.instances[0].ontrack?.({ track: microphone });
  Peer.instances[1].ontrack?.({ track: contentTrack }); Peer.instances[1].ontrack?.({ track: contentAudio });
  assert.deepEqual((remote.srcObject as unknown as Stream).getTracks(), [cameraTrack, microphone]);
  assert.deepEqual((remoteScreen.srcObject as unknown as Stream).getTracks(), [contentTrack, contentAudio]);
  assert.notEqual(remote.srcObject, remoteScreen.srcObject);
  media.setPresentation(null, 2);
  assert.equal(remoteScreen.srcObject, null); assert.equal(contentTrack.readyState, 'ended');
  assert.equal(cameraTrack.readyState, 'live'); assert.equal(microphone.readyState, 'live');
  assert.ok(remote.srcObject);
});

test('presentation revision rejects old offers and ICE, including candidates queued before a reset', async t => {
  browser(t, async () => stream());
  const signals: Signal[] = [];
  const share = new ScreenShare(signal => signals.push(signal)); t.after(() => share.dispose());
  share.configure('receiver', 'owner', []); share.setPresentation('owner', 1);
  const candidate = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };
  await share.receiveSignal({ channel: 'screen', presentationRevision: 1, candidate });
  assert.equal(Peer.instances[0].candidates.length, 0, 'ICE waits for remote description');
  await share.receiveSignal({ channel: 'screen', presentationRevision: 1, description: { type: 'offer', sdp: 'v=0' } });
  assert.deepEqual(Peer.instances[0].candidates, [candidate]);
  assert.ok(signals.some(signal => signal.description?.type === 'answer' && signal.presentationRevision === 1));
  share.setPresentation(null, 2); share.setPresentation('owner', 3);
  await share.receiveSignal({ channel: 'screen', presentationRevision: 1, candidate });
  await share.receiveSignal({ channel: 'screen', presentationRevision: 1, description: { type: 'offer', sdp: 'old' } });
  assert.equal(Peer.instances.length, 1, 'old revision cannot recreate the screen connection');
  await share.receiveSignal({ channel: 'screen', presentationRevision: 3, description: { type: 'offer', sdp: 'current' } });
  assert.equal(Peer.instances.length, 2); assert.equal(Peer.instances[1].candidates.length, 0);
  assert.equal(Peer.instances[0].signalingState, 'closed');
});

test('HRTF is opt-in, uses only remote microphone tracks and follows valid listener/source poses', async t => {
  browser(t, async () => stream());
  const remoteVideo = video(), audio = new Track('audio'), camera = new Track('video');
  remoteVideo.srcObject = stream(audio, camera);
  const messages: string[] = [];
  const spatial = new SpatialAudio(remoteVideo, message => messages.push(message)); t.after(() => spatial.dispose());
  spatial.setStream(remoteVideo.srcObject as MediaStream);
  spatial.updatePose(pose([1, 1.6, 3], [0, Math.SQRT1_2, 0, Math.SQRT1_2]), pose([2, 1.6, -1]));
  assert.equal(Context.instances.length, 0); assert.equal(remoteVideo.muted, false);
  assert.equal(await spatial.setEnabled(true), true);
  const context = Context.instances[0];
  assert.equal(context.panner.panningModel, 'HRTF'); assert.equal(remoteVideo.muted, true);
  assert.deepEqual(context.sources[0].stream.getTracks(), [audio]);
  assert.equal(context.listener.positionX.value, 1); assert.equal(context.panner.positionX.value, 2);
  assert.ok(Math.abs(context.listener.forwardX.value + 1) < 1e-10);
  assert.ok(Math.abs(context.listener.forwardZ.value) < 1e-10);
  spatial.updatePose(pose([1, 1.6, 3]), null);
  assert.equal(remoteVideo.muted, false); assert.equal(spatial.active, false);
  assert.equal(context.sources[0].node.connections.length, 0);
  spatial.updatePose(pose([1, 1.6, 3]), pose([-2, 1.6, -1]));
  assert.equal(remoteVideo.muted, true); assert.equal(context.panner.positionX.value, -2);
  assert.equal(await spatial.setEnabled(false), false);
  assert.equal(remoteVideo.muted, false); assert.equal(context.state, 'closed');
  assert.equal(audio.readyState, 'live', 'audio router does not own the receiver track');
  assert.ok(messages.some(message => message.includes('普通语音')));
});

test('rejected audio resume keeps ordinary voice and releases the failed graph', async t => {
  browser(t, async () => stream());
  Context.resumeResult = async () => { throw new Error('permission blocked'); };
  const remoteVideo = video(), messages: string[] = [];
  const spatial = new SpatialAudio(remoteVideo, message => messages.push(message)); t.after(() => spatial.dispose());
  spatial.setStream(stream(new Track('audio')));
  spatial.updatePose(pose([0, 1, 0]), pose([1, 1, 0]));
  assert.equal(await spatial.setEnabled(true), false);
  assert.equal(remoteVideo.muted, false); assert.equal(spatial.active, false);
  assert.equal(Context.instances[0].state, 'closed'); assert.equal(Context.instances[0].sources.length, 0);
  assert.ok(messages.some(message => message.includes('无法启用')));
});

test('leaving during audio resume prevents a late route from muting ordinary playback', async t => {
  browser(t, async () => stream());
  const resume = deferred<void>(); Context.resumeResult = () => resume.promise;
  const remote = video(), media = new MediaLink(video(), remote, () => {}, () => {}); t.after(() => media.dispose());
  media.configure('self', 'peer', 'host', []);
  const remoteAudio = new Track('audio'); Peer.instances[0].ontrack?.({ track: remoteAudio });
  media.updateSpatialPose(pose([0, 1, 0]), pose([1, 1, 0]));
  const enabling = media.setSpatialAudioEnabled(true);
  media.configure('self', null, 'host', []);
  assert.equal(Context.instances[0].state, 'closed');
  resume.resolve(); assert.equal(await enabling, false);
  assert.equal(remote.muted, false); assert.equal(remote.srcObject, null);
  assert.equal(remoteAudio.readyState, 'ended');
  media.configure('self', 'new-peer', 'host', []);
  assert.equal(Context.instances.length, 1, 'new peer never automatically opts into audio processing');
});
