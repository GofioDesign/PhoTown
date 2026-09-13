import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:8787',
    viewport: { width: 390, height: 844 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node node_modules/wrangler/bin/wrangler.js dev --port 8787 --ip 127.0.0.1',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 60000
  }
});
