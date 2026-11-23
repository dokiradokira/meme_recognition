export class FreezeFrame {
  private playback?: { animation?: Animation; timer?: number };

  constructor(
    private overlay: HTMLElement,
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
  ) {}

  show() {
    this.clear();
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!width || !height || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    try {
      const context = this.canvas.getContext('2d');
      if (!context) return;
      this.canvas.width = width;
      this.canvas.height = height;
      context.translate(width, 0);
      context.scale(-1, 1);
      context.drawImage(this.video, 0, 0);
      this.overlay.hidden = false;
      const playback: NonNullable<FreezeFrame['playback']> = {};
      this.playback = playback;
      const finish = () => {
        if (this.playback === playback) this.clear();
      };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        playback.timer = window.setTimeout(finish, 1000);
      } else {
        const animation = this.canvas.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }],
          { duration: 1000, easing: 'ease-out', fill: 'forwards' },
        );
        playback.animation = animation;
        void animation.finished.then(finish, finish);
      }
    } catch {
      this.clear();
    }
  }

  clear() {
    if (this.overlay.hidden && !this.playback && !this.canvas.width && !this.canvas.height) return;
    const playback = this.playback;
    this.playback = undefined;
    window.clearTimeout(playback?.timer);
    playback?.animation?.cancel();
    this.overlay.hidden = true;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
