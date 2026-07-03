import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { Type } from "typebox";
import { loadWriteHeuristicsConfig } from "../../../src/memory/config/loaders.js";
import { SqliteMemoryWriterStore } from "../../../src/memory/store/sqlite-memory-writer-store.js";
import {
  type MemorySensitivity,
  type MemoryScope,
  type MemoryKind,
  type MemoryStatus,
} from "../../../src/memory/types.js";
import { computeMemoryChecksum, MemoryWriter } from "../../../src/memory/write/memory-writer.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;

const MementoWriteSchema = Type.Object({
  content: Type.String(),
  title: Type.Optional(Type.String()),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("fact"),
      Type.Literal("preference"),
      Type.Literal("person"),
      Type.Literal("project"),
      Type.Literal("decision"),
      Type.Literal("instruction"),
      Type.Literal("todo"),
      Type.Literal("summary"),
      Type.Literal("note"),
      Type.Literal("credential_ref"),
    ]),
  ),
  scope: Type.Optional(
    Type.Union([
      Type.Literal("global"),
      Type.Literal("user"),
      Type.Literal("session"),
      Type.Literal("project"),
      Type.Literal("chat"),
      Type.Literal("agent"),
    ]),
  ),
  scopeKey: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  sourceType: Type.Optional(Type.String()),
  sourceRef: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  importance: Type.Optional(Type.Number()),
  confidence: Type.Optional(Type.Number()),
  pinned: Type.Optional(Type.Boolean()),
  durable: Type.Optional(Type.Boolean()),
  sensitivity: Type.Optional(
    Type.Union([Type.Literal("normal"), Type.Literal("sensitive"), Type.Literal("secret")]),
  ),
  authorType: Type.Optional(Type.String()),
  authorId: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const MementoSearchSchema = Type.Object({
  query: Type.Optional(Type.String()),
  maxResults: Type.Optional(Type.Number()),
  scope: Type.Optional(
    Type.Union([
      Type.Literal("global"),
      Type.Literal("user"),
      Type.Literal("session"),
      Type.Literal("project"),
      Type.Literal("chat"),
      Type.Literal("agent"),
    ]),
  ),
  scopeKey: Type.Optional(Type.String()),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("fact"),
      Type.Literal("preference"),
      Type.Literal("person"),
      Type.Literal("project"),
      Type.Literal("decision"),
      Type.Literal("instruction"),
      Type.Literal("todo"),
      Type.Literal("summary"),
      Type.Literal("note"),
      Type.Literal("credential_ref"),
    ]),
  ),
  status: Type.Optional(
    Type.Union([
      Type.Literal("active"),
      Type.Literal("archived"),
      Type.Literal("deleted"),
      Type.Literal("superseded"),
      Type.Literal("tentative"),
    ]),
  ),
  sensitivity: Type.Optional(
    Type.Union([Type.Literal("normal"), Type.Literal("sensitive"), Type.Literal("secret")]),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
  pinned: Type.Optional(Type.Boolean()),
  durable: Type.Optional(Type.Boolean()),
});

type LoadedWriteConfig = Awaited<ReturnType<typeof loadWriteHeuristicsConfig>>;
let loadedWriteConfigPromise: Promise<LoadedWriteConfig> | null = null;

function loadMementoWriteConfig(): Promise<LoadedWriteConfig> {
  loadedWriteConfigPromise ??= loadWriteHeuristicsConfig();
  return loadedWriteConfigPromise;
}

function resolveMementoWriteScopeKey(params: {
  requestedScope: MemoryScope;
  rawScopeKey?: string;
  agentSessionKey?: string;
  agentId: string;
}): string | null {
  const explicit = params.rawScopeKey?.trim();
  if (explicit) {
    return explicit;
  }
  switch (params.requestedScope) {
    case "session":
      return params.agentSessionKey?.trim() || null;
    case "agent":
      return params.agentId;
    default:
      return null;
  }
}

function resolveMementoDbPath(status: unknown): string {
  const dbPath =
    typeof status === "object" && status && "dbPath" in status && typeof status.dbPath === "string"
      ? status.dbPath
      : "";
  const trimmed = dbPath.trim();
  if (!trimmed) {
    throw new Error("memory database path unavailable");
  }
  if (trimmed === "~") {
    return path.join(process.env.HOME ?? process.cwd());
  }
  if (trimmed.startsWith("~/")) {
    return path.join(process.env.HOME ?? process.cwd(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function createMemoryWriterConfig(raw: LoadedWriteConfig) {
  return {
    remember: {
      idPrefix: raw.remember.id_prefix,
      idHashLength: raw.remember.id_hash_length,
      summaryMaxChars: raw.remember.summary_max_chars,
      checksumFields: raw.remember.checksum_fields as Array<
        "kind" | "scope" | "scope_key" | "title" | "content"
      >,
      defaultVisibility: raw.remember.default_visibility,
      contentFormat: raw.remember.content_format,
      eventType: raw.remember.event_type,
      eventActorId: raw.remember.event_actor_id,
    },
    update: {
      versionField: raw.update.version_field,
      mergeTags: raw.update.merge_tags,
      mergeMentions: raw.update.merge_mentions,
      recomputeChecksum: raw.update.recompute_checksum,
      requireVersionMatch: raw.update.require_version_match,
      eventType: raw.update.event_type,
      eventActorId: raw.update.event_actor_id,
    },
    supersede: {
      status: raw.supersede.status,
      linkRelation: raw.supersede.link_relation,
      linkWeight: raw.supersede.link_weight,
      metadataCreatedBy: raw.supersede.metadata_created_by,
    },
  };
}

function sortMemorySearchToolResults<T extends { score: number; path: string }>(results: T[]): T[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = sortMemorySearchToolResults(params.memoryResults);
  const supplementResults = sortMemorySearchToolResults(params.supplementResults);
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return sortMemorySearchToolResults([...memoryResults, ...supplementResults]).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selectedSupplements = supplementResults.slice(0, perCorpusCap);
  const selected = [...selectedMemory, ...selectedSupplements];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortMemorySearchToolResults([
        ...memoryResults.slice(selectedMemory.length),
        ...supplementResults.slice(selectedSupplements.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortMemorySearchToolResults(selected).slice(0, params.maxResults);
}

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {
    // Recall tracking is best-effort and must never block memory recall.
  });
}

function normalizeActiveMemoryQmdSearchMode(
  value: unknown,
): "inherit" | "search" | "vsearch" | "query" {
  return value === "inherit" || value === "search" || value === "vsearch" || value === "query"
    ? value
    : "search";
}

function isActiveMemorySessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":active-memory:");
}

function resolveActiveMemoryQmdSearchModeOverride(
  cfg: OpenClawConfig,
  sessionKey?: string,
): "search" | "vsearch" | "query" | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const entry = cfg.plugins?.entries?.["active-memory"];
  const entryRecord =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { config?: unknown })
      : undefined;
  const pluginConfig =
    entryRecord?.config &&
    typeof entryRecord.config === "object" &&
    !Array.isArray(entryRecord.config)
      ? (entryRecord.config as { qmd?: { searchMode?: unknown } })
      : undefined;
  const searchMode = normalizeActiveMemoryQmdSearchMode(pluginConfig?.qmd?.searchMode);
  return searchMode === "inherit" ? undefined : searchMode;
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentSessionKey: params.agentSessionKey,
    corpus: params.corpus,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

async function resolveMemoryReadFailureResult(params: {
  error: unknown;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  if (params.requestedCorpus === "all") {
    const supplement = await getSupplementMemoryReadResult({
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
      corpus: params.requestedCorpus,
    });
    if (supplement) {
      return jsonResult(supplement);
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ path: params.relPath, text: "", disabled: true, error: message });
}

async function executeMemoryReadResult<T>(params: {
  read: () => Promise<T>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  try {
    return jsonResult(await params.read());
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      error,
      requestedCorpus: params.requestedCorpus,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const query = readStringParam(rawParams, "query", { required: true });
        const maxResults = readNumberParam(rawParams, "maxResults");
        const minScore = readNumberParam(rawParams, "minScore");
        const requestedCorpus = readStringParam(rawParams, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | "sessions"
          | undefined;
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const shouldQueryMemory = requestedCorpus !== "wiki";
        const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
        const memory = shouldQueryMemory ? await getMemoryManagerContext({ cfg, agentId }) : null;
        if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const searchStartedAt = Date.now();
          let rawResults: MemorySearchResult[] = [];
          let surfacedMemoryResults: Array<MemorySearchResult & { corpus: MemorySource }> = [];
          let provider: string | undefined;
          let model: string | undefined;
          let fallback: unknown;
          let searchMode: string | undefined;
          let searchDebug:
            | {
                backend: string;
                configuredMode?: string;
                effectiveMode?: string;
                fallback?: string;
                searchMs: number;
                hits: number;
              }
            | undefined;
          if (shouldQueryMemory && memory && !("error" in memory)) {
            const runtimeDebug: MemorySearchRuntimeDebug[] = [];
            const qmdSearchModeOverride = resolveActiveMemoryQmdSearchModeOverride(
              cfg,
              options.agentSessionKey,
            );
            const searchSources: MemorySource[] | undefined =
              requestedCorpus === "sessions"
                ? (["sessions"] as MemorySource[])
                : requestedCorpus === "memory"
                  ? (["memory"] as MemorySource[])
                  : undefined;
            rawResults = await memory.manager.search(query, {
              maxResults,
              minScore,
              sessionKey: options.agentSessionKey,
              qmdSearchModeOverride,
              onDebug: (debug) => {
                runtimeDebug.push(debug);
              },
              ...(searchSources ? { sources: searchSources } : {}),
            });
            rawResults = await filterMemorySearchHitsBySessionVisibility({
              cfg,
              agentId,
              requesterSessionKey: options.agentSessionKey,
              sandboxed: options.sandboxed === true,
              hits: rawResults,
            });
            if (requestedCorpus === "sessions") {
              rawResults = rawResults.filter((hit) => hit.source === "sessions");
            } else if (requestedCorpus === "memory") {
              rawResults = rawResults.filter((hit) => hit.source === "memory");
            }
            const status = memory.manager.status();
            const decorated = decorateCitations(rawResults, includeCitations);
            const resolved = resolveMemoryBackendConfig({ cfg, agentId });
            const memoryResults =
              status.backend === "qmd"
                ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
                : decorated;
            surfacedMemoryResults = memoryResults.map((result) => ({
              ...result,
              corpus: result.source,
            }));
            const sleepTimezone = resolveMemoryDeepDreamingConfig({
              pluginConfig: resolveMemoryCorePluginConfig(cfg),
              cfg,
            }).timezone;
            queueShortTermRecallTracking({
              workspaceDir: status.workspaceDir,
              query,
              rawResults,
              surfacedResults: memoryResults,
              timezone: sleepTimezone,
            });
            provider = status.provider;
            model = status.model;
            fallback = status.fallback;
            const latestDebug = runtimeDebug.at(-1);
            searchMode = latestDebug?.effectiveMode;
            searchDebug = {
              backend: status.backend,
              configuredMode: latestDebug?.configuredMode,
              effectiveMode:
                status.backend === "qmd"
                  ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
                  : "n/a",
              fallback: latestDebug?.fallback,
              searchMs: Math.max(0, Date.now() - searchStartedAt),
              hits: rawResults.length,
            };
          }
          const supplementResults = shouldQuerySupplements
            ? await searchMemoryCorpusSupplements({
                query,
                maxResults,
                agentSessionKey: options.agentSessionKey,
                corpus: requestedCorpus,
              })
            : [];
          // Wiki and memory scores use incomparable scales, so corpus=all first
          // balances candidate selection and then backfills any unused slots.
          const effectiveMax = Math.max(1, maxResults ?? 10);
          const results = mergeMemorySearchCorpusResults({
            memoryResults: surfacedMemoryResults,
            supplementResults,
            maxResults: effectiveMax,
            balanceCorpora: requestedCorpus === "all",
          });
          return jsonResult({
            results,
            provider,
            model,
            fallback,
            citations: citationsMode,
            mode: searchMode,
            debug: searchDebug,
          });
        } catch (err) {
          const message = formatErrorMessage(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const relPath = readStringParam(rawParams, "path", { required: true });
        const from = readNumberParam(rawParams, "from", { integer: true });
        const lines = readNumberParam(rawParams, "lines", { integer: true });
        const requestedCorpus = readStringParam(rawParams, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          const supplement = await getSupplementMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
            corpus: requestedCorpus,
          });
          return jsonResult(
            supplement ?? {
              path: relPath,
              text: "",
              disabled: true,
              error: "wiki corpus result not found",
            },
          );
        }
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          return await executeMemoryReadResult({
            read: async () =>
              await readAgentMemoryFile({
                cfg,
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            requestedCorpus,
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        return await executeMemoryReadResult({
          read: async () =>
            await memory.manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          requestedCorpus,
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
          agentSessionKey: options.agentSessionKey,
        });
      },
  });
}

export function createMementoWriteTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memento Write",
    name: "memento_write",
    description:
      "Write a structured memory record into the runtime memento store. Use when you need to persist a new fact, preference, decision, note, or todo through the live tool surface.",
    parameters: MementoWriteSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const content = readStringParam(rawParams, "content", { required: true });
        const title = readStringParam(rawParams, "title") ?? null;
        const kind = (readStringParam(rawParams, "kind") as MemoryKind | undefined) ?? "note";
        const scope = (readStringParam(rawParams, "scope") as MemoryScope | undefined) ?? "session";
        const scopeKey = resolveMementoWriteScopeKey({
          requestedScope: scope,
          rawScopeKey: readStringParam(rawParams, "scopeKey") ?? undefined,
          agentSessionKey: options.agentSessionKey,
          agentId,
        });
        const sourceType = readStringParam(rawParams, "sourceType") ?? "tool";
        const sourceRef = readStringParam(rawParams, "sourceRef") ?? null;
        const sessionId = readStringParam(rawParams, "sessionId") ?? null;
        const sensitivity =
          (readStringParam(rawParams, "sensitivity") as MemorySensitivity | undefined) ?? "normal";
        const importance = readNumberParam(rawParams, "importance");
        const confidence = readNumberParam(rawParams, "confidence");
        const tags = Array.isArray(rawParams.tags)
          ? rawParams.tags.filter((value): value is string => typeof value === "string")
          : [];
        const metadata =
          rawParams.metadata &&
          typeof rawParams.metadata === "object" &&
          !Array.isArray(rawParams.metadata)
            ? (rawParams.metadata as Record<string, unknown>)
            : undefined;

        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({
            stored: false,
            disabled: true,
            error: memory.error ?? "memory search unavailable",
          });
        }

        const writeConfig = createMemoryWriterConfig(await loadMementoWriteConfig());
        const dbPath = resolveMementoDbPath(memory.manager.status());
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const store = SqliteMemoryWriterStore.open(dbPath);
        try {
          const checksum = computeMemoryChecksum(
            {
              kind,
              scope,
              scope_key: scopeKey,
              title,
              content,
            },
            writeConfig.remember.checksumFields,
          );
          const existingId = store.findActiveMemoryIdByChecksum(checksum);
          const writer = new MemoryWriter(store, writeConfig);
          const memoryId = writer.remember({
            content,
            title,
            kind,
            scope,
            scopeKey,
            sessionId,
            sourceType,
            sourceRef,
            tags,
            importance: importance ?? undefined,
            confidence: confidence ?? undefined,
            pinned: rawParams.pinned === true,
            durable: rawParams.durable === false ? false : undefined,
            sensitivity,
            authorType: readStringParam(rawParams, "authorType") ?? "assistant",
            authorId: readStringParam(rawParams, "authorId") ?? undefined,
            metadata,
          });
          const duplicate = Boolean(existingId);
          return jsonResult({
            stored: !duplicate,
            duplicate,
            id: memoryId,
            checksum,
            scope,
            scopeKey,
            kind,
          });
        } finally {
          store.close();
        }
      },
  });
}

export function createMementoSearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memento Search",
    name: "memento_search",
    description:
      "Search structured memory records in the runtime memento store. Use this to inspect stored memory rows by query, scope, kind, tags, or status without reading raw SQLite directly.",
    parameters: MementoSearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const query = readStringParam(rawParams, "query")?.trim() ?? "";
        const maxResults = Math.max(
          1,
          Math.min(50, readNumberParam(rawParams, "maxResults", { integer: true }) ?? 10),
        );
        const scope = readStringParam(rawParams, "scope") as MemoryScope | undefined;
        const scopeKey = readStringParam(rawParams, "scopeKey") ?? undefined;
        const kind = readStringParam(rawParams, "kind") as MemoryKind | undefined;
        const status = readStringParam(rawParams, "status") as MemoryStatus | undefined;
        const sensitivity = readStringParam(rawParams, "sensitivity") as
          | MemorySensitivity
          | undefined;
        const tags = Array.isArray(rawParams.tags)
          ? rawParams.tags.filter(
              (value): value is string => typeof value === "string" && value.trim().length > 0,
            )
          : [];
        const pinned = typeof rawParams.pinned === "boolean" ? rawParams.pinned : undefined;
        const durable = typeof rawParams.durable === "boolean" ? rawParams.durable : undefined;

        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({
            results: [],
            disabled: true,
            error: memory.error ?? "memory search unavailable",
          });
        }

        const dbPath = resolveMementoDbPath(memory.manager.status());
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const store = SqliteMemoryWriterStore.open(dbPath);
        try {
          const results = store.searchMemories({
            query: query || undefined,
            maxResults,
            scope,
            scopeKey,
            kind,
            status,
            sensitivity,
            tags,
            pinned,
            durable,
          });
          return jsonResult({
            results: results.map((record) => ({
              id: record.id,
              title: record.title,
              summary: record.summary,
              kind: record.kind,
              status: record.status,
              scope: record.scope,
              scopeKey: record.scope_key,
              sensitivity: record.sensitivity,
              importance: record.importance,
              confidence: record.confidence,
              pinned: Boolean(record.pinned),
              durable: Boolean(record.durable),
              matchScore: record.match_score,
              tags: record.tags,
              mentions: record.mentions,
              sourceType: record.source_type,
              sourceRef: record.source_ref,
              sessionId: record.session_id,
              parentMemoryId: record.parent_memory_id,
              createdAt: record.created_at,
              updatedAt: record.updated_at,
            })),
            filters: {
              query: query || undefined,
              maxResults,
              scope,
              scopeKey,
              kind,
              status: status ?? "active",
              sensitivity,
              tags,
              pinned,
              durable,
            },
          });
        } finally {
          store.close();
        }
      },
  });
}
