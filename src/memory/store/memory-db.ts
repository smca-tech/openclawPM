import type { DatabaseSync } from "node:sqlite";
import { MEMORY_SCHEMA_SQL } from "../schema/memory-schema.js";

export interface MemoryDbLike {
  exec(sql: string): void;
}

export function initializeMemorySchema(db: MemoryDbLike): void {
  db.exec(MEMORY_SCHEMA_SQL);
}

export function applyMemoryPragmas(db: MemoryDbLike): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

export function initializeMemoryDb(db: MemoryDbLike): void {
  applyMemoryPragmas(db);
  initializeMemorySchema(db);
}

export type MemoryDatabase = DatabaseSync;
