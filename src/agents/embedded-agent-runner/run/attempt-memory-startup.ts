import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getActiveMemorySearchManager } from "../../../plugins/memory-runtime.js";
import { resolveMemorySearchConfig } from "../../memory-search.js";

export function shouldWarmEmbeddedSessionMemory(params: {
  config?: OpenClawConfig;
  agentId: string;
}): boolean {
  if (!params.config) {
    return false;
  }
  const resolved = resolveMemorySearchConfig(params.config, params.agentId);
  return Boolean(resolved?.sync.onSessionStart);
}

export async function warmEmbeddedSessionMemoryForRun(params: {
  config?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  getManager?: typeof getActiveMemorySearchManager;
  log?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<boolean> {
  if (
    !params.config ||
    !shouldWarmEmbeddedSessionMemory({ config: params.config, agentId: params.agentId })
  ) {
    return false;
  }

  const getManager = params.getManager ?? getActiveMemorySearchManager;
  try {
    const { manager, error } = await getManager({
      cfg: params.config,
      agentId: params.agentId,
      purpose: "cli",
    });
    if (!manager) {
      params.log?.debug?.(
        `embedded memory startup warm skipped for agent "${params.agentId}": ${error ?? "no manager"}`,
      );
      return false;
    }
    try {
      await manager.warmSession?.(params.sessionKey);
      return true;
    } finally {
      await manager.close?.().catch((err) => {
        params.log?.warn?.(
          `embedded memory startup manager close failed for agent "${params.agentId}": ${formatErrorMessage(err)}`,
        );
      });
    }
  } catch (err) {
    params.log?.warn?.(
      `embedded memory startup warm failed for agent "${params.agentId}": ${formatErrorMessage(err)}`,
    );
    return false;
  }
}
