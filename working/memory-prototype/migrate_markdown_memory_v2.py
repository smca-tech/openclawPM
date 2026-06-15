#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

WORKSPACE = Path('/home/smca-tech/.openclaw/workspace')
DB_PATH = WORKSPACE / 'memory-db' / 'openclaw-memory.sqlite'
MEMORY_MD = WORKSPACE / 'MEMORY.md'
MEMORY_DIR = WORKSPACE / 'memory'
MIGRATION_VERSION = 'markdown-memory-v2'
DEFAULT_RULES_PATH = Path(__file__).with_name('migration_rules.json')
VALIDATOR_PATH = Path(__file__).with_name('validate_config.mjs')


def slugify(text: str) -> str:
    s = text.strip().lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-') or 'item'


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def validate_config(kind: str, path: Path) -> None:
    subprocess.run(
        ['node', str(VALIDATOR_PATH), kind, str(path)],
        check=True,
        capture_output=True,
        text=True,
    )


def load_rules(path: Path) -> dict:
    validate_config('migration', path)
    return json.loads(path.read_text(encoding='utf-8'))


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


@dataclass
class MemoryLink:
    id: str
    from_memory_id: str
    to_memory_id: str
    relation: str
    weight: float
    created_at: str
    metadata_json: str | None


def detect_sensitivity(content: str, tags: Iterable[str], rules: dict, title: str | None = None, kind_hint: str | None = None) -> str:
    cfg = rules['sensitivity_rules']
    lower = content.lower()
    title_lower = (title or '').lower()
    kind_hint = (kind_hint or '').lower()

    if kind_hint in cfg.get('force_normal_kind_hints', []):
        return 'normal'
    if any(m in lower for m in cfg.get('secret_markers', [])):
        return 'secret'
    if any(m in lower for m in cfg.get('secret_presence_markers', [])):
        return 'secret'
    if kind_hint in cfg.get('sensitive_when_kind', []) and any(m in lower for m in cfg.get('sensitive_markers', [])):
        return 'sensitive'
    if 'oauth' in lower and kind_hint in cfg.get('sensitive_when_kind', []):
        return 'sensitive'

    for rule in cfg.get('special_title_sensitive_rules', []):
        if rule.get('title_contains', '') in title_lower and rule.get('content_contains', '') in lower:
            return rule.get('sensitivity', 'normal')

    return 'normal'


def parse_bullets(block: str) -> list[str]:
    items = []
    for line in block.splitlines():
        m = re.match(r'^\s*-\s+(.*)$', line)
        if m:
            items.append(m.group(1).strip())
    return items


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


def infer_scope_and_mentions(title: str, section_path: list[str], content: str, rules: dict):
    joined = ' / '.join(section_path).lower()
    lower = f"{title}\n{content}".lower()

    scope = 'global'
    scope_key = None
    mentions: list[tuple[str, str, str | None]] = []
    reserved = set(rules.get('reserved_section_names', []))
    scope_cfg = rules.get('scope_detection', {})

    if scope_cfg.get('generic_single_section_person_scope') and section_path:
        top = section_path[0].strip()
        top_slug = slugify(top)
        if len(section_path) == 1 and top.lower() not in reserved:
            scope = 'user'
            scope_key = top_slug
            mentions.append(('person', top_slug, 'subject'))

    haystack = f'{joined}\n{lower}'
    for project_rule in scope_cfg.get('project_rules', []):
        if any(token.lower() in haystack for token in project_rule.get('match_any', [])):
            scope = project_rule['scope']
            scope_key = project_rule['scope_key']
            mention = tuple(project_rule['mention'])
            if mention not in mentions:
                mentions.append(mention)
            break

    return scope, scope_key, mentions


def classify_long_term(section_path: list[str], title: str, content: str, tags: list[str], rules: dict):
    top = section_path[0].lower() if section_path else ''
    reserved = set(rules.get('reserved_section_names', []))
    section_kind_rules = rules.get('section_kind_rules', {})
    defaults = rules.get('section_defaults', {})
    kind_overrides = rules.get('section_kind_overrides', {})
    name_overrides = rules.get('section_name_overrides', {})

    if top in section_kind_rules:
        kind = section_kind_rules[top]
    elif 'prefer' in content.lower():
        kind = 'preference'
    elif section_path and len(section_path) == 1 and top not in reserved:
        kind = 'person'
    else:
        kind = 'fact'

    importance = defaults.get('importance', 70)
    pinned = defaults.get('pinned', 0)
    durable = defaults.get('durable', 1)
    visibility = defaults.get('visibility', 'private')

    for key, value in kind_overrides.get(kind, {}).items():
        if key == 'importance':
            importance = value
        elif key == 'pinned':
            pinned = value
        elif key == 'durable':
            durable = value

    for key, value in name_overrides.get(top, {}).items():
        if key == 'importance':
            importance = value
        elif key == 'pinned':
            pinned = value
        elif key == 'durable':
            durable = value

    sensitivity = detect_sensitivity(content, tags, rules, title=title, kind_hint=kind)
    return kind, importance, pinned, durable, sensitivity, visibility


def classify_atomic_bullet(section_path: list[str], bullet: str, parent_kind: str, parent_tags: list[str], rules: dict):
    top = section_path[0].lower() if section_path else ''
    reserved = set(rules.get('reserved_section_names', []))
    atomic_cfg = rules.get('atomic_rules', {})

    key_match = re.match(r'^([^:]+):\s*(.*)$', bullet)
    key = key_match.group(1).strip() if key_match else None
    value = key_match.group(2).strip() if key_match else None
    key_lower = key.lower() if key else ''

    kind = parent_kind
    importance = 70
    pinned = 0
    durable = 1
    visibility = atomic_cfg.get('default_visibility', 'private')

    section_map = atomic_cfg.get('section_kind_map', {})
    if top in section_map:
        mapped = section_map[top]
        kind = mapped.get('kind', kind)
        importance = mapped.get('importance', importance)
        pinned = mapped.get('pinned', pinned)
    elif section_path and len(section_path) == 1 and top not in reserved:
        kind = 'person'
        importance = 80

    if key_lower in atomic_cfg.get('secret_key_names', []):
        kind = 'credential_ref'
        importance = atomic_cfg.get('credential_importance', 100)
        pinned = 1
    elif any(token in key_lower for token in atomic_cfg.get('secret_key_contains', [])):
        kind = 'credential_ref'
        importance = atomic_cfg.get('credential_importance', 100)
        pinned = 1
    elif any(token in key_lower for token in atomic_cfg.get('identifier_key_contains', [])):
        if top == 'tools / accounts / environment notes':
            kind = 'fact'
            importance = max(importance, atomic_cfg.get('tools_identifier_importance', 58))
        else:
            importance = max(importance, 80)
    elif key_lower in atomic_cfg.get('person_identity_keys', []):
        if section_path and len(section_path) == 1 and top not in reserved and top != 'people':
            kind = 'person'
            importance = max(importance, atomic_cfg.get('person_identity_importance', 85))
    elif key_lower in atomic_cfg.get('high_value_project_keys', []):
        importance = max(importance, atomic_cfg.get('project_value_importance', 85))
    elif top == 'tools / accounts / environment notes':
        importance = max(importance, atomic_cfg.get('tools_default_importance', 52))

    atomic_tags = list(parent_tags)
    if key:
        atomic_tags.append(slugify(key))

    sensitivity = detect_sensitivity(bullet, atomic_tags, rules, title=' / '.join(section_path), kind_hint=kind)
    summary = bullet[:240]
    metadata = {
        'migration': MIGRATION_VERSION,
        'atomic': True,
        'parsed_key': key,
        'parsed_value': value,
    }

    return kind, importance, pinned, durable, sensitivity, visibility, summary, metadata, sorted(set(atomic_tags))


def build_long_term_records_v2(rules: dict) -> tuple[list[MemoryRecord], list[MemoryLink]]:
    text = MEMORY_MD.read_text(encoding='utf-8')
    records: list[MemoryRecord] = []
    links: list[MemoryLink] = []
    base_created = datetime.fromtimestamp(MEMORY_MD.stat().st_mtime, tz=timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

    for sec in split_memory_md_sections(text):
        section_path = sec['path']
        block = '\n'.join(sec['content_lines']).strip()
        if not block:
            continue

        title = ' / '.join(section_path)
        bullets = parse_bullets(block)
        parent_tags = [slugify(p) for p in section_path] + ['section-memory', 'imported']
        content = block
        scope, scope_key, mentions = infer_scope_and_mentions(title, section_path, content, rules)
        parent_kind, importance, pinned, durable, sensitivity, visibility = classify_long_term(section_path, title, content, parent_tags, rules)
        parent_id = f"mem_{slugify(title)}"
        summary = bullets[0][:240] if bullets else block.splitlines()[0][:240]
        metadata = {
            'migration': MIGRATION_VERSION,
            'source_file': 'MEMORY.md',
            'section_path': section_path,
            'bullet_count': len(bullets),
            'atomic_children': len(bullets),
            'record_role': 'section',
        }

        records.append(MemoryRecord(
            id=parent_id,
            created_at=base_created,
            updated_at=base_created,
            kind=parent_kind,
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
            checksum=sha256_text(f'MEMORY.md::{title}::{content}::{MIGRATION_VERSION}::section'),
            metadata_json=json.dumps(metadata, ensure_ascii=False),
            tags=sorted(set(parent_tags)),
            mentions=mentions,
        ))

        for idx, bullet in enumerate(bullets, start=1):
            atomic_id = f"{parent_id}__b{idx:03d}"
            atomic_title = f"{title} :: {bullet[:80]}"
            a_kind, a_importance, a_pinned, a_durable, a_sensitivity, a_visibility, a_summary, a_metadata, atomic_tags = classify_atomic_bullet(
                section_path, bullet, parent_kind, parent_tags, rules
            )
            a_mentions = list(mentions)
            bullet_scope, bullet_scope_key, bullet_mentions = infer_scope_and_mentions(atomic_title, section_path, bullet, rules)
            if bullet_scope != 'global':
                scope_use, scope_key_use = bullet_scope, bullet_scope_key
            else:
                scope_use, scope_key_use = scope, scope_key
            for mention in bullet_mentions:
                if mention not in a_mentions:
                    a_mentions.append(mention)

            records.append(MemoryRecord(
                id=atomic_id,
                created_at=base_created,
                updated_at=base_created,
                kind=a_kind,
                status='active',
                scope=scope_use,
                scope_key=scope_key_use,
                visibility=a_visibility,
                sensitivity=a_sensitivity,
                title=atomic_title,
                content=bullet,
                content_format='markdown',
                summary=a_summary,
                importance=a_importance,
                confidence=1.0,
                pinned=a_pinned,
                durable=a_durable,
                source_type='file',
                source_ref='MEMORY.md',
                source_excerpt=bullet[:240],
                author_type='assistant',
                author_id='yuki',
                session_id=None,
                parent_memory_id=parent_id,
                checksum=sha256_text(f'MEMORY.md::{title}::{bullet}::{idx}::{MIGRATION_VERSION}::atomic'),
                metadata_json=json.dumps({
                    **a_metadata,
                    'source_file': 'MEMORY.md',
                    'section_path': section_path,
                    'bullet_index': idx,
                    'record_role': 'atomic-bullet',
                }, ensure_ascii=False),
                tags=atomic_tags,
                mentions=a_mentions,
            ))

            links.append(MemoryLink(
                id=f"lnk_{atomic_id}_to_{parent_id}",
                from_memory_id=atomic_id,
                to_memory_id=parent_id,
                relation='belongs_to',
                weight=1.0,
                created_at=base_created,
                metadata_json=json.dumps({'migration': MIGRATION_VERSION}, ensure_ascii=False),
            ))
            links.append(MemoryLink(
                id=f"lnk_{parent_id}_to_{atomic_id}",
                from_memory_id=parent_id,
                to_memory_id=atomic_id,
                relation='has_part',
                weight=1.0,
                created_at=base_created,
                metadata_json=json.dumps({'migration': MIGRATION_VERSION}, ensure_ascii=False),
            ))

    return records, links


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


def build_daily_records(rules: dict) -> tuple[list[dict], list[MemoryRecord]]:
    sessions = []
    records: list[MemoryRecord] = []
    daily_cfg = rules.get('daily_rules', {})

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
                'metadata_json': json.dumps({'migration': MIGRATION_VERSION, 'source_file': rel}, ensure_ascii=False),
            })
            body = text.strip()
            title = f"Session summary: {path.stem}"
            tags = ['daily-note', 'session-summary', 'imported']
            mentions = [tuple(m) for m in daily_cfg.get('session_summary_mentions', [])]
            records.append(MemoryRecord(
                id=f"mem_{slugify(path.stem)}",
                created_at=stat_time,
                updated_at=stat_time,
                kind='summary',
                status='active',
                scope='session',
                scope_key=sid,
                visibility='private',
                sensitivity=detect_sensitivity(body, tags, rules, title=title, kind_hint='summary'),
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
                checksum=sha256_text(f'{rel}::{body}::{MIGRATION_VERSION}'),
                metadata_json=json.dumps({'migration': MIGRATION_VERSION, 'kind_hint': 'session-summary'}, ensure_ascii=False),
                tags=tags,
                mentions=mentions,
            ))
        else:
            title = f"Daily notes: {path.stem}"
            body = text.strip()
            tags = ['daily-note', 'imported']
            mentions = []
            lower = body.lower()
            for mention_rule in daily_cfg.get('daily_note_content_mentions', []):
                if any(token.lower() in lower for token in mention_rule.get('match_any', [])):
                    mentions.append(tuple(mention_rule['mention']))
            records.append(MemoryRecord(
                id=f"mem_{slugify(path.stem)}",
                created_at=stat_time,
                updated_at=stat_time,
                kind='note',
                status='active',
                scope='chat',
                scope_key='telegram:8241756142',
                visibility='private',
                sensitivity=detect_sensitivity(body, tags, rules, title=title, kind_hint='note'),
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
                checksum=sha256_text(f'{rel}::{body}::{MIGRATION_VERSION}'),
                metadata_json=json.dumps({'migration': MIGRATION_VERSION, 'kind_hint': 'daily-note'}, ensure_ascii=False),
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

    event_id = f"evt_{record.id}_migrated_v2"
    con.execute(
        '''
        INSERT INTO memory_events (
            id, memory_id, event_type, created_at, session_id, actor_type, actor_id, details_json
        ) VALUES (?, ?, 'created', ?, ?, 'assistant', 'markdown-migrator-v2', ?)
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
            json.dumps({'migration': MIGRATION_VERSION, 'source_ref': record.source_ref}, ensure_ascii=False)
        )
    )


def upsert_link(con: sqlite3.Connection, link: MemoryLink):
    con.execute(
        '''
        INSERT INTO memory_links (
            id, from_memory_id, to_memory_id, relation, weight, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            relation=excluded.relation,
            weight=excluded.weight,
            created_at=excluded.created_at,
            metadata_json=excluded.metadata_json
        ''',
        (link.id, link.from_memory_id, link.to_memory_id, link.relation, link.weight, link.created_at, link.metadata_json)
    )


def migrate(db_path: Path, rules: dict, dry_run: bool = False):
    long_term_records, links = build_long_term_records_v2(rules)
    sessions, daily_records = build_daily_records(rules)
    all_records = long_term_records + daily_records

    summary = {
        'rules_version': rules.get('version'),
        'sessions': len(sessions),
        'records_total': len(all_records),
        'long_term_records': len(long_term_records),
        'daily_records': len(daily_records),
        'links_total': len(links),
        'atomic_records': sum(1 for r in long_term_records if r.parent_memory_id is not None),
        'section_records': sum(1 for r in long_term_records if r.parent_memory_id is None),
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
            for link in links:
                upsert_link(con, link)
    finally:
        con.close()

    return summary


def main():
    parser = argparse.ArgumentParser(description='Migrate OpenClaw markdown memory into SQLite memory DB with atomic bullet rows.')
    parser.add_argument('--db', default=str(DB_PATH), help='Path to SQLite DB')
    parser.add_argument('--rules', default=str(DEFAULT_RULES_PATH), help='Path to migration rules JSON')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be migrated without writing')
    args = parser.parse_args()

    rules = load_rules(Path(args.rules))
    result = migrate(Path(args.db), rules=rules, dry_run=args.dry_run)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
