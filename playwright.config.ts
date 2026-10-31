// 総合テスト（TC-S）。ビルド済みの dist を astro preview で配信して検査する。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:4321/three-body/" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview -- --port 4321 --ignore-lock",
    url: "http://localhost:4321/three-body/",
    reuseExistingServer: !process.env.CI,
  },
});
