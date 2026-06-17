import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAllMemoryPrototypeConfigs,
  loadMigrationRulesConfig,
  loadRecallPresetsConfig,
  loadWriteHeuristicsConfig,
} from "../src/memory/config/loaders.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
});

function writeTempJson(value: unknown): string {
  const filePath = path.join(os.tmpdir(), `memory-config-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  tempFiles.push(filePath);
  return filePath;
}

describe("memory config loaders", () => {
  it("loads all prototype config files successfully", async () => {
    const configs = await loadAllMemoryPrototypeConfigs();
    expect(configs.migration.version).toBeTypeOf("string");
    expect(configs.recall.version).toBeTypeOf("string");
    expect(configs.write.version).toBeTypeOf("string");
  });

  it("rejects invalid migration config", async () => {
    const badPath = writeTempJson({ version: "bad-migration" });
    await expect(loadMigrationRulesConfig(badPath)).rejects.toThrow();
  });

  it("rejects invalid recall config", async () => {
    const badPath = writeTempJson({ version: "bad-recall", bucket_order: [] });
    await expect(loadRecallPresetsConfig(badPath)).rejects.toThrow();
  });

  it("rejects invalid write config", async () => {
    const badPath = writeTempJson({ version: "bad-write", remember: {} });
    await expect(loadWriteHeuristicsConfig(badPath)).rejects.toThrow();
  });
});
