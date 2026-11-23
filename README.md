# 姿势派对

打开摄像头做一个动作，页面会显示对应的原创猫猫表情包。MVP 支持双手举高、双臂横举、左右任一手挥动和双臂交叉。

## 本地运行

需要 Node.js 22.18 或更新版本，以及 Windows 桌面版 Chrome 或 Edge。

```sh
npm ci
npm run dev
```

打开终端中显示的 localhost 地址，点击「开启摄像头」并授权。请单人正面入镜，让头部、双肩、手肘和手腕都能被看到。做静态动作时保持片刻。挥手时让另一只手自然放低，并用同一只手在肩上方完成一次左右往返。

「骨架调试」显示关键点和追踪状态。短暂无人入镜或关键点不足时，最近的结果会保留。点击「关闭摄像头」会停止视频并清除结果。

## 构建与验证

```sh
npm test
npm run test:e2e
npm run build
npm run preview
```

开发和构建时会从 Google 下载固定版本的 [Pose Landmarker Lite 模型](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)，校验 SHA-256，并将模型和 npm 包中的 WASM 放到同源静态目录。随后可使用已缓存的模型。构建产物在 `dist/`，可部署到支持 HTTPS 的静态服务器。生产页面限制网络连接到页面自身的源，摄像头画面和关键点仅用于本地推理。

浏览器测试在 Chrome 和 Edge 中用画布生成可重复的视频流，覆盖摄像头会话、故障恢复、关键点到成品表情包的链路，以及生产构建中的真实 MediaPipe 推理。真实参与者的识别率、误触发率和响应延迟需按[项目方案](PROJECT_PROPOSAL.md#测试与验收)另行验收。

表情包文件在 `public/memes/`，配文、替代文本和来源在 `src/memes.json`。替换素材无需修改姿态规则。
