import { globSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Uses the pre-installed Chromium when present (cloud dev boxes), otherwise Playwright's own.
const chromium = process.env.PW_CHROMIUM ?? globSync("/opt/pw-browsers/chromium-*/chrome-linux*/chrome")[0];

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // Staff use cheap Android phones: test at 360px wide with touch.
    viewport: { width: 360, height: 780 },
    hasTouch: true,
    isMobile: true,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: "retain-on-failure",
  },
});
