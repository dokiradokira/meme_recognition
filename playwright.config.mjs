import { defineConfig } from '@playwright/test';

const dev = 'http://localhost:4173';
const production = 'http://localhost:4174';
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.mjs',
  use: {
    baseURL: dev,
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'Chrome', use: { channel: 'chrome' } },
    { name: 'Edge', use: { channel: 'msedge' } },
  ],
  webServer: [
    { command: 'npm run dev -- --host localhost --port 4173 --strictPort', url: dev },
    { command: 'npm run preview -- --host localhost --port 4174 --strictPort', url: production },
  ],
});
