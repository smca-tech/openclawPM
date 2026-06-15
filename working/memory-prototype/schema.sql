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
    FOREIGN KEY (parent_memory_id) REFERENCES memories(id) ON DELETE SET NULL,

    CHECK (importance BETWEEN 0 AND 100),
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
    CHECK (pinned IN (0,1)),
    CHECK (durable IN (0,1))
);

CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag),
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

CREATE TABLE IF NOT EXISTS memory_mentions (
    memory_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    role TEXT,
    PRIMARY KEY (memory_id, entity_type, entity_key, role),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_sources (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    part_index INTEGER NOT NULL DEFAULT 0,
    content TEXT,
    metadata_json TEXT,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
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

CREATE INDEX IF NOT EXISTS idx_memories_scope
ON memories(scope, scope_key, status);

CREATE INDEX IF NOT EXISTS idx_memories_kind
ON memories(kind, status);

CREATE INDEX IF NOT EXISTS idx_memories_importance
ON memories(pinned DESC, importance DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_session
ON memories(session_id);

CREATE INDEX IF NOT EXISTS idx_memories_source
ON memories(source_type, source_ref);

CREATE INDEX IF NOT EXISTS idx_memories_checksum
ON memories(checksum);

CREATE INDEX IF NOT EXISTS idx_mentions_entity
ON memory_mentions(entity_type, entity_key);

CREATE INDEX IF NOT EXISTS idx_links_from
ON memory_links(from_memory_id, relation);

CREATE INDEX IF NOT EXISTS idx_links_to
ON memory_links(to_memory_id, relation);

CREATE INDEX IF NOT EXISTS idx_events_memory_time
ON memory_events(memory_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    memory_id UNINDEXED,
    title,
    summary,
    content,
    tags,
    tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(memory_id, title, summary, content, tags)
    VALUES (
        NEW.id,
        COALESCE(NEW.title, ''),
        COALESCE(NEW.summary, ''),
        NEW.content,
        COALESCE((SELECT group_concat(tag, ' ') FROM memory_tags WHERE memory_id = NEW.id), '')
    );
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    DELETE FROM memories_fts WHERE memory_id = OLD.id;
    INSERT INTO memories_fts(memory_id, title, summary, content, tags)
    VALUES (
        NEW.id,
        COALESCE(NEW.title, ''),
        COALESCE(NEW.summary, ''),
        NEW.content,
        COALESCE((SELECT group_concat(tag, ' ') FROM memory_tags WHERE memory_id = NEW.id), '')
    );
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE memory_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_tags_ai AFTER INSERT ON memory_tags BEGIN
    DELETE FROM memories_fts WHERE memory_id = NEW.memory_id;
    INSERT INTO memories_fts(memory_id, title, summary, content, tags)
    SELECT
        m.id,
        COALESCE(m.title, ''),
        COALESCE(m.summary, ''),
        m.content,
        COALESCE((SELECT group_concat(tag, ' ') FROM memory_tags WHERE memory_id = m.id), '')
    FROM memories m
    WHERE m.id = NEW.memory_id;
END;

CREATE TRIGGER IF NOT EXISTS memory_tags_ad AFTER DELETE ON memory_tags BEGIN
    DELETE FROM memories_fts WHERE memory_id = OLD.memory_id;
    INSERT INTO memories_fts(memory_id, title, summary, content, tags)
    SELECT
        m.id,
        COALESCE(m.title, ''),
        COALESCE(m.summary, ''),
        m.content,
        COALESCE((SELECT group_concat(tag, ' ') FROM memory_tags WHERE memory_id = m.id), '')
    FROM memories m
    WHERE m.id = OLD.memory_id;
END;
