import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadAllMemoryPrototypeConfigs } from "../src/memory/config/loaders.js";
import { importMarkdownMemory } from "../src/memory/import/import-markdown-memory.js";
import { MemoryRecallEngine } from "../src/memory/recall/memory-recall-engine.js";
import { SqliteMemoryRecallStore } from "../src/memory/store/sqlite-memory-recall-store.js";
import { SqliteMemoryWriterStore } from "../src/memory/store/sqlite-memory-writer-store.js";
import { MemoryWriter, type MemoryWriterConfig } from "../src/memory/write/memory-writer.js";

const workspacePath = "/home/smca-tech/.openclaw/workspace";
const tempPaths: string[] = [];

function makeWriterConfig(): MemoryWriterConfig {
  return {
    remember: {
      idPrefix: "mem_runtime_",
      idHashLength: 10,
      summaryMaxChars: 240,
      checksumFields: ["kind", "scope", "scope_key", "title", "content"],
      defaultVisibility: "private",
      contentFormat: "markdown",
      eventType: "created",
      eventActorId: "yuki",
    },
    update: {
      versionField: "revision",
      mergeTags: true,
      mergeMentions: true,
      recomputeChecksum: true,
      requireVersionMatch: true,
      eventType: "updated",
      eventActorId: "yuki",
    },
    supersede: {
      status: "superseded",
      linkRelation: "supersedes",
      linkWeight: 1,
      metadataCreatedBy: "memory_manager",
    },
  };
}

function seedImportedRows(
  db: DatabaseSync,
  imported: Awaited<ReturnType<typeof importMarkdownMemory>>,
) {
  const insertSession = db.prepare(`
    INSERT INTO session_runs (
      id, started_at, ended_at, agent, model, chat_id, chat_type, user_id,
      channel, title, cwd, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMemory = db.prepare(`
    INSERT INTO memories (
      id, created_at, updated_at, kind, status, scope, scope_key, visibility,
      sensitivity, title, content, content_format, summary, importance,
      confidence, pinned, durable, source_type, source_ref, source_excerpt,
      author_type, author_id, session_id, parent_memory_id, checksum, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTag = db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
  const insertMention = db.prepare(
    "INSERT INTO memory_mentions (memory_id, entity_type, entity_key, role) VALUES (?, ?, ?, ?)",
  );
  const insertLink = db.prepare(
    "INSERT INTO memory_links (id, from_memory_id, to_memory_id, relation, weight, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  db.exec("BEGIN");
  try {
    for (const session of imported.sessions) {
      insertSession.run(
        session.id,
        session.started_at,
        session.ended_at,
        session.agent,
        session.model,
        session.chat_id,
        session.chat_type,
        session.user_id,
        session.channel,
        session.title,
        session.cwd,
        session.metadata_json,
      );
    }

    for (const record of imported.records) {
      insertMemory.run(
        record.id,
        record.created_at,
        record.updated_at,
        record.kind,
        record.status,
        record.scope,
        record.scope_key,
        record.visibility,
        record.sensitivity,
        record.title,
        record.content,
        record.content_format,
        record.summary,
        record.importance,
        record.confidence,
        record.pinned,
        record.durable,
        record.source_type,
        record.source_ref,
        record.source_excerpt,
        record.author_type,
        record.author_id,
        record.session_id,
        record.parent_memory_id,
        record.checksum,
        record.metadata_json,
      );
      for (const tag of record.tags) insertTag.run(record.id, tag);
      for (const [entityType, entityKey, role] of record.mentions)
        insertMention.run(record.id, entityType, entityKey, role);
    }

    for (const link of imported.links) {
      insertLink.run(
        link.id,
        link.from_memory_id,
        link.to_memory_id,
        link.relation,
        link.weight,
        link.created_at,
        link.metadata_json,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

afterEach(() => {
  for (const file of tempPaths.splice(0, tempPaths.length)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
});

describe("memory subsystem TS integration", () => {
  it("loads config, imports markdown memory, seeds sqlite, writes runtime memory, and recalls it", async () => {
    const configs = await loadAllMemoryPrototypeConfigs();
    const imported = await importMarkdownMemory({ workspacePath, rules: configs.migration });

    const dbPath = path.join(
      os.tmpdir(),
      `memory-integration-${Date.now()}-${Math.random()}.sqlite`,
    );
    tempPaths.push(dbPath);

    const writerStore = SqliteMemoryWriterStore.open(dbPath);
    const recallStore = SqliteMemoryRecallStore.open(dbPath);

    try {
      seedImportedRows(writerStore.db, imported);

      writerStore.db
        .prepare(
          `INSERT INTO session_runs (id, started_at, agent, chat_id, chat_type, user_id, channel, title, cwd, metadata_json)
         VALUES (?, datetime('now'), 'main', ?, 'direct', ?, 'telegram', 'integration test', ?, '{}')`,
        )
        .run("integration-session", "telegram:8241756142", "8241756142", workspacePath);

      const writer = new MemoryWriter(writerStore, makeWriterConfig());
      const runtimeMemoryId = writer.remember({
        title: "Integration runtime memory",
        content: "Remember this integration runtime fact.",
        kind: "note",
        scope: "session",
        scopeKey: "integration-session",
        sessionId: "integration-session",
        mentions: [["project", "openclawPM", "subject"]],
        tags: ["integration", "runtime"],
        importance: 77,
      });

      const engine = new MemoryRecallEngine(recallStore, configs.recall);
      const hydrated = engine.startupHydrate({
        sessionId: "integration-session",
        chatId: "telegram:8241756142",
        userId: "8241756142",
        userKey: "johnny",
        projectKey: "openclawPM",
        agentKey: "yuki-mori",
        preset: "dm",
        mentionedEntities: [["project", "openclawPM"]],
        maxMemories: 50,
      });

      expect(imported.summary.sectionRecords).toBe(10);
      expect(imported.summary.atomicRecords).toBe(48);
      expect(runtimeMemoryId).toMatch(/^mem_runtime_/);
      expect(hydrated.merged.length).toBeGreaterThan(0);
      expect(hydrated.entity.some((row) => row.id === runtimeMemoryId)).toBe(true);
    } finally {
      writerStore.close();
      recallStore.close();
    }
  });
});
