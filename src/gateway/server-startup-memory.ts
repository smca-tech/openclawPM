import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";

export function shouldRunQmdStartupBootSync(qmd: ResolvedQmdConfig): boolean {
  return qmd.update.onBoot && qmd.update.startup !== "off";
}

export async function runQmdGatewayStartupBootSyncForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  getManager: typeof getActiveMemorySearchManager;
  log: { warn: (msg: string) => void };
}): Promise<boolean> {
  const { manager, error } = await params.getManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: "cli",
  });
  if (!manager) {
    params.log.warn(
      `qmd memory startup initialization failed for agent "${params.agentId}": ${error ?? "unknown error"}`,
    );
    return false;
  }
  try {
    await manager.sync?.({ reason: "boot", force: true });
    return true;
  } catch (err) {
    params.log.warn(
      `qmd memory startup boot sync failed for agent "${params.agentId}": ${String(err)}`,
    );
    return false;
  } finally {
    await manager.close?.().catch((err) => {
      params.log.warn(
        `qmd memory startup manager close failed for agent "${params.agentId}": ${String(err)}`,
      );
    });
  }
}

export function shouldRunBuiltinStartupWarm(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentCount: number;
}): boolean {
  if (!resolveMemorySearchConfig(params.cfg, params.agentId)) {
    return false;
  }
  return shouldEagerlyStartAgentMemory(params);
}

export async function warmBuiltinGatewayMemoryForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  getManager: typeof getActiveMemorySearchManager;
  log: { warn: (msg: string) => void };
}): Promise<boolean> {
  const { manager, error } = await params.getManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: "cli",
  });
  if (!manager) {
    params.log.warn(
      `builtin memory startup warm failed for agent "${params.agentId}": ${error ?? "unknown error"}`,
    );
    return false;
  }
  try {
    await manager.warmSession?.(`gateway-startup:${params.agentId}`);
    return true;
  } catch (err) {
    params.log.warn(
      `builtin memory startup warm failed for agent "${params.agentId}": ${String(err)}`,
    );
    return false;
  } finally {
    await manager.close?.().catch((err) => {
      params.log.warn(
        `builtin memory startup manager close failed for agent "${params.agentId}": ${String(err)}`,
      );
    });
  }
}

function hasExplicitAgentMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  return listAgentEntries(cfg).some(
    (entry) => normalizeAgentId(entry.id) === agentId && entry.memorySearch != null,
  );
}

function shouldEagerlyStartAgentMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentCount: number;
}): boolean {
  if (params.agentCount <= 1) {
    return true;
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    return true;
  }
  if (params.cfg.agents?.defaults?.memorySearch?.enabled === true) {
    return true;
  }
  return hasExplicitAgentMemorySearchConfig(params.cfg, params.agentId);
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const qmdArmedAgentIds: string[] = [];
  const qmdDeferredAgentIds: string[] = [];
  const builtinWarmedAgentIds: string[] = [];

  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }

    const eagerParams = {
      cfg: params.cfg,
      agentId,
      agentCount: agentIds.length,
    };

    if (resolved.backend === "builtin") {
      if (!shouldRunBuiltinStartupWarm(eagerParams)) {
        continue;
      }
      if (
        await warmBuiltinGatewayMemoryForAgent({
          cfg: params.cfg,
          agentId,
          getManager: getActiveMemorySearchManager,
          log: params.log,
        })
      ) {
        builtinWarmedAgentIds.push(agentId);
      }
      continue;
    }

    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }
    if (!shouldRunQmdStartupBootSync(resolved.qmd)) {
      continue;
    }
    if (!shouldEagerlyStartAgentMemory(eagerParams)) {
      qmdDeferredAgentIds.push(agentId);
      continue;
    }

    if (
      await runQmdGatewayStartupBootSyncForAgent({
        cfg: params.cfg,
        agentId,
        getManager: getActiveMemorySearchManager,
        log: params.log,
      })
    ) {
      qmdArmedAgentIds.push(agentId);
    }
  }
  if (qmdArmedAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup boot sync completed for ${formatAgentCount(qmdArmedAgentIds.length)}: ${qmdArmedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (qmdDeferredAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup initialization deferred for ${formatAgentCount(qmdDeferredAgentIds.length)}: ${qmdDeferredAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (builtinWarmedAgentIds.length > 0) {
    params.log.info?.(
      `builtin memory startup warm completed for ${formatAgentCount(builtinWarmedAgentIds.length)}: ${builtinWarmedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

function formatAgentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
