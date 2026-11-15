import { defineConfig } from "@playwright/test";

// Without it Playwright kills the servers with SIGKILL, so scripts/test-server.mjs never removes its data folder.
const gracefulShutdown = { signal: "SIGTERM", timeout: 5000 } as const;
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4399",
    headless: true,
    screenshot: "only-on-failure",
    video: "on",
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: [
    {
      command: "node scripts/test-server.mjs",
      url: "http://127.0.0.1:4399",
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      // Connected services with a fake provider and a fake App Server. Used by tests/composio-parcours.spec.ts only.
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: "4398", MINO_QA_TOOLS: "1" },
      url: "http://127.0.0.1:4398",
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: "4397", MINO_QA_HONCHO: "1", MINO_QA_EVENTS: "1" },
      url: "http://127.0.0.1:4397",
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: "4396", MINO_QA_TOOLS: "1", MINO_QA_HONCHO: "1" },
      url: "http://127.0.0.1:4396",
      reuseExistingServer: false,
      gracefulShutdown,
    },
  ],
});
