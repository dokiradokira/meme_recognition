import type { PoseDetector } from './pose';
import { Recognizer, type Action, type Feedback, type Landmark } from './recognizer';

type Phase = 'idle' | 'requesting' | 'loading' | 'active' | 'error';
type View = {
  status(phase: Phase, error?: string): void;
  frame(points: Landmark[], feedback: Feedback, time: number): void;
  result(action: Action): void;
  devices(cameras: MediaDeviceInfo[], selected: string): void;
  clear(): void;
};
type Session = {
  stream?: MediaStream;
  detector?: PoseDetector;
  frame?: number;
  watchdog?: number;
  lastFrameAt: number;
  deviceId?: string;
  deviceRequest?: symbol;
};

const STALL = 3000;

function cameraError(error: unknown) {
  switch (error instanceof DOMException ? error.name : '') {
    case 'NotAllowedError':
    case 'SecurityError': return '摄像头权限被拒绝。请在浏览器站点设置中允许访问，再重试。';
    case 'OverconstrainedError':
    case 'NotFoundError': return '未找到摄像头。请连接摄像头后重试。';
    case 'NotReadableError':
    case 'AbortError': return '无法读取摄像头。请关闭可能占用摄像头的应用后重试。';
    default: return '摄像头启动失败。请检查设备连接后重试。';
  }
}

export class Camera {
  private session?: Session;
  private selected = '';

  constructor(
    private video: HTMLVideoElement,
    private view: View,
    private load: () => Promise<PoseDetector>,
  ) {
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      const session = this.session;
      if (session?.detector) void this.refreshDevices(session);
    });
    document.addEventListener('visibilitychange', () => {
      if (this.session) this.session.lastFrameAt = performance.now();
    });
  }

  toggle() {
    if (this.session) this.stop();
    else void this.start();
  }

  select(deviceId: string) {
    if (!this.session || deviceId === this.session.deviceId) return;
    this.stop();
    this.selected = deviceId;
    void this.start();
  }

  stop(error?: string) {
    const session = this.session;
    this.session = undefined;
    if (session?.frame !== undefined) this.video.cancelVideoFrameCallback(session.frame);
    window.clearInterval(session?.watchdog);
    session?.stream?.getTracks().forEach((track) => track.stop());
    this.video.pause();
    this.video.srcObject = null;
    this.view.clear();
    this.view.status(error ? 'error' : 'idle', error);
    session?.detector?.close();
  }

  private async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.stop('当前页面无法访问摄像头。请使用 Chrome 或 Edge 打开 HTTPS 或 localhost 地址。');
      return;
    }
    const session: Session = { lastFrameAt: performance.now() };
    this.session = session;
    this.view.status('requesting');
    let modelLoading = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 640 }, height: { ideal: 480 },
          ...(this.selected ? { deviceId: { exact: this.selected } } : { facingMode: 'user' }),
        },
      });
      if (this.session !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      const track = stream.getVideoTracks()[0];
      const disconnect = () => {
        if (this.session !== session) return;
        this.selected = '';
        this.stop('摄像头已断开。请重新连接后重试。');
      };
      if (!track || track.readyState === 'ended') {
        disconnect();
        return;
      }
      session.deviceId = track.getSettings().deviceId || this.selected;
      track.addEventListener('ended', disconnect, { once: true });
      this.video.srcObject = stream;
      this.view.status('loading');
      this.watchFrames(session);
      await this.video.play();
      if (this.session !== session) return;
      window.clearInterval(session.watchdog);
      modelLoading = true;
      const detector = await this.load();
      if (this.session !== session) {
        detector.close();
        return;
      }
      session.detector = detector;
      this.view.status('active');
      this.track(session, detector);
      void this.refreshDevices(session);
    } catch (error) {
      if (this.session !== session) return;
      if (!modelLoading && error instanceof DOMException &&
        (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) this.selected = '';
      this.stop(modelLoading ? '姿态模型加载失败。请刷新页面或点击重试。' : cameraError(error));
    }
  }

  private async refreshDevices(session: Session) {
    const request = Symbol();
    session.deviceRequest = request;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (this.session !== session || session.deviceRequest !== request) return;
      const cameras = devices.filter(({ kind, deviceId }) => kind === 'videoinput' && deviceId);
      this.view.devices(cameras, session.deviceId ?? '');
    } catch {
      // Camera capture can continue if listing devices is unavailable.
    }
  }

  private watchFrames(session: Session) {
    session.lastFrameAt = performance.now();
    session.watchdog = window.setInterval(() => {
      if (this.session === session && !document.hidden && performance.now() - session.lastFrameAt >= STALL) {
        this.stop('摄像头画面长时间没有更新。请检查设备后重试。');
      }
    }, 500);
  }

  private track(session: Session, detector: PoseDetector) {
    const recognizer = new Recognizer();
    let latestFrame = -Infinity;
    let previous = -Infinity;
    const process: VideoFrameRequestCallback = (_now, metadata) => {
      if (this.session !== session) return;
      session.frame = undefined;
      const time = metadata.mediaTime * 1000;
      if (time > latestFrame) {
        latestFrame = time;
        session.lastFrameAt = performance.now();
      }
      if (time - previous >= 65) {
        previous = time;
        try {
          const points = detector.detect(this.video, time);
          const event = recognizer.update(points, this.video.videoWidth, this.video.videoHeight, time);
          this.view.frame(points, recognizer.feedback, time);
          if (event) this.view.result(event.action);
        } catch {
          this.stop('姿态识别中断。请重试。');
          return;
        }
      }
      session.frame = this.video.requestVideoFrameCallback(process);
    };
    this.watchFrames(session);
    session.frame = this.video.requestVideoFrameCallback(process);
  }
}
