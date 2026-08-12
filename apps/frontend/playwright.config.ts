import { defineConfig } from "@playwright/test";
import path from "node:path";

const frontendPort = Number(process.env.CAPYBARA_E2E_FRONTEND_PORT ?? 3000);
const backendPort = Number(process.env.CAPYBARA_E2E_BACKEND_PORT ?? 3005);
const modelPort = Number(process.env.CAPYBARA_E2E_MODEL_PORT ?? 3016);
const reuseExistingServer = process.env.CAPYBARA_E2E_REUSE_EXISTING !== "false";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://localhost:${frontendPort}`,
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
      env: { CAPYBARA_E2E_MODEL_PORT: String(modelPort) },
      reuseExistingServer,
      timeout: 30_000,
      url: `http://127.0.0.1:${modelPort}/health`,
    },
    {
      command: "npm run dev",
      cwd: path.resolve(process.cwd(), "../backend"),
      env: {
        CAPYBARA_PROJECT_DIR: path.resolve(process.cwd(), "../../examples/test-project"),
        PORT: String(backendPort),
      },
      reuseExistingServer,
      timeout: 60_000,
      url: `http://localhost:${backendPort}/hello`,
    },
    {
      command: "npm run dev",
      cwd: process.cwd(),
      env: {
        CAPYBARA_NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_RUNTIME_HTTP_URL: `http://localhost:${backendPort}`,
        NEXT_PUBLIC_RUNTIME_WS_URL: `ws://localhost:${backendPort}/ws/runtime`,
        PORT: String(frontendPort),
      },
      reuseExistingServer,
      timeout: 60_000,
      url: `http://localhost:${frontendPort}`,
    },
  ],
});
