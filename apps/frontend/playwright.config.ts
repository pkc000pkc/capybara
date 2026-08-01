import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://localhost:3000",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: "node e2e/mock-llm-server.mjs",
      cwd: process.cwd(),
      reuseExistingServer: true,
      timeout: 30_000,
      url: "http://127.0.0.1:3016/health",
    },
    {
      command: "npm run dev",
      cwd: path.resolve(process.cwd(), "../backend"),
      env: {
        CAPYBARA_PROJECT_DIR: path.resolve(process.cwd(), "../../examples/test-project"),
      },
      reuseExistingServer: true,
      timeout: 60_000,
      url: "http://localhost:3005/hello",
    },
    {
      command: "npm run dev",
      cwd: process.cwd(),
      reuseExistingServer: true,
      timeout: 60_000,
      url: "http://localhost:3000",
    },
  ],
});
