import { DatabaseSync } from "node:sqlite";
import type { MemoryReadForUpdate, MemoryRow } from "../types.js";
import type { MemoryWriterStore } from "../write/memory-writer.js";
import { initializeMemoryDb } from "./memory-db.js";

function parseMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) return {};
  return JSON.parse(metadataJson) as Record<string, unknown>;
}

export class SqliteMemoryWriterStore implements MemoryWriterStore {
  constructor(readonly db: DatabaseSync) {
    initializeMemoryDb(db);
  }

  static open(path: string): SqliteMemoryWriterStore {
    return new SqliteMemoryWriterStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  findActiveMemoryIdByChecksum(checksum: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM memories WHERE checksum = ? AND status = 'active' LIMIT 1`)
      .get(checksum) as { id: string } | undefined;
    return row?.id ?? null;
  }

  memoryIdExists(memoryId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM memories WHERE id = ? LIMIT 1")
      .get(memoryId) as { ok: number } | undefined;
    return Boolean(row?.ok);
  }

  createMemory(input: Record<string, unknown>): string {
    this.db
      .prepare(`
      INSERT INTO memories (
        id, created_at, updated_at, kind, status, scope, scope_key, visibility,
        sensitivity, title, content, content_format, summary, importance,
        confidence, pinned, durable, source_type, source_ref, source_excerpt,
        author_type, author_id, session_id, parent_memory_id, checksum, metadata_json
      ) VALUES (
        @id, @created_at, @updated_at, @kind, @status, @scope, @scope_key, @visibility,
        @sensitivity, @title, @content, @content_format, @summary, @importance,
        @confidence, @pinned, @durable, @source_type, @source_ref, @source_excerpt,
        @author_type, @author_id, @session_id, @parent_memory_id, @checksum, @metadata_json
      )
    `)
      .run(input);
    return String(input.id);
  }

  readForUpdate(memoryId: string): MemoryReadForUpdate | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as
      | MemoryRow
      | undefined;
    if (!row) return null;

    const tags = this.db
      .prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag")
      .all(memoryId) as Array<{ tag: string }>;

    const mentions = this.db
      .prepare(
        "SELECT entity_type, entity_key, role FROM memory_mentions WHERE memory_id = ? ORDER BY entity_type, entity_key, role",
      )
      .all(memoryId) as Array<{ entity_type: string; entity_key: string; role: string | null }>;

    const metadata = parseMetadata(row.metadata_json);
    const version = typeof metadata.revision === "number" ? metadata.revision : 0;

    return {
      ...row,
      metadata,
      version,
      tags: tags.map((row) => row.tag),
      mentions,
    };
  }

  replaceTags(memoryId: string, tags: string[]): void {
    const deleteStmt = this.db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
    const insertStmt = this.db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      deleteStmt.run(memoryId);
      for (const tag of tags) insertStmt.run(memoryId, tag);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceMentions(memoryId: string, mentions: Array<[string, string, string | null]>): void {
    const deleteStmt = this.db.prepare("DELETE FROM memory_mentions WHERE memory_id = ?");
    const insertStmt = this.db.prepare(
      "INSERT INTO memory_mentions (memory_id, entity_type, entity_key, role) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      deleteStmt.run(memoryId);
      for (const [entityType, entityKey, role] of mentions) {
        insertStmt.run(memoryId, entityType, entityKey, role);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  logEvent(input: Record<string, unknown>): void {
    this.db
      .prepare(`
      INSERT INTO memory_events (
        id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json
      ) VALUES (
        @id, @memory_id, @event_type, @created_at, @session_id, @actor_type, @actor_id, @details_json
      )
    `)
      .run(input);
  }

  updateMemoryRow(memoryId: string, patch: Record<string, unknown>): void {
    this.db
      .prepare(`
      UPDATE memories
      SET updated_at = @updated_at,
          title = @title,
          content = @content,
          summary = @summary,
          importance = @importance,
          confidence = @confidence,
          pinned = @pinned,
          durable = @durable,
          sensitivity = @sensitivity,
          status = @status,
          checksum = @checksum,
          metadata_json = @metadata_json
      WHERE id = @id
    `)
      .run({ ...patch, id: memoryId });
  }

  markMemoryStatus(memoryId: string, status: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, memoryId);
  }

  createLink(input: Record<string, unknown>): void {
    this.db
      .prepare(`
      INSERT INTO memory_links (
        id, from_memory_id, to_memory_id, relation, weight, created_at, metadata_json
      ) VALUES (
        @id, @from_memory_id, @to_memory_id, @relation, @weight, @created_at, @metadata_json
      )
    `)
      .run(input);
  }
}
