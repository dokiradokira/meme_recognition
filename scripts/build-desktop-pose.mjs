import { cp, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repository = new URL('../', import.meta.url);
const output = new URL('../desktop/CongYou/dist/pose-engine/', import.meta.url);
await build({
  root: fileURLToPath(repository),
  configFile: false,
  publicDir: false,
  base: './',
  build: {
    outDir: fileURLToPath(output),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('src/desktop-pose.ts', repository)),
      output: { entryFileNames: 'pose-engine.js' },
    },
  },
});
await Promise.all([
  copyFile(new URL('desktop/CongYou/engine/index.html', repository), new URL('index.html', output)),
  cp(new URL('public/pose/', repository), new URL('pose/', output), { recursive: true }),
]);
