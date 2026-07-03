# openclawPM memory migration map

## Goal

Move `openclawPM` project memory out of mixed markdown-only continuity and into a queryable SQLite-backed slice that can validate future memory-routing and write-path work.

This document is deliberately narrower than a full workspace-memory migration. It defines the first project-specific migration target and the checks we should use to decide whether the imported data is good enough to support additional implementation work.

## Why this project goes first

`openclawPM` already has all the useful ingredients:

- a local project history in workspace markdown memory
- a prototype markdown -> SQLite importer
- a live SQLite database with existing imported rows
- active memory-tool work in the repo

That makes it the right pilot for validating:

- project anchoring
- long-term vs daily-note promotion
- project timeline recall
- secret handling boundaries
- future `routeMemoryWrite()` routing decisions

## Current source of truth

For the pilot, there are three relevant sources.

### 1. Long-term markdown memory

- Workspace file: `/home/smca-tech/.openclaw/workspace/MEMORY.md`
- Relevant section: `Ongoing Projects / openclawPM`

What it currently contains:

- project description
- local folder
- repo URL
- project board URL
- cutover history
- memory-search workaround history
- Capy packaging history

### 2. Daily markdown notes with project history

Workspace files already known to mention `openclawPM`:

- `/home/smca-tech/.openclaw/workspace/memory/2026-06-05.md`
- `/home/smca-tech/.openclaw/workspace/memory/2026-06-08.md`
- `/home/smca-tech/.openclaw/workspace/memory/2026-06-12.md`
- `/home/smca-tech/.openclaw/workspace/memory/2026-06-15.md`
- `/home/smca-tech/.openclaw/workspace/memory/2026-06-17.md`
- `/home/smca-tech/.openclaw/workspace/memory/2026-06-18.md`
- `/home/smca-tech/.openclaw/workspace/memory/2026-07-01.md`

These files contain the actual project timeline that matters for future validation work:

- migration direction changes
- forward-port workspace creation
- failed cutover notes
- recovery path
- packaging/build breadcrumbs
- “reference only” project-status shift

### 3. Existing SQLite import target

- SQLite DB: `/home/smca-tech/.openclaw/workspace/memory-db/openclaw-memory.sqlite`
- Prototype importer: `working/memory-prototype/migrate_markdown_memory_v2.py`
- Prototype rules: `working/memory-prototype/migration_rules.json`

## Current observed DB state

Observed on 2026-07-03 from the existing SQLite DB:

- `memories`: 62
- `memory_links`: 96
- `memory_mentions`: 26
- `memory_tags`: 233

Observed `openclawPM` project-scoped rows:

- scope `project`
- scope key `openclawPM`
- row count `5`
- all current rows are `kind='project'`

What that means:

- the current DB already imported the `MEMORY.md` `openclawPM` section and its atomic bullets
- the current DB does **not yet represent** the broader `openclawPM` project timeline from daily notes as project-scoped rows

That gap matters. The current import proves the plumbing works, but it is not enough data to validate project-history routing or recall quality.

## Pilot migration target

The pilot should produce a coherent `openclawPM` project memory slice in SQLite with three layers.

### Layer 1: project identity

Import or preserve durable project identity rows such as:

- description
- local folder
- repo URL
- project board URL

These are already present and should remain stable.

### Layer 2: project history

Promote durable `openclawPM` facts from daily notes into project-scoped rows, especially:

- cutover failure on 2026-06-17
- failed `2026.6.6` switch and recovery path
- snapshot-based recovery detail
- memory-search workaround and `fts-only` fallback
- forward-port workspace creation
- Capy packaging fix and tarball output path
- later decision to stop treating `openclawPM` as the implementation base

This layer is the real reason for the pilot.

### Layer 3: provenance and validation metadata

Each imported row should remain traceable to source markdown via:

- `source_ref`
- `source_excerpt`
- `metadata_json`
- project mention rows in `memory_mentions`

If provenance disappears, the migration becomes a trust problem.

## Non-goals for the pilot

Do not try to solve everything in this pass.

Out of scope for the first `openclawPM` migration map:

- migrating all workspace projects
- moving raw credentials into SQLite
- replacing `MEMORY.md` as canonical immediately
- inferring perfect project facts from every daily note sentence
- redesigning the whole memory schema

## What needs to change

The current prototype importer is good at:

- section import from `MEMORY.md`
- atomic bullet expansion
- stable project detection for explicit `openclawPM` section content

The current prototype importer is weak at:

- extracting project-history facts from daily-note blobs
- assigning project scope to those extracted facts
- distinguishing durable project history from transient chatter

So the next implementation step should not be “import more markdown blindly.”

It should be:

1. define the `openclawPM` source set
2. identify durable project-history facts from that set
3. import those facts as separate project-scoped rows
4. validate the resulting SQLite slice with fixed queries

## Proposed migration phases

### Phase 0: baseline capture

Capture the current DB state before changing import behavior.

Baseline checks:

- total row counts
- current `openclawPM` row counts
- current `openclawPM` links
- current `openclawPM` mention coverage

### Phase 1: source inventory

Treat the following as the initial `openclawPM` source set:

- `MEMORY.md` `Ongoing Projects / openclawPM`
- daily-note files that mention `openclawPM`
- future project-history notes that explicitly mention the forward-port tree or `openclawPM`

### Phase 2: promotion rules for daily notes

Add narrow rules that promote daily-note facts into project-scoped rows only when:

- `openclawPM` is explicitly mentioned
- the note describes a durable project fact
- the note would help explain code, packaging, deployment, migration, or delivery history later

Examples that should promote:

- “cutover failed”
- “recovered from snapshot”
- “forward-port workspace created”
- “packaging fix required import of X”
- “switched project status to donor/reference only”

Examples that should not promote:

- transient task status
- generic “worked on memory”
- reminders
- non-project personal context

### Phase 3: SQLite validation loop

After the importer changes, validate the DB using fixed queries, not intuition.

Success criteria for the pilot:

- `openclawPM` has more than the current 5 project rows
- imported project history spans the expected dates
- project history rows are queryable by `scope='project'` and `scope_key='openclawPM'`
- links and mentions remain intact
- no secrets were introduced into the project slice

### Phase 4: use the data to validate follow-up work

Once the slice is good enough, use it to validate:

- memory routing policy
- write heuristics for project-history promotion
- future `routeMemoryWrite()` observe-mode output
- retrieval quality for project-scoped recall

## SQL validation workflow

Use the companion SQL script:

- `working/memory-prototype/sql/openclawpm-migration-validation.sql`

That script is meant to answer:

- what exists now
- whether `openclawPM` history is actually present
- whether the imported rows still have provenance
- whether secret-shaped rows accidentally leaked into project scope

## Recommended operating workflow

For this pilot:

- keep workspace markdown as fallback canon
- treat SQLite as the validation target
- improve importer behavior until SQLite has a trustworthy `openclawPM` slice
- only then start relying on that slice for additional memory-system work

## Definition of done for the pilot

The `openclawPM` migration map is “good enough” when all of the following are true:

- the importer creates project-scoped rows for durable `openclawPM` history from both long-term memory and daily notes
- the validation SQL shows those rows clearly
- no raw secrets enter the `openclawPM` project slice
- future memory work can use SQLite queries to verify behavior instead of manually rereading markdown files
