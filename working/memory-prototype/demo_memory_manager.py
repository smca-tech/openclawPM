#!/usr/bin/env python3
import argparse
import json
from memory_manager import MemoryManager, build_default_session_context


def main():
    parser = argparse.ArgumentParser(description='Demo startup hydration and writes for the OpenClaw memory DB.')
    parser.add_argument('--db', default='memory-db/openclaw-memory.sqlite')
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--chat-id', default='telegram:8241756142')
    parser.add_argument('--user-id', default='8241756142')
    parser.add_argument('--user-key', default=None)
    parser.add_argument('--agent-key', default=None)
    parser.add_argument('--project-key', default=None)
    parser.add_argument('--include-secret', action='store_true')
    parser.add_argument('--preset', choices=['dm', 'group', 'project', 'admin'], default='dm')
    parser.add_argument('--write-demo', action='store_true')
    args = parser.parse_args()

    manager = MemoryManager(args.db)
    ctx = build_default_session_context(
        session_id=args.session_id,
        chat_id=args.chat_id,
        user_id=args.user_id,
        user_key=args.user_key,
        project_key=args.project_key,
        agent_key=args.agent_key,
        include_secret=args.include_secret,
        preset=args.preset,
        mentioned_entities=([('person', args.user_key)] if args.user_key else []) + ([('project', args.project_key)] if args.project_key else []),
    )

    manager.register_session(ctx, channel='telegram', title='demo-memory-manager')
    hydrate = manager.startup_hydrate(ctx)

    output = {
        'session_id': args.session_id,
        'include_secret': args.include_secret,
        'preset': args.preset,
        'counts': {k: len(v) for k, v in hydrate.items() if isinstance(v, list)},
        'merged_preview': [
            {
                'id': row['id'],
                'kind': row['kind'],
                'scope': row['scope'],
                'scope_key': row['scope_key'],
                'sensitivity': row['sensitivity'],
                'importance': row['importance'],
                'title': row['title'],
                'bucket': row.get('_bucket'),
            }
            for row in hydrate['merged'][:12]
        ]
    }

    if args.write_demo:
        memory_id = manager.remember(
            title='Demo runtime memory',
            content='This is a demo runtime memory written by demo_memory_manager.py',
            kind='note',
            scope='session',
            scope_key=args.session_id,
            session_id=args.session_id,
            source_type='tool',
            source_ref='demo_memory_manager.py',
            tags=['demo', 'runtime'],
            mentions=[('person', args.user_key, 'subject')] if args.user_key else [],
            importance=40,
            durable=False,
        )
        output['write_demo_memory_id'] = memory_id

    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
