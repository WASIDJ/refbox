import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test",
  timeout: 60000,
  use: {
    baseURL: process.env.REFBOX_TEST_URL ?? "http://127.0.0.1:8080",
    headless: true,
  },
  workers: 1,
});
