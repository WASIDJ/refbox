import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test",
  timeout: 30000,
  expect: { timeout: 8000 },
  use: {
    baseURL: process.env.REFBOX_TEST_URL ?? "https://refbox.test",
    headless: true,
  },
  workers: 1,
});
