import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryQmdUpdateConfig } from "../config/types.memory.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createQmdConfig(
  agents: OpenClawConfig["agents"],
  update: MemoryQmdUpdateConfig = { startup: "immediate" },
): OpenClawConfig {
  return {
    agents,
    memory: { backend: "qmd", qmd: { update } },
  } as OpenClawConfig;
}

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createQmdManagerMock() {
  return {
    search: vi.fn(),
    sync: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function createBuiltinManagerMock() {
  return {
    search: vi.fn(),
    warmSession: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps qmd managers lazy when startup refresh is not opted in", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;
    const log = createGatewayLogMock();

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("runs qmd boot sync for the default and explicitly configured agents", async () => {
    const cfg = createQmdConfig({
      list: [
        { id: "ops", default: true },
        { id: "main", memorySearch: { enabled: true } },
        { id: "lazy" },
      ],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, {
      cfg,
      agentId: "ops",
      purpose: "cli",
    });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, {
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup boot sync completed for 2 agents: "ops", "main"',
    );
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization deferred for 1 agent: "lazy"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes all qmd agents when memory search is explicitly enabled in defaults", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "ops", default: true }, { id: "main" }],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, {
      cfg,
      agentId: "ops",
      purpose: "cli",
    });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, {
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup boot sync completed for 2 agents: "ops", "main"',
    );
    expect(log.info.mock.calls.some(([message]) => String(message).includes("deferred"))).toBe(
      false,
    );
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = createQmdConfig({
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: true } },
      ],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup boot sync completed for 1 agent: "ops"',
    );
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: false } },
      ],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup boot sync completed for 1 agent: "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not initialize qmd managers when background work is disabled", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "qmd",
        qmd: {
          update: { startup: "immediate", onBoot: false, interval: "0s", embedInterval: "0s" },
        },
      },
    } as OpenClawConfig;
    const log = createGatewayLogMock();

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warms builtin memory on gateway startup for eagerly started agents", async () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
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
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = createGatewayLogMock();
    const manager = createBuiltinManagerMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    expect(manager.warmSession).toHaveBeenCalledWith("gateway-startup:main");
    expect(manager.close).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'builtin memory startup warm completed for 1 agent: "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns when builtin startup warming cannot acquire a manager", async () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
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
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: null, error: "no index" });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'builtin memory startup warm failed for agent "main": no index',
    );
  });
});
