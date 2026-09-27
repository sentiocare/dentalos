import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file creates its own throwaway database, so files can run in parallel safely.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
