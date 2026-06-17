export const MEMORY_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS session_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  agent TEXT,
  model TEXT,
  chat_id TEXT,
  chat_type TEXT,
  user_id TEXT,
  channel TEXT,
  title TEXT,
  cwd TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  scope TEXT NOT NULL,
  scope_key TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  title TEXT,
  content TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'markdown',
  summary TEXT,
  importance INTEGER NOT NULL DEFAULT 50,
  confidence REAL NOT NULL DEFAULT 1.0,
  freshness REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  durable INTEGER NOT NULL DEFAULT 1,
  source_type TEXT,
  source_ref TEXT,
  source_excerpt TEXT,
  author_type TEXT NOT NULL DEFAULT 'assistant',
  author_id TEXT,
  session_id TEXT,
  parent_memory_id TEXT,
  checksum TEXT,
  metadata_json TEXT,
  FOREIGN KEY (session_id) REFERENCES session_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_memory_id) REFERENCES memories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_mentions (
  memory_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  role TEXT,
  PRIMARY KEY (memory_id, entity_type, entity_key, role),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (from_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (to_memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  session_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'assistant',
  actor_id TEXT,
  details_json TEXT,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES session_runs(id) ON DELETE SET NULL
);
`;
