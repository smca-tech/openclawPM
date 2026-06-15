#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

WORKSPACE = Path('/home/smca-tech/.openclaw/workspace')
DB_PATH = WORKSPACE / 'memory-db' / 'openclaw-memory.sqlite'
MEMORY_MD = WORKSPACE / 'MEMORY.md'
MEMORY_DIR = WORKSPACE / 'memory'


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def slugify(text: str) -> str:
    s = text.strip().lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-') or 'item'


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


@dataclass
class MemoryRecord:
    id: str
    created_at: str
    updated_at: str
    kind: str
    status: str
    scope: str
    scope_key: str | None
    visibility: str
    sensitivity: str
    title: str | None
    content: str
    content_format: str
    summary: str | None
    importance: int
    confidence: float
    pinned: int
    durable: int
    source_type: str
    source_ref: str
    source_excerpt: str | None
    author_type: str
    author_id: str | None
    session_id: str | None
    parent_memory_id: str | None
    checksum: str
    metadata_json: str | None
    tags: list[str]
    mentions: list[tuple[str, str, str | None]]


def detect_sensitivity(content: str, tags: Iterable[str], title: str | None = None, kind_hint: str | None = None) -> str:
    lower = content.lower()
    tag_set = set(tags)
    title_lower = (title or '').lower()
    kind_hint = (kind_hint or '').lower()

    strong_markers = [
        'api key', 'api secret', 'oauth', 'access token', 'refresh token', 'client secret',
        'private key', 'bearer token', 'password:', 'secret:'
    ]
    medium_markers = [
        'password', 'token', 'credential', 'username:'
    ]

    credential_context = (
        'credential' in tag_set
        or kind_hint == 'credential_ref'
        or 'tools / accounts / environment notes' in title_lower
        or 'project context' in title_lower
        or 'witchy intentions' in title_lower
    )

    if any(m in lower for m in strong_markers):
        return 'secret'
    if credential_context and any(m in lower for m in medium_markers):
        return 'secret'
    return 'normal'


def parse_bullets(block: str) -> list[str]:
    items = []
    for line in block.splitlines():
        m = re.match(r'^\s*-\s+(.*)$', line)
        if m:
            items.append(m.group(1).strip())
    return items


def infer_scope_and_mentions(title: str, section_path: list[str], content: str):
    joined = ' / '.join(section_path).lower()
    lower = f"{title}\n{content}".lower()

    scope = 'global'
    scope_key = None
    mentions: list[tuple[str, str, str | None]] = []

    if 'johnny' in joined or 'johnny' in lower:
        scope = 'user'
        scope_key = 'johnny'
        mentions.append(('person', 'johnny', 'subject'))
    elif 'openclawpm' in joined or 'openclawpm' in lower:
        scope = 'project'
        scope_key = 'openclawPM'
        mentions.append(('project', 'openclawPM', 'subject'))
    elif 'witchy intentions' in joined or 'witchyintentions' in lower:
        scope = 'project'
        scope_key = 'witchy-intentions'
        mentions.append(('project', 'witchy-intentions', 'subject'))
    elif 'yuki mori' in joined or 'yuki mori' in lower:
        scope = 'agent'
        scope_key = 'yuki-mori'
        mentions.append(('person', 'yuki-mori', 'subject'))

    return scope, scope_key, mentions


def classify_long_term(section_path: list[str], title: str, content: str, tags: list[str]):
    top = section_path[0].lower() if section_path else ''
    title_lower = title.lower()

    if top == 'preferences' or 'prefer' in content.lower():
        kind = 'preference'
    elif top == 'working style':
        kind = 'instruction'
    elif top == 'ongoing projects' or top == 'long-term project context':
        kind = 'project'
    elif top == 'people' or top == 'johnny' or top == 'yuki mori':
        kind = 'person'
    elif top == 'tools / accounts / environment notes':
        kind = 'credential_ref' if detect_sensitivity(content, tags, title=' / '.join(section_path), kind_hint='credential_ref') == 'secret' else 'fact'
    elif top == 'notes':
        kind = 'note'
    elif top == 'recurring annoyances':
        kind = 'fact'
    else:
        kind = 'fact'

    importance = 70
    pinned = 0
    durable = 1

    if kind in {'preference', 'instruction'}:
        importance = 90
        pinned = 1
    elif kind == 'project':
        importance = 85
    elif kind == 'person':
        importance = 80
    elif kind == 'credential_ref':
        importance = 95
        pinned = 1
    elif top == 'notes':
        importance = 60

    sensitivity = detect_sensitivity(content, tags, title=title, kind_hint=kind)
    visibility = 'private'

    return kind, importance, pinned, durable, sensitivity, visibility


def split_memory_md_sections(text: str):
    lines = text.splitlines()
    sections = []
    stack: list[tuple[int, str]] = []
    current = None

    for line in lines:
        m = re.match(r'^(#{2,3})\s+(.*)$', line)
        if m:
            if current is not None:
                sections.append(current)
            level = len(m.group(1))
            heading = m.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, heading))
            current = {'path': [h for _, h in stack], 'content_lines': []}
        else:
            if current is not None:
                current['content_lines'].append(line)

    if current is not None:
        sections.append(current)

    return sections


def build_long_term_records() -> list[MemoryRecord]:
    text = MEMORY_MD.read_text(encoding='utf-8')
    records: list[MemoryRecord] = []
    base_created = datetime.fromtimestamp(MEMORY_MD.stat().st_mtime, tz=timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

    for sec in split_memory_md_sections(text):
        section_path = sec['path']
        block = '\n'.join(sec['content_lines']).strip()
        if not block:
            continue
        title = ' / '.join(section_path)
        bullets = parse_bullets(block)
        tags = [slugify(p) for p in section_path]
        if len(section_path) >= 2:
            tags.append(slugify(section_path[-1]))
        content = block
        scope, scope_key, mentions = infer_scope_and_mentions(title, section_path, content)
        kind, importance, pinned, durable, sensitivity, visibility = classify_long_term(section_path, title, content, tags)

        rec_id = f"mem_{slugify(title)}"
        summary = bullets[0][:240] if bullets else block.splitlines()[0][:240]
        metadata = {
            'migration': 'markdown-memory-v1',
            'source_file': 'MEMORY.md',
            'section_path': section_path,
            'bullet_count': len(bullets),
        }

        records.append(MemoryRecord(
            id=rec_id,
            created_at=base_created,
            updated_at=base_created,
            kind=kind,
            status='active',
            scope=scope,
            scope_key=scope_key,
            visibility=visibility,
            sensitivity=sensitivity,
            title=title,
            content=content,
            content_format='markdown',
            summary=summary,
            importance=importance,
            confidence=1.0,
            pinned=pinned,
            durable=durable,
            source_type='file',
            source_ref='MEMORY.md',
            source_excerpt=summary,
            author_type='assistant',
            author_id='yuki',
            session_id=None,
            parent_memory_id=None,
            checksum=sha256_text(f'MEMORY.md::{title}::{content}'),
            metadata_json=json.dumps(metadata, ensure_ascii=False),
            tags=sorted(set(tags)),
            mentions=mentions,
        ))

    return records


def parse_session_header(text: str):
    session_key = None
    session_id = None
    source = None
    m = re.search(r'\*\*Session Key\*\*:\s*(.+)', text)
    if m:
        session_key = m.group(1).strip()
    m = re.search(r'\*\*Session ID\*\*:\s*(.+)', text)
    if m:
        session_id = m.group(1).strip()
    m = re.search(r'\*\*Source\*\*:\s*(.+)', text)
    if m:
        source = m.group(1).strip()
    return session_key, session_id, source


def build_daily_records() -> tuple[list[dict], list[MemoryRecord]]:
    sessions = []
    records: list[MemoryRecord] = []

    for path in sorted(MEMORY_DIR.glob('*.md')):
        text = path.read_text(encoding='utf-8')
        stat_time = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
        rel = str(path.relative_to(WORKSPACE))

        if text.startswith('# Session:'):
            session_key, session_id, source = parse_session_header(text)
            sid = session_id or f"session_{slugify(path.stem)}"
            sessions.append({
                'id': sid,
                'started_at': stat_time,
                'ended_at': stat_time,
                'agent': 'main',
                'model': None,
                'chat_id': session_key,
                'chat_type': 'direct' if session_key and ':direct:' in session_key else None,
                'user_id': '8241756142' if session_key and '8241756142' in session_key else None,
                'channel': source,
                'title': path.stem,
                'cwd': str(WORKSPACE),
                'metadata_json': json.dumps({'migration': 'markdown-memory-v1', 'source_file': rel}, ensure_ascii=False),
            })
            body = text.strip()
            title = f"Session summary: {path.stem}"
            tags = ['daily-note', 'session-summary', 'imported']
            mentions = [('person', 'johnny', 'subject')] if '8241756142' in (session_key or '') else []
            records.append(MemoryRecord(
                id=f"mem_{slugify(path.stem)}",
                created_at=stat_time,
                updated_at=stat_time,
                kind='summary',
                status='active',
                scope='session',
                scope_key=sid,
                visibility='private',
                sensitivity=detect_sensitivity(body, tags, title=title, kind_hint='summary'),
                title=title,
                content=body,
                content_format='markdown',
                summary='Imported session summary from markdown daily memory.',
                importance=55,
                confidence=1.0,
                pinned=0,
                durable=0,
                source_type='file',
                source_ref=rel,
                source_excerpt=title,
                author_type='assistant',
                author_id='yuki',
                session_id=sid,
                parent_memory_id=None,
                checksum=sha256_text(f'{rel}::{body}'),
                metadata_json=json.dumps({'migration': 'markdown-memory-v1', 'kind_hint': 'session-summary'}, ensure_ascii=False),
                tags=tags,
                mentions=mentions,
            ))
        else:
            title = f"Daily notes: {path.stem}"
            body = text.strip()
            tags = ['daily-note', 'imported']
            mentions = []
            if 'johnny' in body.lower():
                mentions.append(('person', 'johnny', 'subject'))
            if 'yuki mori' in body.lower():
                mentions.append(('person', 'yuki-mori', 'subject'))
            records.append(MemoryRecord(
                id=f"mem_{slugify(path.stem)}",
                created_at=stat_time,
                updated_at=stat_time,
                kind='note',
                status='active',
                scope='chat',
                scope_key='telegram:8241756142',
                visibility='private',
                sensitivity=detect_sensitivity(body, tags, title=title, kind_hint='note'),
                title=title,
                content=body,
                content_format='markdown',
                summary='Imported daily note from markdown memory.',
                importance=50,
                confidence=1.0,
                pinned=0,
                durable=0,
                source_type='file',
                source_ref=rel,
                source_excerpt=title,
                author_type='assistant',
                author_id='yuki',
                session_id=None,
                parent_memory_id=None,
                checksum=sha256_text(f'{rel}::{body}'),
                metadata_json=json.dumps({'migration': 'markdown-memory-v1', 'kind_hint': 'daily-note'}, ensure_ascii=False),
                tags=tags,
                mentions=mentions,
            ))

    return sessions, records


def ensure_connection(db_path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(db_path)
    con.execute('PRAGMA foreign_keys = ON;')
    con.execute('PRAGMA journal_mode = WAL;')
    con.execute('PRAGMA synchronous = NORMAL;')
    return con


def upsert_session(con: sqlite3.Connection, session: dict):
    con.execute(
        '''
        INSERT INTO session_runs (
            id, started_at, ended_at, agent, model, chat_id, chat_type, user_id,
            channel, title, cwd, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            started_at=excluded.started_at,
            ended_at=excluded.ended_at,
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
            session['id'], session['started_at'], session['ended_at'], session['agent'], session['model'],
            session['chat_id'], session['chat_type'], session['user_id'], session['channel'], session['title'],
            session['cwd'], session['metadata_json']
        )
    )


def upsert_memory(con: sqlite3.Connection, record: MemoryRecord):
    con.execute(
        '''
        INSERT INTO memories (
            id, created_at, updated_at, kind, status, scope, scope_key, visibility,
            sensitivity, title, content, content_format, summary, importance,
            confidence, pinned, durable, source_type, source_ref, source_excerpt,
            author_type, author_id, session_id, parent_memory_id, checksum, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            updated_at=excluded.updated_at,
            kind=excluded.kind,
            status=excluded.status,
            scope=excluded.scope,
            scope_key=excluded.scope_key,
            visibility=excluded.visibility,
            sensitivity=excluded.sensitivity,
            title=excluded.title,
            content=excluded.content,
            content_format=excluded.content_format,
            summary=excluded.summary,
            importance=excluded.importance,
            confidence=excluded.confidence,
            pinned=excluded.pinned,
            durable=excluded.durable,
            source_type=excluded.source_type,
            source_ref=excluded.source_ref,
            source_excerpt=excluded.source_excerpt,
            author_type=excluded.author_type,
            author_id=excluded.author_id,
            session_id=excluded.session_id,
            parent_memory_id=excluded.parent_memory_id,
            checksum=excluded.checksum,
            metadata_json=excluded.metadata_json
        ''',
        (
            record.id, record.created_at, record.updated_at, record.kind, record.status,
            record.scope, record.scope_key, record.visibility, record.sensitivity,
            record.title, record.content, record.content_format, record.summary,
            record.importance, record.confidence, record.pinned, record.durable,
            record.source_type, record.source_ref, record.source_excerpt,
            record.author_type, record.author_id, record.session_id,
            record.parent_memory_id, record.checksum, record.metadata_json
        )
    )

    con.execute('DELETE FROM memory_tags WHERE memory_id = ?', (record.id,))
    for tag in sorted(set(record.tags)):
        con.execute('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)', (record.id, tag))

    con.execute('DELETE FROM memory_mentions WHERE memory_id = ?', (record.id,))
    for entity_type, entity_key, role in record.mentions:
        con.execute(
            'INSERT INTO memory_mentions (memory_id, entity_type, entity_key, role) VALUES (?, ?, ?, ?)',
            (record.id, entity_type, entity_key, role)
        )

    event_id = f"evt_{record.id}_migrated"
    con.execute(
        '''
        INSERT INTO memory_events (
            id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json
        ) VALUES (?, ?, 'created', ?, ?, 'assistant', 'markdown-migrator', ?)
        ON CONFLICT(id) DO UPDATE SET
            created_at=excluded.created_at,
            session_id=excluded.session_id,
            details_json=excluded.details_json
        ''',
        (
            event_id,
            record.id,
            record.updated_at,
            record.session_id,
            json.dumps({'migration': 'markdown-memory-v1', 'source_ref': record.source_ref}, ensure_ascii=False)
        )
    )


def migrate(db_path: Path, dry_run: bool = False):
    long_term = build_long_term_records()
    sessions, daily = build_daily_records()
    all_records = long_term + daily

    summary = {
        'sessions': len(sessions),
        'records_total': len(all_records),
        'long_term_records': len(long_term),
        'daily_records': len(daily),
        'kinds': {},
        'sensitivity': {},
    }

    for rec in all_records:
        summary['kinds'][rec.kind] = summary['kinds'].get(rec.kind, 0) + 1
        summary['sensitivity'][rec.sensitivity] = summary['sensitivity'].get(rec.sensitivity, 0) + 1

    if dry_run:
        return summary

    con = ensure_connection(db_path)
    try:
        with con:
            for session in sessions:
                upsert_session(con, session)
            for rec in all_records:
                upsert_memory(con, rec)
    finally:
        con.close()

    return summary


def main():
    parser = argparse.ArgumentParser(description='Migrate OpenClaw markdown memory into SQLite memory DB.')
    parser.add_argument('--db', default=str(DB_PATH), help='Path to SQLite DB')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be migrated without writing')
    args = parser.parse_args()

    result = migrate(Path(args.db), dry_run=args.dry_run)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
