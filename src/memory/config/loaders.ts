import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationRulesSchema, recallPresetsSchema, writeHeuristicsSchema } from "./schemas.js";
import type { MigrationRulesConfig, RecallPresetsConfig, WriteHeuristicsConfig } from "./types.js";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const prototypeDir = path.resolve(thisDir, "../../../working/memory-prototype");

export const DEFAULT_MIGRATION_RULES_PATH = path.join(prototypeDir, "migration_rules.json");
export const DEFAULT_RECALL_PRESETS_PATH = path.join(prototypeDir, "recall_presets.json");
export const DEFAULT_WRITE_HEURISTICS_PATH = path.join(prototypeDir, "write_heuristics.json");

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function loadMigrationRulesConfig(
  filePath = DEFAULT_MIGRATION_RULES_PATH,
): Promise<MigrationRulesConfig> {
  const raw = await readJsonFile(filePath);
  return migrationRulesSchema.parse(raw) as MigrationRulesConfig;
}

export async function loadRecallPresetsConfig(
  filePath = DEFAULT_RECALL_PRESETS_PATH,
): Promise<RecallPresetsConfig> {
  const raw = await readJsonFile(filePath);
  return recallPresetsSchema.parse(raw) as RecallPresetsConfig;
}

export async function loadWriteHeuristicsConfig(
  filePath = DEFAULT_WRITE_HEURISTICS_PATH,
): Promise<WriteHeuristicsConfig> {
  const raw = await readJsonFile(filePath);
  return writeHeuristicsSchema.parse(raw) as WriteHeuristicsConfig;
}

export async function loadAllMemoryPrototypeConfigs() {
  const [migration, recall, write] = await Promise.all([
    loadMigrationRulesConfig(),
    loadRecallPresetsConfig(),
    loadWriteHeuristicsConfig(),
  ]);
  return { migration, recall, write };
}
