export type MemoryScope = "global" | "user" | "session" | "project" | "chat" | "agent";

export type MemoryKind =
  | "fact"
  | "preference"
  | "person"
  | "project"
  | "decision"
  | "instruction"
  | "todo"
  | "summary"
  | "note"
  | "credential_ref";

export type MemoryStatus = "active" | "archived" | "deleted" | "superseded" | "tentative";

export type MemoryVisibility = "private" | "shared" | "public-within-system";

export type MemorySensitivity = "normal" | "sensitive" | "secret";

export interface MemoryRow {
  id: string;
  created_at: string;
  updated_at: string;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: MemoryScope;
  scope_key: string | null;
  visibility: MemoryVisibility;
  sensitivity: MemorySensitivity;
  title: string | null;
  content: string;
  content_format: string;
  summary: string | null;
  importance: number;
  confidence: number;
  pinned: number;
  durable: number;
  source_type: string | null;
  source_ref: string | null;
  source_excerpt: string | null;
  author_type: string;
  author_id: string | null;
  session_id: string | null;
  parent_memory_id: string | null;
  checksum: string | null;
  metadata_json: string | null;
}

export interface MemoryTagRow {
  memory_id: string;
  tag: string;
}

export interface MemoryMentionRow {
  memory_id: string;
  entity_type: string;
  entity_key: string;
  role: string | null;
}

export interface SessionRunRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  agent: string | null;
  model: string | null;
  chat_id: string | null;
  chat_type: string | null;
  user_id: string | null;
  channel: string | null;
  title: string | null;
  cwd: string | null;
  metadata_json: string | null;
}

export interface MemoryMetadata {
  revision?: number;
  [key: string]: unknown;
}

export interface MemoryVersionView {
  memoryId: string;
  version: number;
}

export interface MemoryReadForUpdate extends MemoryRow {
  metadata: MemoryMetadata;
  version: number;
  tags: string[];
  mentions: Array<{
    entity_type: string;
    entity_key: string;
    role: string | null;
  }>;
}

export interface MemorySearchRecord extends MemoryRow {
  metadata: MemoryMetadata;
  tags: string[];
  mentions: Array<{
    entity_type: string;
    entity_key: string;
    role: string | null;
  }>;
  match_score: number;
}

export interface RememberMemoryInput {
  content: string;
  title?: string | null;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeKey?: string | null;
  sessionId?: string | null;
  sourceType?: string;
  sourceRef?: string | null;
  tags?: string[];
  mentions?: Array<[string, string, string | null]>;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  durable?: boolean;
  sensitivity?: MemorySensitivity;
  authorType?: string;
  authorId?: string | null;
  parentMemoryId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  expectedVersion: number;
  title?: string | null;
  content?: string | null;
  summary?: string | null;
  tags?: string[];
  mentions?: Array<[string, string, string | null]>;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  durable?: boolean;
  sensitivity?: MemorySensitivity;
  status?: MemoryStatus;
  metadata?: Record<string, unknown>;
  authorType?: string;
  authorId?: string | null;
  sessionId?: string | null;
}
