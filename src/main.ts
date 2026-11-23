import './style.css';
import { Camera } from './camera';
import { FreezeFrame } from './freeze-frame';
import memes from './memes.json';
import { actions, type Action, type Feedback, type Landmark } from './recognizer';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const preview = element<HTMLVideoElement>('preview');
const skeleton = element<HTMLCanvasElement>('skeleton');
const context = skeleton.getContext('2d');
const debug = element<HTMLInputElement>('debug');
const status = element('status');
const button = element<HTMLButtonElement>('camera-button');
const errorText = element('camera-error');
const feedbackText = element('recognition-feedback');
const diagnosisText = element('diagnosis');
const deviceControl = element('device-control');
const deviceSelect = element<HTMLSelectElement>('camera-device');
const freezeToggle = element<HTMLInputElement>('freeze-toggle');
const freezeControl = element('freeze-control');
const freeze = new FreezeFrame(element('freeze-frame'), element<HTMLCanvasElement>('freeze-canvas'), preview);
let trackingLostAt: number | undefined;
const meme = element('meme');
const image = element<HTMLImageElement>('meme-image');
const asset = (path: string) => import.meta.env.BASE_URL + path;
const cards = new Map<Action, HTMLElement>();

for (const action of actions) {
  const { name, hint, image } = memes[action];
  const item = document.createElement('li');
  const thumbnail = document.createElement('img');
  thumbnail.src = asset(image);
  // Each card names and describes its action in adjacent text.
  thumbnail.alt = '';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = name;
  const description = document.createElement('p');
  description.textContent = hint;
  copy.append(title, description);
  item.append(thumbnail, copy);
  element('actions').append(item);
  cards.set(action, item);
}

function showResult(action: Action) {
  freeze.clear();
  const { name, caption, image: path, alt } = memes[action];
  image.hidden = false;
  image.alt = alt;
  image.src = asset(path);
  element('meme-caption').textContent = caption;
  element('meme-action').textContent = name;
  element('result-empty').hidden = true;
  meme.hidden = false;
  for (const [key, card] of cards) card.classList.toggle('selected', key === action);
  if (action === 'hands-up' && freezeToggle.checked) freeze.show();
}

image.addEventListener('error', () => { image.hidden = true; });

const bones = [[0, 11], [0, 12], [11, 12], [11, 13], [12, 14], [13, 15], [14, 16], [11, 23], [12, 24], [23, 24]];
const joints = new Set(bones.flat());

function drawSkeleton(points: Landmark[]) {
  if (!context) return;
  const { videoWidth: width, videoHeight: height } = preview;
  if (skeleton.width !== width) skeleton.width = width;
  if (skeleton.height !== height) skeleton.height = height;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = context.fillStyle = '#dbff67';
  context.lineWidth = 3;
  const visible = (point?: Landmark) => point && point.visibility >= 0.55;
  for (const [first, second] of bones) {
    const a = points[first];
    const b = points[second];
    if (!visible(a) || !visible(b)) continue;
    context.beginPath();
    context.moveTo(a.x * width, a.y * height);
    context.lineTo(b.x * width, b.y * height);
    context.stroke();
  }
  for (const index of joints) {
    const point = points[index];
    if (!visible(point)) continue;
    context.beginPath();
    context.arc(point.x * width, point.y * height, 4, 0, 2 * Math.PI);
    context.fill();
  }
}

const labels = { idle: '待开启', requesting: '等待摄像头授权…', loading: '正在加载姿态模型…', active: '识别中', error: '需要重试' };
const jointsNames = { head: '头部', shoulders: '双肩', elbows: '手肘', wrists: '手腕' };
const interruptionNames = {
  changed: '姿态改变',
  ambiguous: '动作重叠',
  'occlusion-timeout': '关键点遮挡超时',
  'no-person': '人物离开画面',
  'frame-gap': '视频帧间隔过长',
};

function feedbackMessage({ state, action, missing }: Feedback) {
  const name = action && memes[action].name;
  switch (state) {
    case 'no-person': return '未检测到人物，请回到画面';
    case 'missing': return '请露出' + missing?.map((joint) => jointsNames[joint]).join('、');
    case 'framing': return '请靠近摄像头并正面入镜';
    case 'holding': return '请保持「' + name + '」姿势';
    case 'matched': return '已识别「' + name + '」，可以试试下一个动作';
    case 'ambiguous': return '动作重叠，请做一个明确的姿势';
    default: return '请选择下方的一个动作试试';
  }
}

const camera = new Camera(preview, {
  status(phase, error) {
    status.textContent = labels[phase];
    status.dataset.phase = phase;
    const started = phase === 'loading' || phase === 'active';
    const busy = started || phase === 'requesting';
    preview.hidden = !started;
    element('camera-empty').hidden = started;
    skeleton.hidden = phase !== 'active' || !debug.checked;
    freezeControl.hidden = phase !== 'active';
    if (phase !== 'active') deviceControl.hidden = true;
    button.textContent = phase === 'error' ? '重试' : busy ? '关闭摄像头' : '开启摄像头';
    button.classList.toggle('stop', busy);
    errorText.textContent = error ?? '';
    errorText.hidden = !error;
  },
  frame(points, feedback, time) {
    const message = feedbackMessage(feedback);
    if (feedbackText.textContent !== message) feedbackText.textContent = message;
    feedbackText.hidden = false;
    const details = [];
    if (feedback.action && (feedback.state === 'holding' || feedback.state === 'missing')) {
      details.push('候选动作：' + memes[feedback.action].name);
    }
    if (feedback.missing?.length) details.push('缺少关键点：' + feedback.missing.map((joint) => jointsNames[joint]).join('、'));
    if (feedback.interruption) details.push('上次确认中断：' + interruptionNames[feedback.interruption]);
    diagnosisText.textContent = details.join(' · ');
    diagnosisText.hidden = !debug.checked || !details.length;
    if (debug.checked) drawSkeleton(points);

    if (feedback.state === 'no-person') freeze.clear();
    if (feedback.missing?.includes('shoulders') || feedback.state === 'framing') {
      trackingLostAt ??= time;
      if (time - trackingLostAt >= 300) freeze.clear();
    } else {
      trackingLostAt = undefined;
    }
  },
  result: showResult,
  devices(cameras, selected) {
    const accurateSelection = cameras.some(({ deviceId }) => deviceId === selected);
    const options = cameras.map(({ deviceId, label }, index) => new Option(label || '摄像头 ' + (index + 1), deviceId));
    if (!accurateSelection) options.unshift(new Option('当前摄像头', ''));
    deviceSelect.replaceChildren(...options);
    deviceSelect.value = accurateSelection ? selected : '';
    deviceControl.hidden = !cameras.length;
  },
  clear() {
    freeze.clear();
    trackingLostAt = undefined;
    context?.clearRect(0, 0, skeleton.width, skeleton.height);
    feedbackText.hidden = true;
    feedbackText.textContent = '';
    diagnosisText.hidden = true;
    diagnosisText.textContent = '';
    meme.hidden = true;
    image.removeAttribute('src');
    image.alt = '';
    element('meme-caption').textContent = '';
    element('meme-action').textContent = '';
    element('result-empty').hidden = false;
    for (const card of cards.values()) card.classList.remove('selected');
  },
}, async () => (await import('./pose')).loadDetector());

button.addEventListener('click', () => camera.toggle());
deviceSelect.addEventListener('change', () => camera.select(deviceSelect.value));
freezeToggle.addEventListener('change', () => { if (!freezeToggle.checked) freeze.clear(); });
debug.addEventListener('change', () => {
  skeleton.hidden = status.dataset.phase !== 'active' || !debug.checked;
  diagnosisText.hidden = !debug.checked || !diagnosisText.textContent;
});
window.addEventListener('pagehide', () => camera.stop());
