import { configDefaults, defineConfig } from "vitest/config";

// Coverage gate (DEC-053): V8 lines >= 85% over product code, entry points
// excluded. Ratchet the threshold up, never down.
export default defineConfig({
  test: {
    // Only this repo's suite: direnv copies flake inputs (with their own
    // tests) under .direnv/, which vitest's default glob would collect.
    include: ["test/**/*.test.ts"],
    // The mail smoke runs the real screwtape on a copy of the real store: opt-in
    // only (MALEBOLGE_MAIL_SMOKE=1), never part of `just check` (SL-005 VT-12).
    exclude: [
      ...configDefaults.exclude,
      ...(process.env["MALEBOLGE_MAIL_SMOKE"] === "1" ? [] : ["test/mail/smoke.test.ts"]),
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/*-main.ts"],
      thresholds: { lines: 85 },
    },
  },
});
