import crypto from "node:crypto";
import type {
  MemoryMetadata,
  MemoryReadForUpdate,
  RememberMemoryInput,
  UpdateMemoryInput,
} from "../types.js";
import { incrementMemoryVersion, getMemoryVersionFromMetadata } from "./memory-versioning.js";

export interface MemoryWriterConfig {
  remember: {
    idPrefix: string;
    idHashLength: number;
    summaryMaxChars: number;
    checksumFields: Array<"kind" | "scope" | "scope_key" | "title" | "content">;
    defaultVisibility: string;
    contentFormat: string;
    eventType: string;
    eventActorId: string;
  };
  update: {
    versionField: string;
    mergeTags: boolean;
    mergeMentions: boolean;
    recomputeChecksum: boolean;
    requireVersionMatch: boolean;
    eventType: string;
    eventActorId: string;
  };
  supersede: {
    status: string;
    linkRelation: string;
    linkWeight: number;
    metadataCreatedBy: string;
  };
}

export interface MemoryWriterStore {
  findActiveMemoryIdByChecksum(checksum: string): string | null;
  memoryIdExists(memoryId: string): boolean;
  createMemory(input: Record<string, unknown>): string;
  readForUpdate(memoryId: string): MemoryReadForUpdate | null;
  replaceTags(memoryId: string, tags: string[]): void;
  replaceMentions(memoryId: string, mentions: Array<[string, string, string | null]>): void;
  logEvent(input: Record<string, unknown>): void;
  updateMemoryRow(memoryId: string, patch: Record<string, unknown>): void;
  markMemoryStatus(memoryId: string, status: string, updatedAt: string): void;
  createLink(input: Record<string, unknown>): void;
}

export class MemoryVersionConflictError extends Error {}
export class MemoryNotFoundError extends Error {}

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export function nowIso(): string {
  return new Date().toISOString().replace(".000Z", "Z");
}

export function computeMemoryChecksum(
  input: {
    kind: string;
    scope: string;
    scope_key: string | null;
    title: string | null;
    content: string;
  },
  fields: MemoryWriterConfig["remember"]["checksumFields"],
): string {
  const parts = fields.map((field) => String(input[field] ?? ""));
  return sha256Text(parts.join("|"));
}

export class MemoryWriter {
  constructor(
    private readonly store: MemoryWriterStore,
    private readonly config: MemoryWriterConfig,
  ) {}

  remember(input: RememberMemoryInput): string {
    const checksum = computeMemoryChecksum(
      {
        kind: input.kind,
        scope: input.scope,
        scope_key: input.scopeKey ?? null,
        title: input.title ?? null,
        content: input.content,
      },
      this.config.remember.checksumFields,
    );

    const existingId = this.store.findActiveMemoryIdByChecksum(checksum);
    if (existingId) return existingId;

    const baseMemoryId = `${this.config.remember.idPrefix}${slugify(input.title ?? input.content.slice(0, 40))}_${checksum.slice(0, this.config.remember.idHashLength)}`;
    let memoryId = baseMemoryId;
    let counter = 1;
    while (this.store.memoryIdExists(memoryId)) {
      memoryId = `${baseMemoryId}_v${counter}`;
      counter += 1;
    }

    const createdAt = nowIso();
    const summary =
      input.content.split("\n")[0]?.slice(0, this.config.remember.summaryMaxChars) ?? "";
    const metadata: MemoryMetadata = {
      ...(input.metadata ?? {}),
      [this.config.update.versionField]: 0,
    };

    this.store.createMemory({
      id: memoryId,
      created_at: createdAt,
      updated_at: createdAt,
      kind: input.kind,
      status: "active",
      scope: input.scope,
      scope_key: input.scopeKey ?? null,
      visibility: this.config.remember.defaultVisibility,
      sensitivity: input.sensitivity ?? "normal",
      title: input.title ?? null,
      content: input.content,
      content_format: this.config.remember.contentFormat,
      summary,
      importance: input.importance ?? 60,
      confidence: input.confidence ?? 1,
      pinned: input.pinned ? 1 : 0,
      durable: input.durable === false ? 0 : 1,
      source_type: input.sourceType ?? "manual",
      source_ref: input.sourceRef ?? null,
      source_excerpt: summary,
      author_type: input.authorType ?? "assistant",
      author_id: input.authorId ?? this.config.remember.eventActorId,
      session_id: input.sessionId ?? null,
      parent_memory_id: input.parentMemoryId ?? null,
      checksum,
      metadata_json: JSON.stringify(metadata),
    });

    this.store.replaceTags(memoryId, [...new Set(input.tags ?? [])]);
    this.store.replaceMentions(memoryId, input.mentions ?? []);
    this.store.logEvent({
      id: `evt_${memoryId}_${this.config.remember.eventType}`,
      memory_id: memoryId,
      event_type: this.config.remember.eventType,
      created_at: createdAt,
      session_id: input.sessionId ?? null,
      actor_type: input.authorType ?? "assistant",
      actor_id: input.authorId ?? this.config.remember.eventActorId,
      details_json: JSON.stringify({
        source_type: input.sourceType ?? "manual",
        source_ref: input.sourceRef ?? null,
      }),
    });

    return memoryId;
  }

  getMemoryVersion(record: MemoryReadForUpdate): number {
    return getMemoryVersionFromMetadata(record.metadata, this.config.update.versionField);
  }

  updateMemory(memoryId: string, input: UpdateMemoryInput): string {
    const record = this.store.readForUpdate(memoryId);
    if (!record) throw new MemoryNotFoundError(`Memory not found: ${memoryId}`);

    const currentVersion = this.getMemoryVersion(record);
    if (this.config.update.requireVersionMatch && input.expectedVersion !== currentVersion) {
      throw new MemoryVersionConflictError(
        `Stale update for ${memoryId}: expected ${this.config.update.versionField}=${input.expectedVersion}, actual ${this.config.update.versionField}=${currentVersion}`,
      );
    }

    const nextTitle = input.title ?? record.title;
    const nextContent = input.content ?? record.content;
    const nextSummary =
      input.summary ??
      nextContent.split("\n")[0]?.slice(0, this.config.remember.summaryMaxChars) ??
      record.summary;
    const nextMetadata = incrementMemoryVersion(
      input.metadata ?? record.metadata,
      this.config.update.versionField,
    );
    const nextChecksum = this.config.update.recomputeChecksum
      ? computeMemoryChecksum(
          {
            kind: record.kind,
            scope: record.scope,
            scope_key: record.scope_key,
            title: nextTitle,
            content: nextContent,
          },
          this.config.remember.checksumFields,
        )
      : record.checksum;

    this.store.updateMemoryRow(memoryId, {
      updated_at: nowIso(),
      title: nextTitle,
      content: nextContent,
      summary: nextSummary,
      importance: input.importance ?? record.importance,
      confidence: input.confidence ?? record.confidence,
      pinned: input.pinned == null ? record.pinned : input.pinned ? 1 : 0,
      durable: input.durable == null ? record.durable : input.durable ? 1 : 0,
      sensitivity: input.sensitivity ?? record.sensitivity,
      status: input.status ?? record.status,
      checksum: nextChecksum,
      metadata_json: JSON.stringify(nextMetadata),
    });

    if (input.tags) {
      const tags = this.config.update.mergeTags
        ? [...new Set([...record.tags, ...input.tags])]
        : [...new Set(input.tags)];
      this.store.replaceTags(memoryId, tags);
    }

    if (input.mentions) {
      const mentions = this.config.update.mergeMentions
        ? [
            ...new Map([
              ...record.mentions.map((m) => [
                JSON.stringify(m),
                [m.entity_type, m.entity_key, m.role] as [string, string, string | null],
              ]),
              ...input.mentions.map((m) => [JSON.stringify(m), m]),
            ]).values(),
          ]
        : input.mentions;
      this.store.replaceMentions(memoryId, mentions);
    }

    this.store.logEvent({
      id: `evt_${memoryId}_${this.config.update.eventType}_${sha256Text(`${memoryId}|${JSON.stringify(input)}`).slice(0, 10)}`,
      memory_id: memoryId,
      event_type: this.config.update.eventType,
      created_at: nowIso(),
      session_id: input.sessionId ?? null,
      actor_type: input.authorType ?? "assistant",
      actor_id: input.authorId ?? this.config.update.eventActorId,
      details_json: JSON.stringify({
        expected_version: input.expectedVersion,
        previous_version: currentVersion,
        new_version: getMemoryVersionFromMetadata(nextMetadata, this.config.update.versionField),
      }),
    });

    return memoryId;
  }

  supersedeMemory(oldMemoryId: string, newMemoryId: string): void {
    this.store.markMemoryStatus(oldMemoryId, this.config.supersede.status, nowIso());
    this.store.createLink({
      id: `lnk_${newMemoryId}_${this.config.supersede.linkRelation}_${oldMemoryId}`,
      from_memory_id: newMemoryId,
      to_memory_id: oldMemoryId,
      relation: this.config.supersede.linkRelation,
      weight: this.config.supersede.linkWeight,
      created_at: nowIso(),
      metadata_json: JSON.stringify({ created_by: this.config.supersede.metadataCreatedBy }),
    });
  }
}
