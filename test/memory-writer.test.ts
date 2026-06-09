import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryWriterStore } from "../src/memory/store/sqlite-memory-writer-store.js";
import {
  MemoryWriter,
  type MemoryWriterConfig,
  MemoryVersionConflictError,
} from "../src/memory/write/memory-writer.js";

const tempPaths: string[] = [];

function makeConfig(): MemoryWriterConfig {
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

function createWriter() {
  const dbPath = path.join(os.tmpdir(), `memory-writer-${Date.now()}-${Math.random()}.sqlite`);
  tempPaths.push(dbPath);
  const store = SqliteMemoryWriterStore.open(dbPath);
  const writer = new MemoryWriter(store, makeConfig());
  return { store, writer, dbPath };
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

describe("MemoryWriter", () => {
  it("dedupes identical remember calls by checksum", () => {
    const { store, writer } = createWriter();
    try {
      const first = writer.remember({
        title: "TS memory",
        content: "same content",
        kind: "note",
        scope: "session",
        scopeKey: "ts-session",
        sessionId: null,
      });
      const second = writer.remember({
        title: "TS memory",
        content: "same content",
        kind: "note",
        scope: "session",
        scopeKey: "ts-session",
        sessionId: null,
      });
      expect(first).toBe(second);
    } finally {
      store.close();
    }
  });

  it("updates memory in place and increments revision", () => {
    const { store, writer } = createWriter();
    try {
      const memoryId = writer.remember({
        title: "Mutable TS memory",
        content: "old content",
        kind: "note",
        scope: "session",
        scopeKey: "ts-update",
        sessionId: null,
      });
      const before = store.readForUpdate(memoryId);
      expect(before?.version).toBe(0);

      writer.updateMemory(memoryId, {
        expectedVersion: before?.version ?? 0,
        content: "new content",
      });

      const after = store.readForUpdate(memoryId);
      expect(after?.content).toBe("new content");
      expect(after?.version).toBe(1);
      expect(after?.checksum).not.toBe(before?.checksum ?? null);
    } finally {
      store.close();
    }
  });

  it("rejects stale version updates", () => {
    const { store, writer } = createWriter();
    try {
      const memoryId = writer.remember({
        title: "Stale TS memory",
        content: "base content",
        kind: "note",
        scope: "session",
        scopeKey: "ts-stale",
        sessionId: null,
      });
      const first = store.readForUpdate(memoryId);
      writer.updateMemory(memoryId, {
        expectedVersion: first?.version ?? 0,
        content: "fresh content",
      });
      expect(() =>
        writer.updateMemory(memoryId, {
          expectedVersion: first?.version ?? 0,
          content: "stale content",
        }),
      ).toThrow(MemoryVersionConflictError);
    } finally {
      store.close();
    }
  });

  it("supersedes old memory and creates link row", () => {
    const { store, writer } = createWriter();
    try {
      const oldId = writer.remember({
        title: "Old TS memory",
        content: "old ts content",
        kind: "note",
        scope: "session",
        scopeKey: "ts-supersede",
        sessionId: null,
      });
      const newId = writer.remember({
        title: "New TS memory",
        content: "new ts content",
        kind: "note",
        scope: "session",
        scopeKey: "ts-supersede",
        sessionId: null,
      });

      writer.supersedeMemory(oldId, newId);

      const oldRecord = store.readForUpdate(oldId);
      expect(oldRecord?.status).toBe("superseded");

      const link = store.db
        .prepare("SELECT relation FROM memory_links WHERE from_memory_id = ? AND to_memory_id = ?")
        .get(newId, oldId) as { relation: string } | undefined;
      expect(link?.relation).toBe("supersedes");
    } finally {
      store.close();
    }
  });
});
