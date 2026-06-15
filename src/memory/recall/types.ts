export interface RecallSessionContext {
  sessionId: string;
  chatId?: string | null;
  chatType?: string | null;
  userId?: string | null;
  userKey?: string | null;
  projectKey?: string | null;
  agentKey?: string | null;
  mentionedEntities?: Array<[string, string]>;
  includeSecret?: boolean;
  maxMemories?: number;
  recentSessionLimit?: number;
  preset?: string;
}

export interface RecallMemoryRow {
  id: string;
  kind: string;
  scope: string;
  scope_key: string | null;
  sensitivity: string;
  importance: number;
  pinned: number;
  updated_at: string;
  title: string | null;
  [key: string]: unknown;
}

export interface RecallBuckets {
  pinned: RecallMemoryRow[];
  scoped: RecallMemoryRow[];
  entity: RecallMemoryRow[];
  recent: RecallMemoryRow[];
  merged: RecallMemoryRow[];
}

export interface RecallStore {
  fetchAll(sql: string, params?: unknown[]): RecallMemoryRow[];
  logRecallEvent(input: {
    id: string;
    memoryId: string;
    createdAt: string;
    sessionId: string;
    detailsJson: string;
  }): void;
}
