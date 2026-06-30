import crypto from "node:crypto";
import type { RecallPresetsConfig } from "../config/types.js";
import type { RecallBuckets, RecallMemoryRow, RecallSessionContext, RecallStore } from "./types.js";

function nowIso(): string {
  return new Date().toISOString().replace(".000Z", "Z");
}

function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

type RecallStrategyConfig = Record<string, unknown>;

type RecallPresetBucketConfig =
  | string
  | {
      strategy: string;
      filter_bundles?: string[];
      filters?: Record<string, unknown>;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigFragments(
  ...fragments: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const fragment of fragments) {
    if (!fragment) continue;
    for (const [key, value] of Object.entries(fragment)) {
      const existing = merged[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        merged[key] = mergeConfigFragments(existing, value);
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export class MemoryRecallEngine {
  private readonly strategyHandlers: Record<
    string,
    (ctx: RecallSessionContext, cfg: RecallStrategyConfig) => RecallMemoryRow[]
  > = {
    default_pinned: (ctx, cfg) => this.fetchDefaultPinned(ctx, cfg),
    group_pinned: (ctx, cfg) => this.fetchGroupPinned(ctx, cfg),
    project_pinned: (ctx, cfg) => this.fetchProjectPinned(ctx, cfg),
    admin_pinned: (ctx, cfg) => this.fetchAdminPinned(ctx, cfg),
    default_scoped: (ctx, cfg) => this.fetchDefaultScoped(ctx, cfg),
    group_scoped: (ctx, cfg) => this.fetchGroupScoped(ctx, cfg),
    project_scoped: (ctx, cfg) => this.fetchProjectScoped(ctx, cfg),
    admin_scoped: (ctx, cfg) => this.fetchAdminScoped(ctx, cfg),
    default_entity: (ctx, cfg) => this.fetchDefaultEntity(ctx, cfg),
    group_entity: (ctx, cfg) => this.fetchGroupEntity(ctx, cfg),
    default_recent: (ctx, cfg) => this.fetchDefaultRecent(ctx, cfg),
    group_recent: (ctx, cfg) => this.fetchGroupRecent(ctx, cfg),
  };

  constructor(
    private readonly store: RecallStore,
    private readonly config: RecallPresetsConfig,
  ) {}

  startupHydrate(ctx: RecallSessionContext): RecallBuckets {
    const presetName = ctx.preset ?? "dm";
    const preset = this.config.presets[presetName] ?? this.config.presets.dm;

    const pinned = this.runPresetBucket(preset.bucket_strategies.pinned, ctx);
    const scoped = this.runPresetBucket(preset.bucket_strategies.scoped, ctx);
    const entity = this.runPresetBucket(preset.bucket_strategies.entity, ctx);
    const recent = this.runPresetBucket(preset.bucket_strategies.recent, ctx);
    const merged = this.mergeRankedGroups(
      { pinned, scoped, entity, recent },
      ctx.maxMemories ?? 40,
    );

    this.logRecallEvents(merged, ctx.sessionId);

    return { pinned, scoped, entity, recent, merged };
  }

  private runPresetBucket(
    entry: RecallPresetBucketConfig | undefined,
    ctx: RecallSessionContext,
  ): RecallMemoryRow[] {
    if (!entry) {
      return [];
    }
    if (typeof entry === "string") {
      return this.runStrategy(entry, ctx, this.resolveStrategyConfig(entry));
    }
    return this.runStrategy(entry.strategy, ctx, this.resolveStrategyConfig(entry.strategy, entry));
  }

  private resolveStrategyConfig(
    strategyName: string,
    entry?: Exclude<RecallPresetBucketConfig, string>,
  ): RecallStrategyConfig {
    const bundleConfigs = (entry?.filter_bundles ?? []).map((bundleName) => {
      const bundle = this.config.filter_bundles?.[bundleName];
      if (!bundle) {
        throw new Error(`Unknown recall filter bundle: ${bundleName}`);
      }
      return bundle;
    });
    const strategyConfig = this.config.strategies[strategyName];
    if (!strategyConfig) {
      throw new Error(`Unknown recall strategy: ${strategyName}`);
    }
    return mergeConfigFragments(...bundleConfigs, strategyConfig, entry?.filters);
  }

  private runStrategy(
    name: string,
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const handler = this.strategyHandlers[name];
    if (!handler) {
      throw new Error(`Unknown recall strategy: ${name}`);
    }
    return handler(ctx, cfg);
  }

  private visibilityClause(
    mode: string | undefined,
    ctx: RecallSessionContext,
    alias = "",
  ): string {
    const column = alias ? `${alias}sensitivity` : "sensitivity";
    if (mode === "all") return "";
    if (mode === "normal_only") return `AND ${column} = 'normal'`;
    if (ctx.includeSecret) return "";
    return `AND ${column} != 'secret'`;
  }

  private fetchDefaultPinned(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND pinned = 1 ${this.visibilityClause(String(cfg.visibility), ctx)} AND (scope = 'global' OR (scope = 'user' AND scope_key = ?) OR (scope = 'agent' AND scope_key = ?)) ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      [ctx.userKey ?? null, ctx.agentKey ?? null, Number(cfg.limit ?? 20)],
    );
  }

  private fetchGroupPinned(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const kinds = (cfg.allowed_kinds as string[]).map(() => "?").join(",");
    const scopes = (cfg.scopes as string[]).map(() => "?").join(",");
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND pinned = 1 AND sensitivity = 'normal' AND kind IN (${kinds}) AND scope IN (${scopes}) ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      [...(cfg.allowed_kinds as string[]), ...(cfg.scopes as string[]), Number(cfg.limit ?? 12)],
    );
  }

  private fetchProjectPinned(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const userKinds = (cfg.fallback_user_kinds as string[]).map(() => "?").join(",");
    const globalKinds = (cfg.fallback_global_kinds as string[]).map(() => "?").join(",");
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND pinned = 1 ${this.visibilityClause(String(cfg.visibility), ctx)} AND ((scope = 'project' AND scope_key = ?) OR (scope = 'user' AND scope_key = ? AND kind IN (${userKinds})) OR (scope = 'global' AND kind IN (${globalKinds}))) ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      [
        ctx.projectKey ?? null,
        ctx.userKey ?? null,
        ...(cfg.fallback_user_kinds as string[]),
        ...(cfg.fallback_global_kinds as string[]),
        Number(cfg.limit ?? 20),
      ],
    );
  }

  private fetchAdminPinned(
    _ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND pinned = 1 ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      [Number(cfg.limit ?? 25)],
    );
  }

  private fetchDefaultScoped(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const t = cfg.importance_thresholds as Record<string, number>;
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' ${this.visibilityClause(String(cfg.visibility), ctx)} AND ((scope = 'global' AND importance >= ?) OR (scope = 'user' AND scope_key = ? AND importance >= ?) OR (scope = 'project' AND scope_key = ? AND importance >= ?) OR (scope = 'chat' AND scope_key = ? AND importance >= ?) OR (scope = 'agent' AND scope_key = ? AND importance >= ?)) ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`,
      [
        t.global ?? 75,
        ctx.userKey ?? null,
        t.user ?? 70,
        ctx.projectKey ?? null,
        t.project ?? 65,
        ctx.chatId ?? null,
        t.chat ?? 60,
        ctx.agentKey ?? null,
        t.agent ?? 70,
        Number(cfg.limit ?? 40),
      ],
    );
  }

  private fetchGroupScoped(
    _ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const kinds = (cfg.allowed_kinds as string[]).map(() => "?").join(",");
    const t = cfg.importance_thresholds as Record<string, number>;
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND sensitivity = 'normal' AND kind IN (${kinds}) AND ((scope = 'global' AND importance >= ?) OR (scope = 'agent' AND importance >= ?) OR (scope = 'project' AND importance >= ?)) ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`,
      [
        ...(cfg.allowed_kinds as string[]),
        t.global ?? 75,
        t.agent ?? 75,
        t.project ?? 80,
        Number(cfg.limit ?? 25),
      ],
    );
  }

  private fetchProjectScoped(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const t = cfg.importance_thresholds as Record<string, number>;
    const userKinds = (cfg.fallback_user_kinds as string[]).map(() => "?").join(",");
    const globalKinds = (cfg.fallback_global_kinds as string[]).map(() => "?").join(",");
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' ${this.visibilityClause(String(cfg.visibility), ctx)} AND ((scope = 'project' AND scope_key = ? AND importance >= ?) OR (scope = 'user' AND scope_key = ? AND kind IN (${userKinds}) AND importance >= ?) OR (scope = 'global' AND kind IN (${globalKinds}) AND importance >= ?)) ORDER BY CASE WHEN scope = 'project' AND scope_key = ? THEN 0 ELSE 1 END, pinned DESC, importance DESC, updated_at DESC LIMIT ?`,
      [
        ctx.projectKey ?? null,
        t.project ?? 55,
        ctx.userKey ?? null,
        ...(cfg.fallback_user_kinds as string[]),
        t.user ?? 75,
        ...(cfg.fallback_global_kinds as string[]),
        t.global ?? 70,
        ctx.projectKey ?? null,
        Number(cfg.limit ?? 40),
      ],
    );
  }

  private fetchAdminScoped(
    _ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND importance >= ? ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`,
      [Number(cfg.minimum_importance ?? 50), Number(cfg.limit ?? 50)],
    );
  }

  private fetchDefaultEntity(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const entities = ctx.mentionedEntities ?? [];
    const seen = new Map<string, RecallMemoryRow>();
    for (const [entityType, entityKey] of entities) {
      const rows = this.store.fetchAll(
        `SELECT m.* FROM memory_mentions mm JOIN memories m ON m.id = mm.memory_id WHERE mm.entity_type = ? AND mm.entity_key = ? AND m.status = 'active' ${this.visibilityClause(String(cfg.visibility), ctx, "m.")} ORDER BY CASE WHEN ${cfg.demote_normal_credentials ? 1 : 0} AND m.kind = 'credential_ref' AND m.sensitivity = 'normal' THEN 1 ELSE 0 END, m.pinned DESC, m.importance DESC, m.updated_at DESC LIMIT ?`,
        [entityType, entityKey, Number(cfg.per_entity_limit ?? 10)],
      );
      for (const row of rows) seen.set(row.id, row);
    }
    return [...seen.values()];
  }

  private fetchGroupEntity(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const entities = ctx.mentionedEntities ?? [];
    const seen = new Map<string, RecallMemoryRow>();
    const scopes = (cfg.scopes as string[]).map(() => "?").join(",");
    const kinds = (cfg.allowed_kinds as string[]).map(() => "?").join(",");
    for (const [entityType, entityKey] of entities) {
      const rows = this.store.fetchAll(
        `SELECT m.* FROM memory_mentions mm JOIN memories m ON m.id = mm.memory_id WHERE mm.entity_type = ? AND mm.entity_key = ? AND m.status = 'active' AND m.sensitivity = 'normal' AND m.scope IN (${scopes}) AND m.kind IN (${kinds}) ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`,
        [
          entityType,
          entityKey,
          ...(cfg.scopes as string[]),
          ...(cfg.allowed_kinds as string[]),
          Number(cfg.per_entity_limit ?? 8),
        ],
      );
      for (const row of rows) seen.set(row.id, row);
    }
    return [...seen.values()];
  }

  private fetchDefaultRecent(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    const limit =
      cfg.limit_from_context === "recent_session_limit"
        ? Number(ctx.recentSessionLimit ?? 8)
        : Number(cfg.limit ?? 8);
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' ${this.visibilityClause(String(cfg.visibility), ctx)} AND ((scope = 'session') OR (scope = 'chat' AND scope_key = ?)) ORDER BY updated_at DESC, importance DESC LIMIT ?`,
      [ctx.chatId ?? null, limit],
    );
  }

  private fetchGroupRecent(
    ctx: RecallSessionContext,
    cfg: RecallStrategyConfig,
  ): RecallMemoryRow[] {
    return this.store.fetchAll(
      `SELECT * FROM memories WHERE status = 'active' AND sensitivity = 'normal' AND scope = 'chat' AND scope_key = ? ORDER BY updated_at DESC, importance DESC LIMIT ?`,
      [ctx.chatId ?? null, Number(cfg.limit ?? 4)],
    );
  }

  private mergeRankedGroups(
    groups: Omit<RecallBuckets, "merged">,
    limit: number,
  ): RecallMemoryRow[] {
    const merged = new Map<string, RecallMemoryRow & { _score: number; _bucket: string }>();
    const bucketOrder = this.config.bucket_order;
    const bucketBonus = this.config.bucket_bonus;

    for (const bucket of bucketOrder) {
      for (const item of groups[bucket as keyof Omit<RecallBuckets, "merged">] ?? []) {
        const row = { ...item } as RecallMemoryRow & { _score: number; _bucket: string };
        const score =
          Number(row.importance ?? 0) + Number(bucketBonus[bucket] ?? 0) + (row.pinned ? 200 : 0);
        const existing = merged.get(row.id);
        if (!existing || score > existing._score) {
          row._score = score;
          row._bucket = bucket;
          merged.set(row.id, row);
        }
      }
    }

    return [...merged.values()]
      .sort(
        (a, b) => b._score - a._score || String(b.updated_at).localeCompare(String(a.updated_at)),
      )
      .slice(0, limit);
  }

  private logRecallEvents(rows: RecallMemoryRow[], sessionId: string): void {
    const ts = nowIso();
    for (const row of rows) {
      this.store.logRecallEvent({
        id: `evt_${row.id}_recalled_${slugify(sessionId)}_${sha256Text(`${row.id}|${ts}`).slice(0, 8)}`,
        memoryId: row.id,
        createdAt: ts,
        sessionId,
        detailsJson: JSON.stringify({
          bucket: (row as Record<string, unknown>)._bucket,
          score: (row as Record<string, unknown>)._score,
        }),
      });
    }
  }
}
