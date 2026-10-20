import type { Signal } from '../../shared/protocol.ts';

type ScreenSession = {
  pc: RTCPeerConnection;
  revision: number;
  ownerId: string;
  candidates: RTCIceCandidateInit[];
};

/**
 * A separate, one-presenter WebRTC connection. No camera/microphone track is used here.
 * Capture starts only from prepare(), directly inside a user gesture. Publication
 * starts only after the room has granted this participant the presentation revision.
 * https://www.w3.org/TR/screen-capture/#dom-mediadevices-getdisplaymedia
 */
export class ScreenShare {
  onEnded?: () => void;
  onStatus?: (message: string) => void;

  private selfId = '';
  private peerId: string | null = null;
  private iceServers: RTCIceServer[] = [];
  private ownerId: string | null = null;
  private revision = -1;
  private session: ScreenSession | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private localVideo: HTMLVideoElement | null = null;
  private remoteVideo: HTMLVideoElement | null = null;
  private pending = false;
  private publishing = false;
  private captureVersion = 0;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private lastStatus = '';

  constructor(private sendSignal: (signal: Signal) => void) {}

  configure(selfId: string, peerId: string | null, iceServers: RTCIceServer[]): void {
    if (this.disposed) return;
    if (selfId !== this.selfId || peerId !== this.peerId || !selfId || !peerId) this.stop();
    this.selfId = selfId;
    this.peerId = peerId;
    this.iceServers = iceServers;
    if (this.session) {
      try { this.session.pc.setConfiguration({ iceServers }); }
      catch { this.report('共享屏幕的网络配置更新失败，请停止后重新分享'); }
    }
  }

  setVideos(local: HTMLVideoElement, remote: HTMLVideoElement): void {
    if (this.localVideo && this.localVideo !== local) this.localVideo.srcObject = null;
    if (this.remoteVideo && this.remoteVideo !== remote) this.remoteVideo.srcObject = null;
    this.localVideo = local;
    this.remoteVideo = remote;
    local.muted = true;
    local.autoplay = true;
    local.playsInline = true;
    remote.muted = false;
    remote.autoplay = true;
    remote.playsInline = true;
    local.srcObject = this.localStream;
    remote.srcObject = this.remoteStream;
    if (this.localStream) void local.play().catch(() => {});
    if (this.remoteStream) this.playRemote();
  }

  /** Room state, including its epoch, must be applied before matching signals. */
  setPresentation(ownerId: string | null, revision: number): void {
    if (this.disposed || !Number.isSafeInteger(revision) || revision < 0) return;
    if (ownerId === this.ownerId && revision === this.revision) return;
    this.reset();
    this.ownerId = ownerId;
    this.revision = revision;
    // A successful grant preserves the stream selected before asking the server.
    // Revocation or a competing presenter cancels even an unresolved chooser.
    if (ownerId !== this.selfId) this.stop();
  }

  async prepare(): Promise<boolean> {
    if (this.disposed || !this.selfId || !this.peerId || this.peerId === this.selfId) {
      this.report('请先与另一方进入同一房间，再选择共享内容');
      return false;
    }
    if (this.pending || this.localStream) {
      this.report('请先停止当前分享，再选择新的内容');
      return false;
    }
    if (this.ownerId && this.ownerId !== this.selfId) {
      this.report('对方正在共享内容，请等待对方结束');
      return false;
    }
    if (!navigator.mediaDevices?.getDisplayMedia || typeof RTCPeerConnection === 'undefined') {
      this.report('当前浏览器无法共享屏幕，请使用支持屏幕捕获的 HTTPS 或 localhost 页面');
      return false;
    }
    const version = ++this.captureVersion;
    this.pending = true;
    let captured: MediaStream | null = null;
    try {
      // No await before this call: the browser must see the original click activation.
      const permission = navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 24, max: 30 } }, audio: true,
      });
      this.report('请选择要共享的标签页、窗口或屏幕；尚未发送给对方');
      captured = await permission;
      if (version !== this.captureVersion || this.disposed || !this.peerId) {
        captured.getTracks().forEach(track => track.stop());
        return false;
      }
      const video = captured.getVideoTracks().find(track => track.readyState === 'live');
      if (!video) throw new Error('没有获得可用的屏幕画面');
      this.pending = false;
      this.localStream = captured;
      video.contentHint = 'detail';
      for (const track of captured.getTracks()) {
        track.onended = () => {
          if (this.localStream !== captured) return;
          if (track.kind === 'video') {
            this.stop();
            this.report('浏览器已结束屏幕共享；相机和语音按原状态继续');
          } else {
            captured!.removeTrack(track);
            this.report('共享内容的声音已结束；画面分享继续');
          }
        };
      }
      if (this.localVideo) {
        this.localVideo.srcObject = captured;
        void this.localVideo.play().catch(() => {});
      }
      this.report(captured.getAudioTracks().some(track => track.readyState === 'live')
        ? '已选择画面和内容声音；等待房间确认后发送'
        : '已选择画面；此来源未提供声音，等待房间确认后发送');
      return true;
    } catch (error) {
      captured?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      if (version !== this.captureVersion || this.disposed) return false;
      this.pending = false;
      this.localStream = null;
      if (this.localVideo) this.localVideo.srcObject = null;
      const name = error instanceof Error ? error.name : '';
      this.report(name === 'NotAllowedError' || name === 'AbortError'
        ? '未开始屏幕共享：选择已取消或权限未获允许'
        : name === 'InvalidStateError'
          ? '请直接点击共享按钮选择内容；浏览器需要当前点击授权'
          : `无法共享屏幕：${this.errorName(error)}`);
      return false;
    }
  }

  publish(): void {
    if (this.disposed || this.publishing || this.ownerId !== this.selfId) return;
    const stream = this.localStream;
    if (!stream?.getVideoTracks().some(track => track.readyState === 'live')) {
      this.report('没有可发布的屏幕画面，请重新点击共享按钮选择');
      this.onEnded?.();
      return;
    }
    const session = this.ensurePeer();
    if (!session) { this.stop(); return; }
    this.publishing = true;
    try {
      for (const track of stream.getTracks()) {
        if (track.readyState === 'live') session.pc.addTrack(track, stream);
      }
      this.report('正在连接共享屏幕；相机和语音继续独立传输');
    } catch (error) {
      this.stop();
      this.report(`共享屏幕发布失败：${this.errorName(error)}`);
    }
  }

  receiveSignal(signal: Signal): Promise<void> {
    if (signal.channel !== 'screen' || signal.presentationRevision !== this.revision || !this.ownerId) return Promise.resolve();
    // The stop button acts before its room-state acknowledgement. A late answer
    // or ICE candidate from that revision must not recreate the stopped sender.
    if (this.ownerId === this.selfId && !this.publishing) return Promise.resolve();
    const session = this.ensurePeer();
    if (!session) return Promise.resolve();
    this.queue = this.queue.then(async () => {
      if (!this.isCurrent(session)) return;
      const { pc } = session;
      if (signal.description) {
        const description = signal.description;
        // The server grants exactly one offerer per revision; receivers only answer.
        if ((description.type === 'offer') === (this.ownerId === this.selfId)) return;
        await pc.setRemoteDescription(description);
        if (!this.isCurrent(session)) return;
        for (const candidate of session.candidates.splice(0)) {
          await pc.addIceCandidate(candidate);
          if (!this.isCurrent(session)) return;
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (this.isCurrent(session)) this.sendDescription(session);
        }
      } else if (signal.candidate) {
        if (!pc.remoteDescription) {
          if (session.candidates.length >= 128) throw new Error('ICE 候选队列超限');
          session.candidates.push(signal.candidate);
        } else {
          await pc.addIceCandidate(signal.candidate);
        }
      }
    }).catch(error => {
      if (this.isCurrent(session)) this.report(`共享屏幕信令失败：${this.errorName(error)}`);
    });
    return this.queue;
  }

  /** Reset transport/received pixels; preserve prepared local capture for a grant. */
  reset(): void {
    this.publishing = false;
    const session = this.session;
    this.session = null;
    this.queue = Promise.resolve();
    if (session) {
      session.pc.onicecandidate = null;
      session.pc.onnegotiationneeded = null;
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      session.candidates.length = 0;
    }
    for (const track of this.remoteStream?.getTracks() ?? []) {
      track.onended = null;
      track.onunmute = null;
      track.stop();
    }
    this.remoteStream = null;
    if (this.remoteVideo) this.remoteVideo.srcObject = null;
  }

  /** Immediately releases capture without relying on a final negotiation message. */
  stop(): void {
    const hadLocalCapture = this.pending || !!this.localStream || this.publishing;
    this.captureVersion++;
    this.pending = false;
    this.reset();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.localStream = null;
    if (this.localVideo) this.localVideo.srcObject = null;
    if (hadLocalCapture) {
      this.report('屏幕共享已停止；相机和语音按原状态继续');
      this.onEnded?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.selfId = '';
    this.peerId = null;
  }

  async getStats(): Promise<{ connection: string; outboundVideoBytes: number; inboundVideoBytes: number }> {
    const session = this.session;
    const result = { connection: session?.pc.connectionState ?? 'idle', outboundVideoBytes: 0, inboundVideoBytes: 0 };
    if (!session || !this.isCurrent(session)) return result;
    try {
      const stats = await session.pc.getStats();
      if (!this.isCurrent(session)) return { connection: 'closed', outboundVideoBytes: 0, inboundVideoBytes: 0 };
      stats.forEach(report => {
        if (report.kind !== 'video' && report.mediaType !== 'video') return;
        if (report.type === 'outbound-rtp') result.outboundVideoBytes += Number(report.bytesSent) || 0;
        if (report.type === 'inbound-rtp') result.inboundVideoBytes += Number(report.bytesReceived) || 0;
      });
    } catch { /* The connection may close while the browser collects statistics. */ }
    return result;
  }

  private ensurePeer(): ScreenSession | null {
    if (this.disposed || !this.selfId || !this.peerId || !this.ownerId || this.revision < 0) return null;
    if (this.session && this.isCurrent(this.session)) return this.session;
    if (typeof RTCPeerConnection === 'undefined') return null;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const session: ScreenSession = { pc, ownerId: this.ownerId, revision: this.revision, candidates: [] };
      this.session = session;
      this.remoteStream = new MediaStream();
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate || !this.isCurrent(session)) return;
        this.send({ candidate: {
          candidate: candidate.candidate, sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment,
        } }, session);
      };
      pc.onnegotiationneeded = async () => {
        if (!this.isCurrent(session) || !this.publishing || this.ownerId !== this.selfId) return;
        try {
          await pc.setLocalDescription();
          if (this.isCurrent(session)) this.sendDescription(session);
        } catch (error) {
          if (this.isCurrent(session)) this.report(`共享屏幕协商失败：${this.errorName(error)}`);
        }
      };
      pc.ontrack = ({ track }) => {
        if (!this.isCurrent(session) || this.ownerId !== this.peerId || !this.remoteStream) { track.stop(); return; }
        const stream = this.remoteStream;
        if (!stream.getTracks().some(existing => existing.id === track.id)) stream.addTrack(track);
        if (this.remoteVideo) this.remoteVideo.srcObject = stream;
        track.onunmute = () => { if (this.isCurrent(session)) this.playRemote(); };
        track.onended = () => {
          stream.removeTrack(track);
          if (!this.isCurrent(session)) return;
          if (!stream.getVideoTracks().some(item => item.readyState === 'live')) {
            if (this.remoteVideo) this.remoteVideo.srcObject = null;
            this.report('对方的共享画面已结束');
          }
        };
        this.playRemote();
      };
      pc.onconnectionstatechange = () => {
        if (!this.isCurrent(session)) return;
        switch (pc.connectionState) {
          case 'connected': this.report(this.publishing ? '共享屏幕已连接，正在发送所选内容' : '已连接对方的共享屏幕'); break;
          case 'connecting': this.report('正在连接共享屏幕…'); break;
          case 'disconnected': this.report('共享屏幕网络暂时中断'); break;
          case 'failed':
            this.stop();
            this.report('共享屏幕连接失败，已释放本地捕获；跨网络连接可能需要 TURN');
            break;
        }
      };
      return session;
    } catch (error) {
      this.report(`无法创建共享屏幕连接：${this.errorName(error)}`);
      return null;
    }
  }

  private isCurrent(session: ScreenSession): boolean {
    return !this.disposed && this.session === session && session.revision === this.revision &&
      session.ownerId === this.ownerId && session.pc.signalingState !== 'closed';
  }

  private send(signal: Signal, session: ScreenSession): void {
    if (!this.isCurrent(session)) return;
    try { this.sendSignal({ ...signal, channel: 'screen', presentationRevision: session.revision }); }
    catch { this.report('共享屏幕信令连接已中断'); }
  }

  private sendDescription(session: ScreenSession): void {
    const description = session.pc.localDescription;
    if (description?.type === 'offer' || description?.type === 'answer') {
      this.send({ description: { type: description.type, sdp: description.sdp } }, session);
    }
  }

  private playRemote(): void {
    const video = this.remoteVideo, stream = this.remoteStream;
    if (!video || !stream || video.srcObject !== stream) return;
    void video.play().catch(() => {
      if (this.remoteStream !== stream || video.srcObject !== stream) return;
      video.controls = true;
      this.report('浏览器暂停了共享内容播放，请点击共享屏幕的播放按钮');
    });
  }

  private report(message: string): void {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.onStatus?.(message);
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name === 'Error' ? error.message : error.name : '未知错误';
  }
}
