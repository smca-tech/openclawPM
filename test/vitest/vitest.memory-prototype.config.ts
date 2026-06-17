import path from "node:path";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

export default defineConfig({
  root: repoRoot,
  test: {
    name: "memory-prototype",
    environment: "node",
    include: [
      "test/migration-rules-prototype.test.ts",
      "test/memory-manager-prototype.test.ts",
      "test/memory-writer.test.ts",
      "test/memory-config-loaders.test.ts",
      "test/memory-recall-engine.test.ts",
      "test/memory-importer.test.ts",
      "test/memory-integration.test.ts",
    ],
    exclude: ["node_modules/**", "dist/**", "coverage/**"],
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      TZ: "UTC",
    },
  },
});
