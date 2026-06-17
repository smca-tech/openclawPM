export interface ImportedSessionRun {
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

export interface ImportedMemoryRecord {
  id: string;
  created_at: string;
  updated_at: string;
  kind: string;
  status: string;
  scope: string;
  scope_key: string | null;
  visibility: string;
  sensitivity: string;
  title: string | null;
  content: string;
  content_format: string;
  summary: string | null;
  importance: number;
  confidence: number;
  pinned: number;
  durable: number;
  source_type: string;
  source_ref: string;
  source_excerpt: string | null;
  author_type: string;
  author_id: string | null;
  session_id: string | null;
  parent_memory_id: string | null;
  checksum: string;
  metadata_json: string | null;
  tags: string[];
  mentions: Array<[string, string, string | null]>;
}

export interface ImportedMemoryLink {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation: string;
  weight: number;
  created_at: string;
  metadata_json: string | null;
}

export interface MarkdownImportResult {
  sessions: ImportedSessionRun[];
  records: ImportedMemoryRecord[];
  links: ImportedMemoryLink[];
  summary: {
    recordsTotal: number;
    sectionRecords: number;
    atomicRecords: number;
    dailyRecords: number;
    sessions: number;
    links: number;
  };
}
