import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vite does not read tsconfig `paths` on its own, so the `@/` alias has to
    // be declared here too. Keep in sync with tsconfig.json.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Integration tests share one local D1 file; run them serially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
