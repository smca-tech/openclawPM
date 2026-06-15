# OpenClaw Memory Prototype

This directory contains a concrete SQLite prototype for OpenClaw-style persistent memory.

## Files

- `schema.sql` - schema, indexes, FTS5 tables, and triggers
- `migrate_markdown_memory.py` - original markdown importer
- `migrate_markdown_memory_v2.py` - atomic-bullet importer with externalized rules
- `migration_rules.json` - configurable migration/classification rules
- `memory_manager.py` - recall/write prototype
- `recall_presets.json` - configurable recall preset routing
- `write_heuristics.json` - configurable write-path heuristics
- `config_schemas.mjs` - Zod schemas for prototype JSON configs
- `validate_config.mjs` - JSON config validator entrypoint
- `demo_memory_manager.py` - demo CLI for hydration/writes

## Notes

- The SQLite DB file is intentionally **not** stored in this repo prototype folder.
- SQLite `foreign_keys` must be enabled per connection:

```sql
PRAGMA foreign_keys = ON;
```

- Recommended connection setup:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

## Externalized rules

`migrate_markdown_memory_v2.py` now reads `migration_rules.json` for:

- reserved section names
- project scope detection
- sensitivity rules
- section kind mapping
- section importance/pin defaults
- atomic bullet classification
- daily/session mention rules

`memory_manager.py` now reads `recall_presets.json` for:

- preset bucket routing
- bucket order and merge bonuses
- scoped importance thresholds
- visibility modes (`all`, `respect_context`, `normal_only`)
- per-strategy limits
- allowed kinds/scopes
- entity recall shaping
- recent recall limits

`memory_manager.py` now also reads `write_heuristics.json` for:

- runtime memory ID prefix/hash length
- checksum/dedupe inputs
- summary length
- default visibility/content format
- event metadata defaults
- supersede status/link behavior
- update merge/replace behavior for tags and mentions
- update event defaults

Run dry-run migration with default rules:

```bash
python3 working/memory-prototype/migrate_markdown_memory_v2.py --dry-run
```

Run with a custom rules file:

```bash
python3 working/memory-prototype/migrate_markdown_memory_v2.py --rules /path/to/rules.json --dry-run
```

## Tests

Prototype tests now live in the repo test tree and run through a lightweight dedicated Vitest lane:

- `test/migration-rules-prototype.test.ts`
- `test/memory-manager-prototype.test.ts`
- `test/vitest/vitest.memory-prototype.config.ts`

They cover:

- baseline migration summary stability
- row-level migration classification behavior
- config-driven migration rule changes
- config-driven recall preset routing, thresholds, and filters
- config-driven write heuristics
- write dedupe, tags, mentions, supersede, and update lifecycle behavior
- invalid config rejection for migration, recall, and write config files
