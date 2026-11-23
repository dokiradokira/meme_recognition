import './style.css';
import { Camera } from './camera';
import memes from './memes.json';
import { actions, type Action, type Landmark } from './recognizer';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const preview = element<HTMLVideoElement>('preview');
const skeleton = element<HTMLCanvasElement>('skeleton');
const context = skeleton.getContext('2d');
const debug = element<HTMLInputElement>('debug');
const status = element('status');
const button = element<HTMLButtonElement>('camera-button');
const errorText = element('camera-error');
const diagnosisText = element('diagnosis');
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
  const { name, caption, image: path, alt } = memes[action];
  image.hidden = false;
  image.alt = alt;
  image.src = asset(path);
  element('meme-caption').textContent = caption;
  element('meme-action').textContent = name;
  element('result-empty').hidden = true;
  meme.hidden = false;
  for (const [key, card] of cards) card.classList.toggle('selected', key === action);
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
const diagnoses = {
  'no-person': '未检测到人物',
  'low-quality': '关键点不足，请正面入镜并露出双肩和手腕',
  tracking: '已检测到姿态',
  ambiguous: '动作重叠，等待明确姿势',
};

const camera = new Camera(preview, {
  status(phase, error) {
    status.textContent = labels[phase];
    status.dataset.phase = phase;
    const started = phase === 'loading' || phase === 'active';
    const busy = started || phase === 'requesting';
    preview.hidden = !started;
    element('camera-empty').hidden = started;
    skeleton.hidden = phase !== 'active' || !debug.checked;
    button.textContent = phase === 'error' ? '重试' : busy ? '关闭摄像头' : '开启摄像头';
    button.classList.toggle('stop', busy);
    errorText.textContent = error ?? '';
    errorText.hidden = !error;
  },
  frame(points, diagnosis) {
    if (!debug.checked) return;
    diagnosisText.textContent = diagnoses[diagnosis];
    diagnosisText.hidden = false;
    drawSkeleton(points);
  },
  result: showResult,
  clear() {
    context?.clearRect(0, 0, skeleton.width, skeleton.height);
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
debug.addEventListener('change', () => {
  skeleton.hidden = status.dataset.phase !== 'active' || !debug.checked;
  diagnosisText.hidden = !debug.checked || !diagnosisText.textContent;
});
window.addEventListener('pagehide', () => camera.stop());
