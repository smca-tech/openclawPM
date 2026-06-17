import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  shouldWarmEmbeddedSessionMemory,
  warmEmbeddedSessionMemoryForRun,
} from "./attempt-memory-startup.js";

function createConfig(): OpenClawConfig {
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

describe("embedded session memory startup helper", () => {
  it("enables startup warming when onSessionStart is enabled", () => {
    expect(
      shouldWarmEmbeddedSessionMemory({
        config: createConfig(),
        agentId: "main",
      }),
    ).toBe(true);
  });

  it("warms session memory through the active manager surface", async () => {
    const config = createConfig();
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
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await expect(
      warmEmbeddedSessionMemoryForRun({
        config,
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:8241756142",
        getManager: getManager as never,
        log: logger,
      }),
    ).resolves.toBe(true);

    expect(getManager).toHaveBeenCalledWith({
      cfg: config,
      agentId: "main",
      purpose: "cli",
    });
    expect(warmSession).toHaveBeenCalledWith("agent:main:telegram:direct:8241756142");
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false quietly when startup warming is disabled", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await expect(
      warmEmbeddedSessionMemoryForRun({
        config: undefined,
        agentId: "main",
        sessionKey: "session-key",
        log: logger,
      }),
    ).resolves.toBe(false);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
