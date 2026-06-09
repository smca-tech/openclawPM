import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedQmdConfig } from "../memory-host-sdk/host/backend-config.js";
import {
  runQmdGatewayStartupBootSyncForAgent,
  shouldRunQmdStartupBootSync,
} from "./server-startup-memory.js";

function createQmdCfg(): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", default: true }] },
    memory: { backend: "qmd", qmd: { update: { startup: "immediate" } } },
  } as OpenClawConfig;
}

function createResolvedQmdConfig(overrides?: Partial<ResolvedQmdConfig>): ResolvedQmdConfig {
  return {
    command: "qmd",
    mcporter: { enabled: false, serverName: "qmd", startDaemon: true },
    searchMode: "search",
    collections: [],
    sessions: { enabled: false },
    update: {
      intervalMs: 300000,
      debounceMs: 15000,
      onBoot: true,
      startup: "immediate",
      startupDelayMs: 120000,
      waitForBootSync: false,
      embedIntervalMs: 3600000,
      commandTimeoutMs: 30000,
      updateTimeoutMs: 120000,
      embedTimeoutMs: 120000,
    },
    limits: {
      maxResults: 4,
      maxSnippetChars: 450,
      maxInjectedChars: 2200,
      timeoutMs: 4000,
    },
    includeDefaultMemory: true,
    ...overrides,
  };
}

describe("qmd gateway startup helper", () => {
  it("enables qmd startup sync when boot sync is configured", () => {
    expect(shouldRunQmdStartupBootSync(createResolvedQmdConfig())).toBe(true);
    expect(
      shouldRunQmdStartupBootSync(
        createResolvedQmdConfig({
          update: { ...createResolvedQmdConfig().update, onBoot: false },
        }),
      ),
    ).toBe(false);
  });

  it("runs boot sync and closes the qmd startup manager", async () => {
    const cfg = createQmdCfg();
    const sync = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const getManager = vi.fn(async () => ({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn(() => ({ backend: "qmd", provider: "qmd" })),
        sync,
        probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
        probeVectorAvailability: vi.fn(async () => true),
        close,
      },
    }));
    const log = { warn: vi.fn() };

    await expect(
      runQmdGatewayStartupBootSyncForAgent({
        cfg,
        agentId: "main",
        getManager: getManager as never,
        log,
      }),
    ).resolves.toBe(true);

    expect(getManager).toHaveBeenCalledWith({ cfg, agentId: "main", purpose: "cli" });
    expect(sync).toHaveBeenCalledWith({ reason: "boot", force: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and returns false when qmd manager acquisition fails", async () => {
    const cfg = createQmdCfg();
    const getManager = vi.fn(async () => ({ manager: null, error: "qmd missing" }));
    const log = { warn: vi.fn() };

    await expect(
      runQmdGatewayStartupBootSyncForAgent({
        cfg,
        agentId: "main",
        getManager: getManager as never,
        log,
      }),
    ).resolves.toBe(false);

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
  });
});
