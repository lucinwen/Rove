import type { Pose } from '../../shared/protocol.ts';

/**
 * Explicitly opted-in HRTF routing for the person's remote microphone only.
 * The ordinary video element remains the fallback until a running graph, a real
 * audio track and both valid poses exist; only then is its duplicate audio muted.
 * https://www.w3.org/TR/webaudio/#PannerNode
 */
export class SpatialAudio {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private panner: PannerNode | null = null;
  private stream: MediaStream | null = null;
  private routedTrackIds = '';
  private localHead: Pose | null = null;
  private remoteHead: Pose | null = null;
  private requested = false;
  private routed = false;
  private disposed = false;
  private version = 0;
  private lastStatus = '';

  constructor(private video: HTMLVideoElement, private onStatus: (message: string) => void) {}

  get enabled(): boolean { return this.requested && this.context?.state === 'running'; }
  get active(): boolean { return this.routed; }

  setStream(stream: MediaStream | null): void {
    this.stream = stream;
    this.refreshRouting();
  }

  /** Call directly from the user's spatial-audio button, never from incoming state. */
  async setEnabled(enabled: boolean): Promise<boolean> {
    if (this.disposed) return false;
    if (!enabled) {
      this.closeGraph();
      this.report('空间声音已关闭，使用普通语音播放');
      return false;
    }
    const version = ++this.version;
    this.requested = true;
    try {
      if (!this.context || this.context.state === 'closed') {
        const Context = globalThis.AudioContext ??
          (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Context) throw new Error('当前浏览器不支持 Web Audio');
        const context = new Context({ latencyHint: 'interactive' });
        this.context = context;
        const panner = context.createPanner();
        this.panner = panner;
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.maxDistance = 20;
        panner.rolloffFactor = 0.5;
        panner.coneInnerAngle = 360;
        panner.coneOuterAngle = 360;
        panner.connect(context.destination);
        context.onstatechange = () => {
          if (this.context !== context || !this.requested) return;
          this.refreshRouting();
          if (context.state !== 'running') {
            this.report('空间音频被浏览器暂停，已恢复普通语音；可再次点击启用');
          }
        };
      }
      const context = this.context;
      // The original user activation is still present when resume() is called.
      await context.resume();
      if (this.disposed || version !== this.version || this.context !== context || !this.requested) return false;
      if (context.state !== 'running') throw new Error('浏览器未允许音频处理启动');
      this.refreshRouting();
      if (!this.enabled) return false;
      this.report(this.routed
        ? '空间声音已启用：对方语音跟随人物位置，建议使用耳机'
        : '空间声音已准备；等待对方语音和有效位置，当前保留普通播放');
      return true;
    } catch (error) {
      if (version !== this.version || this.disposed) return false;
      this.closeGraph();
      const reason = error instanceof Error ? error.message : '未知错误';
      this.report(`无法启用空间声音，已恢复普通语音：${reason}`);
      return false;
    }
  }

  updatePose(localHead: Pose, remoteHead: Pose | null): void {
    this.localHead = this.validPose(localHead);
    this.remoteHead = remoteHead ? this.validPose(remoteHead) : null;
    this.refreshRouting();
  }

  /** A peer/session change revokes the opt-in and releases every audio node. */
  reset(): void {
    this.closeGraph();
    this.stream = null;
    this.localHead = null;
    this.remoteHead = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
  }

  private refreshRouting(): void {
    const context = this.context, panner = this.panner;
    const tracks = this.stream?.getAudioTracks().filter(track => track.readyState === 'live') ?? [];
    if (!this.requested || !context || context.state !== 'running' || !panner ||
      !tracks.length || !this.localHead || !this.remoteHead) {
      const wasRouted = this.routed;
      this.detachSource();
      if (wasRouted && this.requested) this.report('空间声音等待有效的人物位置或音频，已恢复普通语音');
      return;
    }
    const ids = tracks.map(track => track.id).sort().join('|');
    try {
      if (!this.source || ids !== this.routedTrackIds) {
        this.detachSource();
        // This stream references existing tracks; this class never owns/stops them.
        this.source = context.createMediaStreamSource(new MediaStream(tracks));
        this.source.connect(panner);
        this.routedTrackIds = ids;
      }
      const [x, y, z, w] = this.localHead.orientation;
      const forward = [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))];
      const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
      const listener = context.listener;
      if (listener.positionX && listener.forwardX) {
        [listener.positionX.value, listener.positionY.value, listener.positionZ.value] = this.localHead.position;
        [listener.forwardX.value, listener.forwardY.value, listener.forwardZ.value] = forward;
        [listener.upX.value, listener.upY.value, listener.upZ.value] = up;
      } else {
        listener.setPosition(...this.localHead.position);
        listener.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
      }
      if (panner.positionX) {
        [panner.positionX.value, panner.positionY.value, panner.positionZ.value] = this.remoteHead.position;
      } else {
        panner.setPosition(...this.remoteHead.position);
      }
      const started = !this.routed;
      this.routed = true;
      this.video.muted = true;
      if (started) this.report('空间声音已启用：对方语音跟随人物位置，建议使用耳机');
    } catch (error) {
      this.detachSource();
      this.requested = false;
      const reason = error instanceof Error ? error.message : '音频路由失败';
      this.closeGraph();
      this.report(`空间声音不可用，已恢复普通语音：${reason}`);
    }
  }

  private detachSource(): void {
    if (this.source) {
      try { this.source.disconnect(); } catch { /* Already disconnected by the browser. */ }
    }
    this.source = null;
    this.routedTrackIds = '';
    const wasRouted = this.routed;
    this.routed = false;
    this.video.muted = false;
    if (wasRouted && this.video.srcObject) {
      void this.video.play().catch(() => {
        if (this.routed || !this.video.srcObject) return;
        this.video.controls = true;
        this.report('普通语音播放被浏览器暂停，请点击远端画面的播放按钮');
      });
    }
  }

  private closeGraph(): void {
    this.version++;
    this.requested = false;
    this.detachSource();
    const context = this.context;
    this.context = null;
    if (this.panner) {
      try { this.panner.disconnect(); } catch { /* Already disconnected. */ }
    }
    this.panner = null;
    if (context) {
      context.onstatechange = null;
      if (context.state !== 'closed') void context.close().catch(() => {});
    }
  }

  private validPose(pose: Pose): Pose | null {
    if (!pose || !Array.isArray(pose.position) || pose.position.length !== 3 ||
      !Array.isArray(pose.orientation) || pose.orientation.length !== 4 ||
      ![...pose.position, ...pose.orientation].every(Number.isFinite)) return null;
    const length = Math.hypot(...pose.orientation);
    if (length < 0.001) return null;
    return {
      position: [...pose.position],
      orientation: pose.orientation.map(value => value / length) as Pose['orientation'],
    };
  }

  private report(message: string): void {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.onStatus(message);
  }
}
