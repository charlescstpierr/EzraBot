import { defineConfig } from "@playwright/test";
const qaPort = process.env.MINO_QA_PORT ?? "4399";
const toolsPort = process.env.MINO_QA_TOOLS_PORT ?? "4398";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${qaPort}`,
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
      url: `http://127.0.0.1:${qaPort}`,
      reuseExistingServer: false,
    },
    {
      // Connected services with a fake provider and a fake App Server. Used by tests/composio-parcours.spec.ts only.
      command: "node scripts/test-server.mjs",
      env: { MINO_QA_PORT: toolsPort, MINO_QA_TOOLS: "1" },
      url: `http://127.0.0.1:${toolsPort}`,
      reuseExistingServer: false,
    },
  ],
});
