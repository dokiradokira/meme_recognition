import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from './recognizer';

export interface PoseDetector {
  detect(video: HTMLVideoElement, time: number): Landmark[];
  close(): void;
}

export async function loadDetector(): Promise<PoseDetector> {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI);
  const files = await FilesetResolver.forVisionTasks(new URL('pose/wasm', base).href);
  const detector = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL('pose/pose_landmarker_lite.task', base).href },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  return {
    detect: (video, time) => detector.detectForVideo(video, time).landmarks[0] ?? [],
    close: () => detector.close(),
  };
}
