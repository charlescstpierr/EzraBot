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
  webServer: {
    command: "node scripts/test-server.mjs",
    url: "http://127.0.0.1:4399",
    reuseExistingServer: false,
  },
});
