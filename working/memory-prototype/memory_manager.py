#!/usr/bin/env python3
import json
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import hashlib
import re

WORKSPACE = Path('/home/smca-tech/.openclaw/workspace')
DEFAULT_DB_PATH = WORKSPACE / 'memory-db' / 'openclaw-memory.sqlite'
DEFAULT_PRESETS_PATH = Path(__file__).with_name('recall_presets.json')
DEFAULT_WRITE_HEURISTICS_PATH = Path(__file__).with_name('write_heuristics.json')
VALIDATOR_PATH = Path(__file__).with_name('validate_config.mjs')


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def slugify(text: str) -> str:
    s = text.strip().lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-') or 'item'


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def validate_config(kind: str, path: str | Path) -> None:
    subprocess.run(
        ['node', str(VALIDATOR_PATH), kind, str(Path(path))],
        check=True,
        capture_output=True,
        text=True,
    )


def load_recall_presets(path: str | Path = DEFAULT_PRESETS_PATH) -> dict[str, Any]:
    validate_config('recall', path)
    return json.loads(Path(path).read_text(encoding='utf-8'))


def load_write_heuristics(path: str | Path = DEFAULT_WRITE_HEURISTICS_PATH) -> dict[str, Any]:
    validate_config('write', path)
    return json.loads(Path(path).read_text(encoding='utf-8'))


@dataclass
class SessionContext:
    session_id: str
    chat_id: str | None = None
    chat_type: str | None = None
    user_id: str | None = None
    user_key: str | None = None
    project_key: str | None = None
    agent_key: str | None = None
    cwd: str | None = None
    mentioned_entities: list[tuple[str, str]] | None = None
    include_secret: bool = False
    max_memories: int = 40
    recent_session_limit: int = 8
    preset: str = 'dm'


class MemoryManager:
    def __init__(
        self,
        db_path: str | Path = DEFAULT_DB_PATH,
        presets_path: str | Path = DEFAULT_PRESETS_PATH,
        write_heuristics_path: str | Path = DEFAULT_WRITE_HEURISTICS_PATH,
    ):
        self.db_path = Path(db_path)
        self.presets = load_recall_presets(presets_path)
        self.write_heuristics = load_write_heuristics(write_heuristics_path)
        self.strategy_map = {
            'default_pinned': self._fetch_pinned,
            'group_pinned': self._fetch_group_pinned,
            'project_pinned': self._fetch_project_pinned,
            'admin_pinned': self._fetch_admin_pinned,
            'default_scoped': self._fetch_scoped,
            'group_scoped': self._fetch_group_scoped,
            'project_scoped': self._fetch_project_scoped,
            'admin_scoped': self._fetch_admin_scoped,
            'default_entity': self._fetch_entity_related,
            'group_entity': self._fetch_group_entity_related,
            'default_recent': self._fetch_recent,
            'group_recent': self._fetch_group_recent,
        }

    def connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA foreign_keys = ON;')
        con.execute('PRAGMA journal_mode = WAL;')
        con.execute('PRAGMA synchronous = NORMAL;')
        return con

    def register_session(self, ctx: SessionContext, agent: str = 'main', model: str | None = None, channel: str | None = None, title: str | None = None):
        with self.connect() as con:
            con.execute(
                '''
                INSERT INTO session_runs (
                    id, started_at, ended_at, agent, model, chat_id, chat_type, user_id,
                    channel, title, cwd, metadata_json
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    agent=excluded.agent,
                    model=excluded.model,
                    chat_id=excluded.chat_id,
                    chat_type=excluded.chat_type,
                    user_id=excluded.user_id,
                    channel=excluded.channel,
                    title=excluded.title,
                    cwd=excluded.cwd,
                    metadata_json=excluded.metadata_json
                ''',
                (
                    ctx.session_id,
                    now_iso(),
                    agent,
                    model,
                    ctx.chat_id,
                    ctx.chat_type,
                    ctx.user_id,
                    channel,
                    title,
                    ctx.cwd,
                    json.dumps({'registered_by': 'memory_manager'}, ensure_ascii=False),
                )
            )

    def end_session(self, session_id: str):
        with self.connect() as con:
            con.execute('UPDATE session_runs SET ended_at = ? WHERE id = ?', (now_iso(), session_id))

    def startup_hydrate(self, ctx: SessionContext) -> dict[str, list[dict[str, Any]]]:
        with self.connect() as con:
            preset = self.presets.get('presets', {}).get(ctx.preset, self.presets['presets']['dm'])
            result = {}
            for bucket, strategy_name in preset.get('bucket_strategies', {}).items():
                strategy = self.strategy_map[strategy_name]
                strategy_cfg = self.presets.get('strategies', {}).get(strategy_name, {})
                result[bucket] = strategy(con, ctx, strategy_cfg)
            result['merged'] = self._merge_ranked_groups(result, ctx.max_memories)
            self._log_recall_events(con, result['merged'], ctx.session_id)
            return result

    def search(self, query: str, ctx: SessionContext, limit: int = 12) -> list[dict[str, Any]]:
        sensitivity_clause = '' if ctx.include_secret else "AND m.sensitivity != 'secret'"
        with self.connect() as con:
            rows = con.execute(
                f'''
                SELECT m.*, bm25(memories_fts) AS fts_rank
                FROM memories_fts f
                JOIN memories m ON m.id = f.memory_id
                WHERE memories_fts MATCH ?
                  AND m.status = 'active'
                  {sensitivity_clause}
                ORDER BY fts_rank, m.pinned DESC, m.importance DESC, m.updated_at DESC
                LIMIT ?
                ''',
                (query, limit)
            ).fetchall()
            return [dict(r) for r in rows]

    def remember(self,
                 *,
                 content: str,
                 title: str | None,
                 kind: str,
                 scope: str,
                 scope_key: str | None,
                 session_id: str | None,
                 source_type: str = 'manual',
                 source_ref: str | None = None,
                 tags: list[str] | None = None,
                 mentions: list[tuple[str, str, str | None]] | None = None,
                 importance: int = 60,
                 confidence: float = 1.0,
                 pinned: bool = False,
                 durable: bool = True,
                 sensitivity: str = 'normal',
                 author_type: str = 'assistant',
                 author_id: str | None = None,
                 parent_memory_id: str | None = None,
                 metadata: dict[str, Any] | None = None) -> str:
        cfg = self.write_heuristics.get('remember', {})
        tags = sorted(set(tags or []))
        mentions = mentions or []
        created = now_iso()
        checksum_input = {
            'kind': kind,
            'scope': scope,
            'scope_key': scope_key,
            'title': title,
            'content': content,
        }
        checksum = sha256_text('|'.join(str(checksum_input[field]) for field in cfg.get('checksum_fields', ['kind', 'scope', 'scope_key', 'title', 'content'])))
        base_memory_id = f"{cfg.get('id_prefix', 'mem_runtime_')}{slugify(title or content[:40])}_{checksum[:cfg.get('id_hash_length', 10)]}"
        memory_id = base_memory_id
        summary = content.splitlines()[0][:cfg.get('summary_max_chars', 240)]
        author_id = author_id if author_id is not None else cfg.get('event_actor_id', 'yuki')

        with self.connect() as con:
            existing = con.execute(
                '''
                SELECT id FROM memories
                WHERE checksum = ? AND status = 'active'
                LIMIT 1
                ''' if cfg.get('dedupe_active_only', True) else '''
                SELECT id FROM memories
                WHERE checksum = ?
                LIMIT 1
                ''',
                (checksum,)
            ).fetchone()
            if existing:
                return str(existing['id'])

            counter = 1
            while con.execute('SELECT 1 FROM memories WHERE id = ? LIMIT 1', (memory_id,)).fetchone():
                memory_id = f"{base_memory_id}_v{counter}"
                counter += 1

            con.execute(
                '''
                INSERT INTO memories (
                    id, created_at, updated_at, kind, status, scope, scope_key, visibility,
                    sensitivity, title, content, content_format, summary, importance,
                    confidence, pinned, durable, source_type, source_ref, source_excerpt,
                    author_type, author_id, session_id, parent_memory_id, checksum, metadata_json
                ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    memory_id,
                    created,
                    created,
                    kind,
                    scope,
                    scope_key,
                    cfg.get('default_visibility', 'private'),
                    sensitivity,
                    title,
                    content,
                    cfg.get('content_format', 'markdown'),
                    summary,
                    importance,
                    confidence,
                    1 if pinned else 0,
                    1 if durable else 0,
                    source_type,
                    source_ref,
                    summary,
                    author_type,
                    author_id,
                    session_id,
                    parent_memory_id,
                    checksum,
                    json.dumps(metadata or {}, ensure_ascii=False),
                )
            )
            for tag in tags:
                con.execute('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)', (memory_id, tag))
            for entity_type, entity_key, role in mentions:
                con.execute(
                    'INSERT INTO memory_mentions (memory_id, entity_type, entity_key, role) VALUES (?, ?, ?, ?)',
                    (memory_id, entity_type, entity_key, role)
                )
            con.execute(
                '''
                INSERT INTO memory_events (
                    id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    f"evt_{memory_id}_{cfg.get('event_type', 'created')}",
                    memory_id,
                    cfg.get('event_type', 'created'),
                    created,
                    session_id,
                    author_type,
                    author_id,
                    json.dumps({k: {'source_type': source_type, 'source_ref': source_ref}[k] for k in cfg.get('event_source_details', ['source_type', 'source_ref'])}, ensure_ascii=False),
                )
            )
        return memory_id

    def supersede_memory(self, old_memory_id: str, new_memory_id: str):
        cfg = self.write_heuristics.get('supersede', {})
        with self.connect() as con:
            con.execute("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?", (cfg.get('status', 'superseded'), now_iso(), old_memory_id))
            con.execute(
                '''
                INSERT INTO memory_links (id, from_memory_id, to_memory_id, relation, weight, created_at, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
                ''',
                (
                    f"lnk_{new_memory_id}_{cfg.get('link_relation', 'supersedes')}_{old_memory_id}",
                    new_memory_id,
                    old_memory_id,
                    cfg.get('link_relation', 'supersedes'),
                    cfg.get('link_weight', 1.0),
                    now_iso(),
                    json.dumps({'created_by': cfg.get('metadata_created_by', 'memory_manager')}, ensure_ascii=False),
                )
            )

    def get_memory_version(self, memory_id: str) -> int:
        version_field = self.write_heuristics.get('update', {}).get('version_field', 'revision')
        with self.connect() as con:
            row = con.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,)).fetchone()
            if not row:
                raise ValueError(f'Memory not found: {memory_id}')
            metadata = json.loads(row['metadata_json']) if row['metadata_json'] else {}
            return int(metadata.get(version_field, 0))

    def read_for_update(self, memory_id: str) -> dict[str, Any]:
        version_field = self.write_heuristics.get('update', {}).get('version_field', 'revision')
        with self.connect() as con:
            row = con.execute('SELECT * FROM memories WHERE id = ?', (memory_id,)).fetchone()
            if not row:
                raise ValueError(f'Memory not found: {memory_id}')
            record = dict(row)
            record['metadata'] = json.loads(record['metadata_json']) if record['metadata_json'] else {}
            record['version'] = int(record['metadata'].get(version_field, 0))
            record['tags'] = [r['tag'] for r in con.execute('SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag', (memory_id,)).fetchall()]
            record['mentions'] = [
                {
                    'entity_type': r['entity_type'],
                    'entity_key': r['entity_key'],
                    'role': r['role'],
                }
                for r in con.execute('SELECT entity_type, entity_key, role FROM memory_mentions WHERE memory_id = ? ORDER BY entity_type, entity_key, role', (memory_id,)).fetchall()
            ]
            return record

    def update_memory(self,
                      memory_id: str,
                      *,
                      expected_version: int | None = None,
                      expected_updated_at: str | None = None,
                      title: str | None = None,
                      content: str | None = None,
                      summary: str | None = None,
                      tags: list[str] | None = None,
                      mentions: list[tuple[str, str, str | None]] | None = None,
                      importance: int | None = None,
                      confidence: float | None = None,
                      pinned: bool | None = None,
                      durable: bool | None = None,
                      sensitivity: str | None = None,
                      status: str | None = None,
                      metadata: dict[str, Any] | None = None,
                      author_type: str = 'assistant',
                      author_id: str | None = None,
                      session_id: str | None = None) -> str:
        cfg = self.write_heuristics.get('update', {})
        author_id = author_id if author_id is not None else cfg.get('event_actor_id', 'yuki')
        with self.connect() as con:
            row = con.execute('SELECT * FROM memories WHERE id = ?', (memory_id,)).fetchone()
            if not row:
                raise ValueError(f'Memory not found: {memory_id}')

            current = dict(row)
            version_field = cfg.get('version_field', 'revision')
            current_metadata = json.loads(current['metadata_json']) if current['metadata_json'] else {}
            current_version = int(current_metadata.get(version_field, 0))
            if cfg.get('require_version_match', True):
                if expected_version is None:
                    raise ValueError(f"Version check required for {memory_id}: expected_version must be provided")
                if current_version != expected_version:
                    raise ValueError(f"Stale update for {memory_id}: expected {version_field}={expected_version}, actual {version_field}={current_version}")

            next_title = current['title'] if cfg.get('preserve_existing_non_null') and title is None else (title if title is not None else current['title'])
            next_content = current['content'] if cfg.get('preserve_existing_non_null') and content is None else (content if content is not None else current['content'])
            next_summary = summary if summary is not None else (next_content.splitlines()[0][:cfg.get('summary_max_chars', 240)] if next_content else current['summary'])
            next_importance = current['importance'] if importance is None else importance
            next_confidence = current['confidence'] if confidence is None else confidence
            next_pinned = current['pinned'] if pinned is None else (1 if pinned else 0)
            next_durable = current['durable'] if durable is None else (1 if durable else 0)
            next_sensitivity = current['sensitivity'] if sensitivity is None else sensitivity
            next_status = current['status'] if status is None else status
            next_metadata = metadata if metadata is not None else current_metadata
            next_updated_at = now_iso() if cfg.get('touch_updated_at', True) else current['updated_at']
            next_checksum = current['checksum']
            if cfg.get('recompute_checksum', True):
                checksum_input = {
                    'kind': current['kind'],
                    'scope': current['scope'],
                    'scope_key': current['scope_key'],
                    'title': next_title,
                    'content': next_content,
                }
                next_checksum = sha256_text('|'.join(str(checksum_input[field]) for field in self.write_heuristics.get('remember', {}).get('checksum_fields', ['kind', 'scope', 'scope_key', 'title', 'content'])))
            next_metadata[version_field] = current_version + 1

            con.execute(
                '''
                UPDATE memories
                SET updated_at = ?,
                    title = ?,
                    content = ?,
                    summary = ?,
                    importance = ?,
                    confidence = ?,
                    pinned = ?,
                    durable = ?,
                    sensitivity = ?,
                    status = ?,
                    checksum = ?,
                    metadata_json = ?
                WHERE id = ?
                ''',
                (
                    next_updated_at,
                    next_title,
                    next_content,
                    next_summary,
                    next_importance,
                    next_confidence,
                    next_pinned,
                    next_durable,
                    next_sensitivity,
                    next_status,
                    next_checksum,
                    json.dumps(next_metadata, ensure_ascii=False),
                    memory_id,
                )
            )

            if tags is not None:
                if cfg.get('merge_tags', True):
                    existing_tags = {r['tag'] for r in con.execute('SELECT tag FROM memory_tags WHERE memory_id = ?', (memory_id,)).fetchall()}
                    next_tags = sorted(existing_tags | set(tags))
                else:
                    next_tags = sorted(set(tags))
                con.execute('DELETE FROM memory_tags WHERE memory_id = ?', (memory_id,))
                for tag in next_tags:
                    con.execute('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)', (memory_id, tag))

            if mentions is not None:
                if cfg.get('merge_mentions', True):
                    existing_mentions = {
                        (r['entity_type'], r['entity_key'], r['role'])
                        for r in con.execute('SELECT entity_type, entity_key, role FROM memory_mentions WHERE memory_id = ?', (memory_id,)).fetchall()
                    }
                    next_mentions = sorted(existing_mentions | set(mentions))
                else:
                    next_mentions = list(mentions)
                con.execute('DELETE FROM memory_mentions WHERE memory_id = ?', (memory_id,))
                for entity_type, entity_key, role in next_mentions:
                    con.execute(
                        'INSERT INTO memory_mentions (memory_id, entity_type, entity_key, role) VALUES (?, ?, ?, ?)',
                        (memory_id, entity_type, entity_key, role)
                    )

            updated_fields = [k for k, v in {
                'title': title,
                'content': content,
                'summary': summary,
                'tags': tags,
                'mentions': mentions,
                'importance': importance,
                'confidence': confidence,
                'pinned': pinned,
                'durable': durable,
                'sensitivity': sensitivity,
                'status': status,
                'metadata': metadata,
            }.items() if v is not None]
            event_suffix = sha256_text(f"{memory_id}|{next_updated_at}|{updated_fields}|{next_content}|{next_summary}")[:10]
            con.execute(
                '''
                INSERT INTO memory_events (
                    id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    f"evt_{memory_id}_{cfg.get('event_type', 'updated')}_{event_suffix}",
                    memory_id,
                    cfg.get('event_type', 'updated'),
                    next_updated_at,
                    session_id,
                    author_type,
                    author_id,
                    json.dumps({'updated_fields': updated_fields, 'expected_version': expected_version, 'previous_version': current_version, 'new_version': next_metadata[version_field], 'previous_updated_at': current['updated_at']}, ensure_ascii=False),
                )
            )
        return memory_id

    def _apply_visibility_clause(self, cfg: dict[str, Any], ctx: SessionContext, alias: str = '') -> str:
        column = f'{alias}sensitivity' if alias else 'sensitivity'
        mode = cfg.get('visibility', 'respect_context')
        if mode == 'all':
            return ''
        if mode == 'normal_only':
            return f"AND {column} = 'normal'"
        if ctx.include_secret:
            return ''
        return f"AND {column} != 'secret'"

    def _fetch_pinned(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        clause = self._apply_visibility_clause(cfg, ctx)
        rows = con.execute(
            f'''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND pinned = 1
              {clause}
              AND (
                    scope = 'global'
                 OR (scope = 'user' AND scope_key = ?)
                 OR (scope = 'agent' AND scope_key = ?)
              )
            ORDER BY importance DESC, updated_at DESC
            LIMIT ?
            ''',
            (ctx.user_key, ctx.agent_key, cfg.get('limit', 20))
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_group_pinned(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        rows = con.execute(
            '''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND pinned = 1
              AND sensitivity = 'normal'
              AND kind IN ({kinds})
              AND scope IN ({scopes})
            ORDER BY importance DESC, updated_at DESC
            LIMIT ?
            '''.format(
                kinds=','.join('?' for _ in cfg.get('allowed_kinds', [])),
                scopes=','.join('?' for _ in cfg.get('scopes', [])),
            ),
            (*cfg.get('allowed_kinds', []), *cfg.get('scopes', []), cfg.get('limit', 12))
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_project_pinned(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        clause = self._apply_visibility_clause(cfg, ctx)
        rows = con.execute(
            f'''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND pinned = 1
              {clause}
              AND (
                    (scope = 'project' AND scope_key = ?)
                 OR (scope = 'user' AND scope_key = ? AND kind IN ({user_kinds}))
                 OR (scope = 'global' AND kind IN ({global_kinds}))
              )
            ORDER BY importance DESC, updated_at DESC
            LIMIT ?
            '''.format(
                user_kinds=','.join('?' for _ in cfg.get('fallback_user_kinds', [])),
                global_kinds=','.join('?' for _ in cfg.get('fallback_global_kinds', [])),
            ),
            (ctx.project_key, ctx.user_key, *cfg.get('fallback_user_kinds', []), *cfg.get('fallback_global_kinds', []), cfg.get('limit', 20))
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_admin_pinned(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        rows = con.execute(
            '''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND pinned = 1
            ORDER BY importance DESC, updated_at DESC
            LIMIT ?
            ''',
            (cfg.get('limit', 25),)
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_scoped(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        clause = self._apply_visibility_clause(cfg, ctx)
        thresholds = cfg.get('importance_thresholds', {})
        rows = con.execute(
            f'''
            SELECT *
            FROM memories
            WHERE status = 'active'
              {clause}
              AND (
                    (scope = 'global' AND importance >= ?)
                 OR (scope = 'user' AND scope_key = ? AND importance >= ?)
                 OR (scope = 'project' AND scope_key = ? AND importance >= ?)
                 OR (scope = 'chat' AND scope_key = ? AND importance >= ?)
                 OR (scope = 'agent' AND scope_key = ? AND importance >= ?)
              )
            ORDER BY pinned DESC, importance DESC, updated_at DESC
            LIMIT ?
            ''',
            (
                thresholds.get('global', 75),
                ctx.user_key, thresholds.get('user', 70),
                ctx.project_key, thresholds.get('project', 65),
                ctx.chat_id, thresholds.get('chat', 60),
                ctx.agent_key, thresholds.get('agent', 70),
                cfg.get('limit', 40),
            )
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_group_scoped(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        thresholds = cfg.get('importance_thresholds', {})
        rows = con.execute(
            '''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND sensitivity = 'normal'
              AND kind IN ({kinds})
              AND (
                    (scope = 'global' AND importance >= ?)
                 OR (scope = 'agent' AND importance >= ?)
                 OR (scope = 'project' AND importance >= ?)
              )
            ORDER BY pinned DESC, importance DESC, updated_at DESC
            LIMIT ?
            '''.format(kinds=','.join('?' for _ in cfg.get('allowed_kinds', []))),
            (
                *cfg.get('allowed_kinds', []),
                thresholds.get('global', 75),
                thresholds.get('agent', 75),
                thresholds.get('project', 80),
                cfg.get('limit', 25),
            )
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_project_scoped(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        clause = self._apply_visibility_clause(cfg, ctx)
        thresholds = cfg.get('importance_thresholds', {})
        rows = con.execute(
            f'''
            SELECT *
            FROM memories
            WHERE status = 'active'
              {clause}
              AND (
                    (scope = 'project' AND scope_key = ? AND importance >= ?)
                 OR (scope = 'user' AND scope_key = ? AND kind IN ({user_kinds}) AND importance >= ?)
                 OR (scope = 'global' AND kind IN ({global_kinds}) AND importance >= ?)
              )
            ORDER BY
              CASE WHEN scope = 'project' AND scope_key = ? THEN 0 ELSE 1 END,
              pinned DESC,
              importance DESC,
              updated_at DESC
            LIMIT ?
            '''.format(
                user_kinds=','.join('?' for _ in cfg.get('fallback_user_kinds', [])),
                global_kinds=','.join('?' for _ in cfg.get('fallback_global_kinds', [])),
            ),
            (
                ctx.project_key, thresholds.get('project', 55),
                ctx.user_key, *cfg.get('fallback_user_kinds', []), thresholds.get('user', 75),
                *cfg.get('fallback_global_kinds', []), thresholds.get('global', 70),
                ctx.project_key,
                cfg.get('limit', 40),
            )
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_admin_scoped(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        rows = con.execute(
            '''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND importance >= ?
            ORDER BY pinned DESC, importance DESC, updated_at DESC
            LIMIT ?
            ''',
            (cfg.get('minimum_importance', 50), cfg.get('limit', 50))
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_entity_related(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        entities = ctx.mentioned_entities or []
        if not entities:
            return []
        clause = self._apply_visibility_clause(cfg, ctx, alias='m.')
        seen = {}
        for entity_type, entity_key in entities:
            rows = con.execute(
                f'''
                SELECT m.*
                FROM memory_mentions mm
                JOIN memories m ON m.id = mm.memory_id
                WHERE mm.entity_type = ?
                  AND mm.entity_key = ?
                  AND m.status = 'active'
                  {clause}
                ORDER BY
                  CASE WHEN ? AND m.kind = 'credential_ref' AND m.sensitivity = 'normal' THEN 1 ELSE 0 END,
                  m.pinned DESC,
                  m.importance DESC,
                  m.updated_at DESC
                LIMIT ?
                ''',
                (entity_type, entity_key, 1 if cfg.get('demote_normal_credentials') else 0, cfg.get('per_entity_limit', 10))
            ).fetchall()
            for row in rows:
                seen[row['id']] = dict(row)
        return list(seen.values())

    def _fetch_group_entity_related(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        entities = ctx.mentioned_entities or []
        if not entities:
            return []
        seen = {}
        for entity_type, entity_key in entities:
            rows = con.execute(
                '''
                SELECT m.*
                FROM memory_mentions mm
                JOIN memories m ON m.id = mm.memory_id
                WHERE mm.entity_type = ?
                  AND mm.entity_key = ?
                  AND m.status = 'active'
                  AND m.sensitivity = 'normal'
                  AND m.scope IN ({scopes})
                  AND m.kind IN ({kinds})
                ORDER BY m.importance DESC, m.updated_at DESC
                LIMIT ?
                '''.format(
                    scopes=','.join('?' for _ in cfg.get('scopes', [])),
                    kinds=','.join('?' for _ in cfg.get('allowed_kinds', [])),
                ),
                (entity_type, entity_key, *cfg.get('scopes', []), *cfg.get('allowed_kinds', []), cfg.get('per_entity_limit', 8))
            ).fetchall()
            for row in rows:
                seen[row['id']] = dict(row)
        return list(seen.values())

    def _fetch_recent(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        clause = self._apply_visibility_clause(cfg, ctx)
        limit = ctx.recent_session_limit if cfg.get('limit_from_context') == 'recent_session_limit' else cfg.get('limit', ctx.recent_session_limit)
        rows = con.execute(
            f'''
            SELECT *
            FROM memories
            WHERE status = 'active'
              {clause}
              AND (
                    (scope = 'session')
                 OR (scope = 'chat' AND scope_key = ?)
              )
            ORDER BY updated_at DESC, importance DESC
            LIMIT ?
            ''',
            (ctx.chat_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]

    def _fetch_group_recent(self, con: sqlite3.Connection, ctx: SessionContext, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        rows = con.execute(
            '''
            SELECT *
            FROM memories
            WHERE status = 'active'
              AND sensitivity = 'normal'
              AND scope = 'chat'
              AND scope_key = ?
            ORDER BY updated_at DESC, importance DESC
            LIMIT ?
            ''',
            (ctx.chat_id, cfg.get('limit', 4))
        ).fetchall()
        return [dict(r) for r in rows]

    def _merge_ranked_groups(self, groups: dict[str, list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
        merged: dict[str, dict[str, Any]] = {}
        bucket_order = self.presets.get('bucket_order', ['pinned', 'scoped', 'entity', 'recent'])
        bucket_bonus = self.presets.get('bucket_bonus', {'pinned': 1000, 'scoped': 700, 'entity': 500, 'recent': 300})

        for bucket in bucket_order:
            for item in groups.get(bucket, []):
                row = dict(item)
                score = int(row.get('importance', 0)) + bucket_bonus[bucket] + (200 if row.get('pinned') else 0)
                if row['id'] not in merged or score > merged[row['id']]['_score']:
                    row['_score'] = score
                    row['_bucket'] = bucket
                    merged[row['id']] = row

        ordered = sorted(merged.values(), key=lambda r: (r['_score'], r.get('updated_at', '')), reverse=True)
        return ordered[:limit]

    def _log_recall_events(self, con: sqlite3.Connection, memories: list[dict[str, Any]], session_id: str):
        ts = now_iso()
        for row in memories:
            event_id = f"evt_{row['id']}_recalled_{slugify(session_id)}"
            con.execute(
                '''
                INSERT INTO memory_events (
                    id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json
                ) VALUES (?, ?, 'recalled', ?, ?, 'assistant', 'memory_manager', ?)
                ON CONFLICT(id) DO NOTHING
                ''',
                (
                    event_id,
                    row['id'],
                    ts,
                    session_id,
                    json.dumps({'bucket': row.get('_bucket'), 'score': row.get('_score')}, ensure_ascii=False),
                )
            )


def build_default_session_context(*,
                                  session_id: str,
                                  chat_id: str | None,
                                  user_id: str | None,
                                  chat_type: str | None = 'direct',
                                  user_key: str | None = None,
                                  project_key: str | None = None,
                                  agent_key: str | None = None,
                                  cwd: str | None = None,
                                  mentioned_entities: list[tuple[str, str]] | None = None,
                                  include_secret: bool = False,
                                  max_memories: int = 40,
                                  preset: str = 'dm') -> SessionContext:
    return SessionContext(
        session_id=session_id,
        chat_id=chat_id,
        chat_type=chat_type,
        user_id=user_id,
        user_key=user_key,
        project_key=project_key,
        agent_key=agent_key,
        cwd=cwd,
        mentioned_entities=mentioned_entities or [],
        include_secret=include_secret,
        max_memories=max_memories,
        preset=preset,
    )
