import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it } from "vitest";
import { resetMemoryToolMockState, setMemorySearchImpl } from "./memory-tool-manager-mock.js";
import { buildPromptSection } from "./prompt-section.js";

function createBuiltinCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          store: { path: "/tmp/index.sqlite", vector: { enabled: false } },
          sync: { watch: false, onSessionStart: true, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          sources: ["memory"],
          experimental: { sessionMemory: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
    memory: { backend: "builtin" },
  } as OpenClawConfig;
}

describe("memory-core prompt section", () => {
  it("returns no section when no memory tools are available", async () => {
    await expect(buildPromptSection({ availableTools: new Set() })).resolves.toEqual([]);
  });

  it("includes active runtime context for the current agent/session when config is available", async () => {
    resetMemoryToolMockState();
    const lines = await buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      cfg: createBuiltinCfg(),
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:8241756142",
    });

    expect(lines).toContain("## Memory Recall");
    expect(lines).toContain(
      "Active backend: builtin | agent: main | session: agent:main:telegram:direct:8241756142",
    );
  });

  it("injects a small prompt-time recall summary when indexed memory hits are available", async () => {
    resetMemoryToolMockState();
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-06-08.md",
        snippet:
          "Continued TS memory subsystem wiring and noted that prompt-time recall content still needs to be injected.",
        source: "memory",
        startLine: 1,
        endLine: 2,
        score: 0.91,
      },
    ]);

    const lines = await buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      cfg: createBuiltinCfg(),
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:8241756142",
    });

    expect(lines).toContain("Recent indexed memory hints:");
    expect(lines).toContain(
      "- memory/2026-06-08.md#L1-L2: Continued TS memory subsystem wiring and noted that prompt-time recall content still needs to be injected.",
    );
  });
});
