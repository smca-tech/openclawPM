import { DatabaseSync } from "node:sqlite";
import type { RecallMemoryRow, RecallStore } from "../recall/types.js";
import { initializeMemoryDb } from "./memory-db.js";

export class SqliteMemoryRecallStore implements RecallStore {
  constructor(readonly db: DatabaseSync) {
    initializeMemoryDb(db);
  }

  static open(path: string): SqliteMemoryRecallStore {
    return new SqliteMemoryRecallStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  fetchAll(sql: string, params: unknown[] = []): RecallMemoryRow[] {
    return this.db.prepare(sql).all(...params) as RecallMemoryRow[];
  }

  logRecallEvent(input: {
    id: string;
    memoryId: string;
    createdAt: string;
    sessionId: string;
    detailsJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_events (id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json)
       VALUES (?, ?, 'recalled', ?, ?, 'assistant', 'memory_recall_engine', ?)`,
      )
      .run(input.id, input.memoryId, input.createdAt, input.sessionId, input.detailsJson);
  }
}
