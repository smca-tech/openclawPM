import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  shouldRunBuiltinStartupWarm,
  warmBuiltinGatewayMemoryForAgent,
} from "./server-startup-memory.js";

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

describe("builtin gateway startup memory helper", () => {
  it("allows eager builtin startup warming when memory search is configured", () => {
    const cfg = createBuiltinCfg();

    expect(
      shouldRunBuiltinStartupWarm({
        cfg,
        agentId: "main",
        agentCount: 1,
      }),
    ).toBe(true);
  });

  it("warms and closes the builtin startup manager", async () => {
    const cfg = createBuiltinCfg();
    const warmSession = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const getManager = vi.fn(async () => ({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn(() => ({ backend: "builtin", provider: "openai" })),
        warmSession,
        probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
        probeVectorAvailability: vi.fn(async () => true),
        close,
      },
    }));
    const log = { warn: vi.fn() };

    await expect(
      warmBuiltinGatewayMemoryForAgent({
        cfg,
        agentId: "main",
        getManager: getManager as never,
        log,
      }),
    ).resolves.toBe(true);

    expect(getManager).toHaveBeenCalledWith({ cfg, agentId: "main", purpose: "cli" });
    expect(warmSession).toHaveBeenCalledWith("gateway-startup:main");
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and returns false when builtin manager acquisition fails", async () => {
    const cfg = createBuiltinCfg();
    const getManager = vi.fn(async () => ({ manager: null, error: "no index" }));
    const log = { warn: vi.fn() };

    await expect(
      warmBuiltinGatewayMemoryForAgent({
        cfg,
        agentId: "main",
        getManager: getManager as never,
        log,
      }),
    ).resolves.toBe(false);

    expect(log.warn).toHaveBeenCalledWith(
      'builtin memory startup warm failed for agent "main": no index',
    );
  });
});
