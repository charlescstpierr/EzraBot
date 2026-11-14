import { defineConfig } from "@playwright/test";
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
    },
    {
      // Connected services with a fake provider and a fake App Server. Used by tests/composio-parcours.spec.ts only.
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: "4398", MINO_QA_TOOLS: "1" },
      url: "http://127.0.0.1:4398",
      reuseExistingServer: false,
    },
    {
      // Honcho memory with a fake Honcho and a fake App Server. Used by tests/honcho-parcours.spec.ts only.
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: "4397", MINO_QA_HONCHO: "1" },
      url: "http://127.0.0.1:4397",
      reuseExistingServer: false,
    },
    {
      // Honcho memory and connected services together, all fakes. Used by tests/memoire-action-parcours.spec.ts only.
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: "4396", MINO_QA_TOOLS: "1", MINO_QA_HONCHO: "1" },
      url: "http://127.0.0.1:4396",
      reuseExistingServer: false,
    },
  ],
});
