import type { MemoryMetadata } from "../types.js";

export const DEFAULT_MEMORY_VERSION_FIELD = "revision";

export function getMemoryVersionFromMetadata(
  metadata: MemoryMetadata | null | undefined,
  versionField = DEFAULT_MEMORY_VERSION_FIELD,
): number {
  const value = metadata?.[versionField];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function incrementMemoryVersion(
  metadata: MemoryMetadata | null | undefined,
  versionField = DEFAULT_MEMORY_VERSION_FIELD,
): MemoryMetadata {
  const next = { ...(metadata ?? {}) };
  next[versionField] = getMemoryVersionFromMetadata(metadata, versionField) + 1;
  return next;
}
