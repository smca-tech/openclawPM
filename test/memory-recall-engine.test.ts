import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecallPresetsConfig } from "../src/memory/config/loaders.js";
import type { RecallPresetsConfig } from "../src/memory/config/types.js";
import { MemoryRecallEngine } from "../src/memory/recall/memory-recall-engine.js";
import { SqliteMemoryRecallStore } from "../src/memory/store/sqlite-memory-recall-store.js";
import { SqliteMemoryWriterStore } from "../src/memory/store/sqlite-memory-writer-store.js";
import { MemoryWriter, type MemoryWriterConfig } from "../src/memory/write/memory-writer.js";

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

async function createRecallFixture() {
  const dbPath = path.join(os.tmpdir(), `memory-recall-${Date.now()}-${Math.random()}.sqlite`);
  tempPaths.push(dbPath);

  const writerStore = SqliteMemoryWriterStore.open(dbPath);
  const writer = new MemoryWriter(writerStore, makeWriterConfig());

  writer.remember({
    title: "Global preference",
    content: "Prefer direct answers.",
    kind: "preference",
    scope: "global",
    pinned: true,
  });

  writer.remember({
    title: "Project fact",
    content: "openclawPM is the active project.",
    kind: "project",
    scope: "project",
    scopeKey: "openclawPM",
    importance: 90,
    mentions: [["project", "openclawPM", "subject"]],
  });

  writer.remember({
    title: "Secret project credential",
    content: "api key: super-secret",
    kind: "credential_ref",
    scope: "project",
    scopeKey: "openclawPM",
    sensitivity: "secret",
    pinned: true,
    mentions: [["project", "openclawPM", "subject"]],
  });

  writerStore.db
    .prepare(
      `INSERT INTO session_runs (id, started_at, agent, chat_id, chat_type, user_id, channel, title, cwd, metadata_json)
     VALUES (?, datetime('now'), 'main', ?, 'direct', ?, 'telegram', 'recall test', ?, '{}')`,
    )
    .run("recall-session", "telegram:8241756142", "8241756142", process.cwd());

  const recallStore = SqliteMemoryRecallStore.open(dbPath);
  const recallConfig = await loadRecallPresetsConfig();
  return { dbPath, writerStore, recallStore, recallConfig };
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

describe("MemoryRecallEngine", () => {
  it("dm recall can include richer results than group recall", async () => {
    const { writerStore, recallStore, recallConfig } = await createRecallFixture();
    try {
      const engine = new MemoryRecallEngine(recallStore, recallConfig);
      const dm = engine.startupHydrate({
        sessionId: "recall-session",
        chatId: "telegram:8241756142",
        userId: "8241756142",
        userKey: "johnny",
        agentKey: "yuki-mori",
        projectKey: "openclawPM",
        preset: "dm",
        mentionedEntities: [["project", "openclawPM"]],
      });
      const group = engine.startupHydrate({
        sessionId: "recall-session",
        chatId: "telegram:group:test",
        userId: "8241756142",
        agentKey: "yuki-mori",
        preset: "group",
      });
      expect(dm.merged.length).toBeGreaterThanOrEqual(group.merged.length);
      expect(group.merged.every((row) => row.sensitivity === "normal")).toBe(true);
    } finally {
      writerStore.close();
      recallStore.close();
    }
  });

  it("admin recall can include secret rows when includeSecret is true", async () => {
    const { writerStore, recallStore, recallConfig } = await createRecallFixture();
    try {
      const engine = new MemoryRecallEngine(recallStore, recallConfig);
      const admin = engine.startupHydrate({
        sessionId: "recall-session",
        chatId: "telegram:8241756142",
        userId: "8241756142",
        userKey: "johnny",
        projectKey: "openclawPM",
        preset: "admin",
        includeSecret: true,
        mentionedEntities: [["project", "openclawPM"]],
      });
      expect(admin.merged.some((row) => row.sensitivity === "secret")).toBe(true);
    } finally {
      writerStore.close();
      recallStore.close();
    }
  });

  it("logs recall events for hydrated rows", async () => {
    const { writerStore, recallStore, recallConfig } = await createRecallFixture();
    try {
      const engine = new MemoryRecallEngine(recallStore, recallConfig);
      const result = engine.startupHydrate({
        sessionId: "recall-session",
        chatId: "telegram:8241756142",
        userId: "8241756142",
        projectKey: "openclawPM",
        preset: "dm",
        mentionedEntities: [["project", "openclawPM"]],
      });
      const row = recallStore.db
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_events WHERE event_type = 'recalled' AND session_id = ?`,
        )
        .get("recall-session") as { count: number };
      expect(row.count).toBe(result.merged.length);
    } finally {
      writerStore.close();
      recallStore.close();
    }
  });

  it("supports preset bucket overrides via filter bundles and inline filters", async () => {
    const { writerStore, recallStore, recallConfig } = await createRecallFixture();
    try {
      const customConfig: RecallPresetsConfig = {
        ...recallConfig,
        filter_bundles: {
          ...(recallConfig.filter_bundles ?? {}),
          recent_one: { limit: 1 },
          admin_visible: { visibility: "all" },
        },
        presets: {
          ...recallConfig.presets,
          group: {
            bucket_strategies: {
              ...recallConfig.presets.group.bucket_strategies,
              pinned: {
                strategy: "default_pinned",
                filter_bundles: ["admin_visible"],
                filters: { limit: 1 },
              },
              recent: {
                strategy: "group_recent",
                filter_bundles: ["recent_one"],
              },
            },
          },
        },
      };
      const engine = new MemoryRecallEngine(recallStore, customConfig);
      const group = engine.startupHydrate({
        sessionId: "recall-session",
        chatId: "telegram:8241756142",
        userId: "8241756142",
        userKey: "johnny",
        agentKey: "yuki-mori",
        preset: "group",
      });
      expect(group.pinned).toHaveLength(1);
      expect(group.recent.length).toBeLessThanOrEqual(1);
    } finally {
      writerStore.close();
      recallStore.close();
    }
  });
});
