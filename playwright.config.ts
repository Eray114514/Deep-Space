import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'npm run dev -- --port 4173', port: 4173, reuseExistingServer: true },
});
