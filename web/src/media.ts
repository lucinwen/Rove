import type { Signal } from '../../shared/protocol.ts';

type PeerSession = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  ignoredUfrags: Set<string>;
};

/**
 * Camera/microphone access happens only in enable(), called by an explicit UI action.
 * Negotiation follows W3C §10.7, including implicit rollback on the polite peer:
 * https://www.w3.org/TR/webrtc/#perfect-negotiation-example
 * Signalling uses the room server; media uses the browser's encrypted WebRTC transport.
 */
export class MediaLink {
  onPermissionDenied?: (message: string) => void;

  private session: PeerSession | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private selfId = '';
  private peerId: string | null = null;
  private configurationKey = '';
  private hasTurn = false;
  private disposed = false;
  private captureVersion = 0;
  private signalQueue: Promise<void> = Promise.resolve();
  private lastStatus = '';

  constructor(
    private localVideo: HTMLVideoElement,
    private remoteVideo: HTMLVideoElement,
    private sendSignal: (signal: Signal) => void,
    private onStatus: (message: string) => void,
  ) {
    localVideo.muted = true;
    localVideo.autoplay = true;
    localVideo.playsInline = true;
    remoteVideo.muted = false;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
  }

  configure(selfId: string, peerId: string | null, role: 'host' | 'guest', iceServers: RTCIceServer[]): void {
    if (this.disposed) return;
    const changedPeer = selfId !== this.selfId || peerId !== this.peerId;
    if (changedPeer) this.closeConnection();
    this.selfId = selfId;
    this.peerId = peerId;
    this.hasTurn = iceServers.some(server =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)),
    );
    if (!selfId || !peerId || peerId === selfId) {
      if (this.session) this.closeConnection();
      this.report('等待另一方进入；本地麦克风和摄像头已关闭');
      return;
    }
    const configurationKey = JSON.stringify(iceServers);
    if (this.session) {
      this.session.polite = role === 'guest';
      if (this.configurationKey !== configurationKey) {
        try {
          this.session.pc.setConfiguration({ iceServers });
          this.configurationKey = configurationKey;
        } catch {
          this.report('ICE 配置更新失败；请重新加入房间');
        }
      }
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') {
      this.report('当前浏览器不支持 WebRTC；空间同步仍可使用');
      return;
    }
    try {
      const pc = new RTCPeerConnection({ iceServers });
      const session: PeerSession = {
        pc, polite: role === 'guest', makingOffer: false, ignoreOffer: false,
        settingRemoteAnswer: false, candidates: [], ignoredUfrags: new Set(),
      };
      this.session = session;
      this.configurationKey = configurationKey;
      this.remoteStream = new MediaStream();

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate || !this.isCurrent(session)) return;
        // The final null event is not required; an empty-string candidate is forwarded.
        this.send({ candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        } }, session);
      };
      pc.onnegotiationneeded = async () => {
        if (!this.isCurrent(session)) return;
        try {
          session.makingOffer = true;
          await pc.setLocalDescription();
          if (this.isCurrent(session)) this.sendDescription(session);
        } catch (error) {
          if (this.isCurrent(session)) this.report(`音视频协商失败：${this.errorName(error)}`);
        } finally {
          session.makingOffer = false;
        }
      };
      pc.ontrack = ({ track }) => {
        if (!this.isCurrent(session) || !this.remoteStream) return;
        const stream = this.remoteStream;
        if (!stream.getTracks().some(existing => existing.id === track.id)) stream.addTrack(track);
        this.remoteVideo.srcObject = stream;
        const play = () => { if (this.isCurrent(session)) this.playRemote(session); };
        track.onunmute = play;
        track.onended = () => {
          stream.removeTrack(track);
          if (this.isCurrent(session) && stream.getTracks().length === 0) this.remoteVideo.srcObject = null;
        };
        play();
      };
      pc.onconnectionstatechange = () => {
        if (!this.isCurrent(session)) return;
        switch (pc.connectionState) {
          case 'connected':
            this.report(this.localStream?.getTracks().some(track => track.readyState === 'live')
              ? '音视频连接已建立；本地设备正在发送' : '音视频连接已建立；本地设备仍关闭，可接收对方媒体');
            break;
          case 'connecting': this.report('正在建立音视频连接…'); break;
          case 'disconnected': this.report('音视频网络暂时中断；本地设备可手动关闭'); break;
          case 'failed':
            this.captureVersion++;
            this.stopLocalTracks();
            this.report(this.hasTurn
              ? '音视频连接失败，已关闭本地设备；请检查网络和 TURN 配置后重新开启'
              : '音视频连接失败，已关闭本地设备；未配置 TURN，跨网络连接可能无法建立');
            break;
        }
      };
      this.report(this.hasTurn
        ? '音视频待开启；点击语音或视频按钮授权本地设备'
        : '音视频待开启；未配置 TURN，先在本机或局域网验证');
    } catch (error) {
      this.closeConnection();
      this.report(`无法创建音视频连接：${this.errorName(error)}`);
    }
  }

  /** Incoming room signalling is serialised independently of device permission prompts. */
  receiveSignal(signal: Signal): Promise<void> {
    const session = this.session;
    if (!session || !this.isCurrent(session)) return Promise.resolve();
    this.signalQueue = this.signalQueue.then(async () => {
      if (!this.isCurrent(session)) return;
      const { pc } = session;
      if (signal.description) {
        const description = signal.description;
        const readyForOffer = !session.makingOffer &&
          (pc.signalingState === 'stable' || session.settingRemoteAnswer);
        const collision = description.type === 'offer' && !readyForOffer;
        session.ignoreOffer = !session.polite && collision;
        const ufrags = this.ufrags(description.sdp);
        if (session.ignoreOffer) {
          for (const ufrag of ufrags) session.ignoredUfrags.add(ufrag);
          // Bound state even if a faulty peer keeps sending colliding offers.
          while (session.ignoredUfrags.size > 16) session.ignoredUfrags.delete(session.ignoredUfrags.values().next().value!);
          session.candidates = session.candidates.filter(candidate =>
            candidate.usernameFragment && !session.ignoredUfrags.has(candidate.usernameFragment));
          return;
        }
        session.settingRemoteAnswer = description.type === 'answer';
        try {
          // Modern browsers implicitly roll back a local offer on the polite peer.
          await pc.setRemoteDescription(description);
        } finally {
          session.settingRemoteAnswer = false;
        }
        if (!this.isCurrent(session)) return;
        for (const ufrag of ufrags) session.ignoredUfrags.delete(ufrag);
        const pending = session.candidates.splice(0);
        for (const candidate of pending) {
          if (!this.isCurrent(session)) return;
          await this.addCandidate(session, candidate);
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (this.isCurrent(session)) this.sendDescription(session);
        }
      } else if (signal.candidate) {
        const candidate = signal.candidate;
        if (candidate.usernameFragment && session.ignoredUfrags.has(candidate.usernameFragment)) return;
        if (session.ignoreOffer) return;
        if (!pc.remoteDescription) {
          if (session.candidates.length >= 128) throw new Error('ICE 候选队列超限');
          session.candidates.push(candidate);
        } else {
          await this.addCandidate(session, candidate);
        }
      }
    }).catch(error => {
      if (this.isCurrent(session)) this.report(`音视频信令处理失败：${this.errorName(error)}`);
    });
    return this.signalQueue;
  }

  /** Reuses live audio when adding video, and never reopens a device after leave/disable. */
  async enable(mode: 'audio' | 'video'): Promise<void> {
    const session = this.session;
    if (!session || !this.isCurrent(session)) {
      this.report('请先与另一方进入同一房间，再开启本地设备');
      return;
    }
    const version = ++this.captureVersion;
    if (mode === 'audio') this.stopLocalTracks('video');
    if (this.remoteStream?.getTracks().length) this.playRemote(session);
    const tracks = this.localStream?.getTracks() ?? [];
    const needAudio = !tracks.some(track => track.kind === 'audio' && track.readyState === 'live');
    const needVideo = mode === 'video' && !tracks.some(track => track.kind === 'video' && track.readyState === 'live');
    if (!needAudio && !needVideo) {
      this.report(mode === 'video' ? '麦克风和摄像头已开启' : '麦克风已开启；摄像头关闭');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = '当前页面无法访问设备；请使用支持 WebRTC 的浏览器，并通过 HTTPS 或 localhost 打开';
      this.report(message);
      this.onPermissionDenied?.(message);
      return;
    }
    let captured: MediaStream | null = null;
    try {
      this.report(needVideo ? '等待摄像头／麦克风授权…' : '等待麦克风授权…');
      captured = await navigator.mediaDevices.getUserMedia({
        audio: needAudio ? { echoCancellation: true, noiseSuppression: true } : false,
        video: needVideo ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false,
      });
      if (version !== this.captureVersion || !this.isCurrent(session)) {
        captured.getTracks().forEach(track => track.stop());
        return;
      }
      if (!this.localStream) this.localStream = new MediaStream();
      const local = this.localStream;
      for (const track of captured.getTracks()) {
        local.addTrack(track);
        session.pc.addTrack(track, local);
        track.onended = () => {
          if (!this.isCurrent(session)) return;
          this.stopLocalTracks(track.kind as 'audio' | 'video');
          this.report(track.kind === 'audio' ? '麦克风已停止；需要再次点击语音按钮开启' : '摄像头已停止；语音按原状态继续');
        };
      }
      this.localVideo.srcObject = local;
      void this.localVideo.play().catch(() => { /* Muted preview failure does not stop the call. */ });
      if (session.pc.connectionState === 'failed') session.pc.restartIce();
      this.report(mode === 'video' ? '麦克风和摄像头已开启；正在连接对方' : '麦克风已开启；摄像头关闭');
    } catch (error) {
      // A partially attached newly captured stream must not leave the camera running.
      if (captured) {
        for (const track of captured.getTracks()) {
          track.onended = null;
          track.stop();
          this.localStream?.removeTrack(track);
          if (this.isCurrent(session)) {
            const sender = session.pc.getSenders().find(item => item.track === track);
            if (sender) session.pc.removeTrack(sender);
          }
        }
      }
      if (version !== this.captureVersion || !this.isCurrent(session)) return;
      const name = this.errorName(error);
      const message = name === 'NotAllowedError' || name === 'SecurityError'
        ? '设备权限未获允许；请在浏览器中允许后再次点击。共享空间仍可使用'
        : name === 'NotFoundError'
          ? '没有找到所需设备；可尝试仅语音，或检查摄像头／麦克风连接'
          : name === 'NotReadableError'
            ? '设备无法读取，可能正被其他应用占用；请检查后重试'
            : `无法开启本地设备：${name}`;
      this.report(message);
      if (name === 'NotAllowedError' || name === 'SecurityError') this.onPermissionDenied?.(message);
    }
  }

  /** Stops local capture immediately; receiving the other person's media can continue. */
  disable(): void {
    this.captureVersion++;
    this.stopLocalTracks();
    if (!this.disposed) this.report('本地麦克风和摄像头已关闭；仍可接收对方媒体');
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeConnection();
    this.disposed = true;
    this.selfId = '';
    this.peerId = null;
  }

  async getStats(): Promise<{ connection: string; outboundAudioBytes: number; inboundAudioBytes: number }> {
    const session = this.session;
    const result = { connection: session?.pc.connectionState ?? (this.disposed ? 'closed' : 'idle'), outboundAudioBytes: 0, inboundAudioBytes: 0 };
    if (!session || !this.isCurrent(session)) return result;
    try {
      const stats = await session.pc.getStats();
      if (!this.isCurrent(session)) return { connection: 'closed', outboundAudioBytes: 0, inboundAudioBytes: 0 };
      result.connection = session.pc.connectionState;
      stats.forEach(report => {
        if (report.kind !== 'audio' && report.mediaType !== 'audio') return;
        if (report.type === 'outbound-rtp') result.outboundAudioBytes += Number(report.bytesSent) || 0;
        if (report.type === 'inbound-rtp') result.inboundAudioBytes += Number(report.bytesReceived) || 0;
      });
    } catch {
      result.connection = session.pc.connectionState;
    }
    return result;
  }

  private isCurrent(session: PeerSession): boolean {
    return !this.disposed && this.session === session && session.pc.signalingState !== 'closed';
  }

  private report(message: string): void {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.onStatus(message);
  }

  private send(signal: Signal, session: PeerSession): void {
    if (!this.isCurrent(session)) return;
    try { this.sendSignal(signal); }
    catch { this.report('信令连接已中断；请检查房间连接'); }
  }

  private sendDescription(session: PeerSession): void {
    const description = session.pc.localDescription;
    if (description?.type === 'offer' || description?.type === 'answer') {
      this.send({ description: { type: description.type, sdp: description.sdp } }, session);
    }
  }

  private async addCandidate(session: PeerSession, candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.isCurrent(session) || (candidate.usernameFragment && session.ignoredUfrags.has(candidate.usernameFragment))) return;
    try { await session.pc.addIceCandidate(candidate); }
    catch (error) { if (!session.ignoreOffer && this.isCurrent(session)) throw error; }
  }

  private ufrags(sdp: string): string[] {
    return Array.from(sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)/gm), match => match[1]);
  }

  private playRemote(session: PeerSession): void {
    if (!this.isCurrent(session) || !this.remoteVideo.srcObject) return;
    void this.remoteVideo.play().catch(() => {
      if (!this.isCurrent(session)) return;
      this.remoteVideo.controls = true;
      this.report('浏览器阻止了声音自动播放；请点击远端画面的播放按钮');
    });
  }

  private stopLocalTracks(kind?: 'audio' | 'video'): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      if (kind && track.kind !== kind) continue;
      track.onended = null;
      track.stop();
      const session = this.session;
      if (session && this.isCurrent(session)) {
        const sender = session.pc.getSenders().find(item => item.track === track);
        if (sender) {
          try { session.pc.removeTrack(sender); }
          catch { /* Track.stop() has already stopped capture even if the connection closed. */ }
        }
      }
      this.localStream.removeTrack(track);
    }
    if (this.localStream.getTracks().length === 0) {
      this.localStream = null;
      this.localVideo.srcObject = null;
    }
  }

  private closeConnection(): void {
    this.captureVersion++;
    this.stopLocalTracks();
    const session = this.session;
    this.session = null;
    this.signalQueue = Promise.resolve();
    if (session) {
      session.pc.onicecandidate = null;
      session.pc.onnegotiationneeded = null;
      session.pc.onconnectionstatechange = null;
      session.pc.ontrack = null;
      session.pc.close();
      session.candidates.length = 0;
    }
    for (const track of this.remoteStream?.getTracks() ?? []) {
      track.onended = null;
      track.onunmute = null;
      track.stop();
    }
    this.remoteStream = null;
    this.remoteVideo.srcObject = null;
    this.localVideo.srcObject = null;
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name === 'Error' ? error.message : error.name : '未知错误';
  }
}
