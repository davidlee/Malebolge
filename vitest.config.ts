import { defineConfig } from "vitest/config";

// Coverage gate (DEC-053): V8 lines >= 85% over product code, entry points
// excluded. Ratchet the threshold up, never down.
export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/*-main.ts"],
      thresholds: { lines: 85 },
    },
  },
});
