import type {
  MemoryPromptSectionBuilder,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { getMemorySearchManager } from "./memory/index.js";

const PROMPT_RECALL_QUERY = "recent work decisions preferences todos";
const PROMPT_RECALL_MAX_RESULTS = 3;
const PROMPT_RECALL_MAX_SNIPPET_CHARS = 160;

type PromptParams = Parameters<MemoryPromptSectionBuilder>[0];

type PromptRecallResult = {
  path: string;
  snippet: string;
  score?: number;
  source?: string;
  startLine?: number;
  endLine?: number;
};

function buildRuntimeContextLine(params: PromptParams): string | null {
  if (!params.cfg || !params.agentId) {
    return null;
  }
  const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId: params.agentId });
  if (!resolved) {
    return null;
  }

  const parts = [`Active backend: ${resolved.backend}`];
  if (params.agentId) {
    parts.push(`agent: ${params.agentId}`);
  }
  if (params.sessionKey) {
    parts.push(`session: ${params.sessionKey}`);
  }
  if (resolved.backend === "qmd" && resolved.qmd) {
    parts.push(`qmd mode: ${resolved.qmd.searchMode}`);
  }
  return parts.join(" | ");
}

function canBuildPromptRecall(params: PromptParams): params is PromptParams & {
  cfg: OpenClawConfig;
  agentId: string;
} {
  return Boolean(params.cfg && params.agentId && params.availableTools.has("memory_search"));
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimSnippet(value: string, maxChars = PROMPT_RECALL_MAX_SNIPPET_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildPromptRecallLine(result: PromptRecallResult): string {
  const location =
    typeof result.startLine === "number"
      ? `#L${result.startLine}${
          typeof result.endLine === "number" && result.endLine !== result.startLine
            ? `-L${result.endLine}`
            : ""
        }`
      : "";
  const sourceLabel = result.source && result.source !== "memory" ? ` [${result.source}]` : "";
  return `- ${result.path}${location}${sourceLabel}: ${trimSnippet(normalizeSnippet(result.snippet))}`;
}

async function buildPromptRecallSummary(params: PromptParams): Promise<string[]> {
  if (!canBuildPromptRecall(params)) {
    return [];
  }

  try {
    const { manager } = await getMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
      purpose: "status",
    });
    if (!manager) {
      return [];
    }
    const results = (await manager.search(PROMPT_RECALL_QUERY, {
      maxResults: PROMPT_RECALL_MAX_RESULTS,
      sessionKey: params.sessionKey,
      sources: ["memory", "sessions"],
    })) as PromptRecallResult[];
    if (results.length === 0) {
      return [];
    }
    return ["Recent indexed memory hints:", ...results.map(buildPromptRecallLine)];
  } catch {
    return [];
  }
}

export const buildPromptSection: MemoryPromptSectionBuilder = async (params) => {
  const hasMemorySearch = params.availableTools.has("memory_search");
  const hasMemoryGet = params.availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts and answer from the matching results. If low confidence after search, say you checked.";
  } else {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
  }

  const lines = ["## Memory Recall", toolGuidance];
  const runtimeContext = buildRuntimeContextLine(params);
  if (runtimeContext) {
    lines.push(runtimeContext);
  }
  const promptRecallLines = await buildPromptRecallSummary(params);
  if (promptRecallLines.length > 0) {
    lines.push(...promptRecallLines);
  }
  if (params.citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
