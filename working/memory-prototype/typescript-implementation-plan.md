# TypeScript-Native Implementation Plan for Persistent Memory

## Goal

Move the current Python/SQLite memory prototype toward a first-class TypeScript implementation inside `openclawPM`, while preserving:

- correctness
- inspectability
- low operational overhead
- configurable policy surfaces
- testability

This plan assumes the current prototype is a design and behavior reference, not the final runtime artifact.

---

## Architectural direction

### Recommended source-of-truth location

Primary implementation should live under:

- `src/memory/`

Potential supporting surfaces:

- `src/commands/migrate/` for migration commands
- `src/cli/` or `src/commands/` for user-facing memory tooling
- `packages/memory-host-sdk/` only if parts of the memory API should be shared as a formal SDK boundary

### High-level split

Recommended TypeScript module split:

1. `src/memory/schema/`
   - DB schema creation
   - migrations
   - FTS setup
   - pragma setup

2. `src/memory/config/`
   - migration rule config loader/validator
   - recall preset config loader/validator
   - write heuristic config loader/validator
   - default config resolution

3. `src/memory/store/`
   - low-level SQLite access
   - typed row mappers
   - transaction helpers
   - query execution boundary

4. `src/memory/import/`
   - markdown memory importer
   - atomic section/bullet expansion
   - migration orchestration

5. `src/memory/recall/`
   - startup hydration
   - preset resolution
   - ranking/merge logic
   - entity recall
   - recent recall

6. `src/memory/write/`
   - remember
   - update_memory
   - supersede_memory
   - get_memory_version
   - read_for_update
   - event logging

7. `src/memory/search/`
   - FTS query path
   - hybrid search integration later if desired

8. `src/memory/testing/`
   - fixture helpers
   - temp DB builders
   - seed loaders

---

## Recommended implementation phases

## Phase 1: Port the storage and lifecycle core

Port first:

- schema creation
- DB connection/pragma management
- remember
- update_memory
- supersede_memory
- get_memory_version
- read_for_update
- event logging

Why first:

- this is the correctness-critical core
- it defines lifecycle semantics
- everything else depends on it

### Suggested files

- `src/memory/store/memory-db.ts`
- `src/memory/store/memory-schema.ts`
- `src/memory/write/memory-writer.ts`
- `src/memory/write/memory-versioning.ts`
- `src/memory/write/memory-events.ts`

---

## Phase 2: Port config loading and validation

Replace Python JSON loaders with TypeScript-native config loading using repo-standard validation.

### Recommended approach

Use Zod, since it already exists in the repo.

Suggested config files:

- `src/memory/config/migration-rules-schema.ts`
- `src/memory/config/recall-presets-schema.ts`
- `src/memory/config/write-heuristics-schema.ts`
- `src/memory/config/load-memory-config.ts`

### Config storage options

Short-term:

- keep JSON files in a prototype/default config location

Long-term:

- move defaults into TypeScript constants or shipped JSON assets
- support user overrides from OpenClaw config

Recommended long-term model:

- validated config object assembled from:
  - built-in defaults
  - optional user overrides
  - optional agent-specific overrides

---

## Phase 3: Port recall engine

Port the current preset-driven hydration behavior into TypeScript.

### Suggested files

- `src/memory/recall/memory-recall-engine.ts`
- `src/memory/recall/memory-preset-router.ts`
- `src/memory/recall/memory-ranking.ts`
- `src/memory/recall/memory-entity-query.ts`

### Key contract to preserve

- preset-driven bucket routing
- threshold/filter semantics from config
- deterministic merge ranking
- explicit handling of secret vs normal visibility

---

## Phase 4: Port markdown migration/import

Port the current importer logic after the core runtime exists.

### Suggested files

- `src/memory/import/import-memory-markdown.ts`
- `src/memory/import/import-memory-sections.ts`
- `src/memory/import/import-memory-bullets.ts`
- `src/memory/import/import-memory-daily-notes.ts`

### Why later

The importer is important, but runtime correctness matters more than migration elegance.

---

## Phase 5: CLI and command integration

Expose the new system through repo-native commands instead of standalone scripts.

### Likely command surfaces

- memory migrate/import
- memory validate-config
- memory hydrate-preview
- memory search
- memory inspect <id>

### Suggested homes

- `src/commands/migrate/`
- `src/commands/status-all/` if any diagnostics belong there
- `src/cli/` / `src/commands/` for direct invocation

---

## SQLite integration notes

## DB library choice

Recommended:

- a synchronous SQLite driver if already accepted by repo architecture and process model
- otherwise a thin async wrapper around a stable SQLite package

Selection criteria:

- reliability over cleverness
- WAL support
- FTS5 support
- good transaction support
- easy test setup

### Preserve these behaviors

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`

---

## Data model guidance

The current schema is good enough to keep as the first TS target.

Do not redesign everything during port.

Port first:

- `memories`
- `memory_tags`
- `memory_links`
- `memory_mentions`
- `memory_events`
- `session_runs`
- `memories_fts`

Only change schema where the current tests expose a clear flaw.

---

## Concurrency/versioning guidance

Keep the new revision-based optimistic concurrency model.

### TypeScript contract should expose

- `getMemoryVersion(memoryId)`
- `readForUpdate(memoryId)`
- `updateMemory(memoryId, { expectedVersion, ...patch })`

Avoid hiding version checks.

For developer users, explicit optimistic concurrency is the correct posture.

---

## Config strategy recommendation

The current prototype now has three config surfaces:

- migration rules
- recall presets
- write heuristics

In TypeScript, these should become a unified validated config model, probably something like:

- `MemoryConfig`
  - `migration`
  - `recall`
  - `write`

Long-term recommendation:

- support defaults in code
- allow override from config files
- validate once at startup
- pass typed config to memory services

---

## Testing strategy

## Keep the lightweight test lane concept

Do not force this work into the heaviest monorepo test pipeline while it is still evolving.

Recommended test layers:

1. unit tests for config validation
2. unit tests for writer lifecycle
3. unit tests for recall presets
4. unit tests for importer classification
5. integration tests using temp SQLite DBs

### Test files to preserve conceptually

Current prototype coverage already gives a strong map:

- migration rule behavior
- row-level classification
- recall preset behavior
- write dedupe/update/supersede behavior
- optimistic concurrency
- invalid config rejection

The TypeScript port should preserve those same behavioral assertions.

---

## Migration path from prototype

## Short-term

Keep Python prototype as behavior reference while porting TS modules one slice at a time.

## Mid-term

Once TS implementation covers:

- config loading
- remember/update/supersede
- recall presets
- migration importer

then:

- compare TS outputs to prototype outputs on the same fixture corpus
- use fixture parity tests where possible

## End-state

Retire the Python prototype from active use.
Keep only:

- docs/reference notes
- parity fixtures if helpful

---

## Recommended near-term sequence

1. Port config schemas/loaders to TypeScript
2. Port memory writer lifecycle to TypeScript
3. Port recall preset engine to TypeScript
4. Port importer/migration logic to TypeScript
5. Add CLI/command integration
6. Deprecate the Python prototype

---

## Risks to avoid

### 1. Redesigning while porting

Do not mix “port” and “invent new system” unless tests force it.

### 2. Hiding policy in code again

The whole point of the recent prototype work was to pull policy into config.
Preserve that.

### 3. Letting update semantics weaken

Keep explicit optimistic concurrency.
Do not fall back to silent last-write-wins.

### 4. Making the runtime depend on heavyweight test/build flows

The prototype taught us this already. Keep the memory test lane lean.

---

## Recommended first TypeScript implementation target

If starting immediately, the best first real module is:

- `src/memory/write/memory-writer.ts`

because it covers:

- remember
- update_memory
- supersede_memory
- version helpers
- event logging

and gives the rest of the system a solid lifecycle core to build on.

---

## Bottom line

The TypeScript-native version should be built as a real subsystem under `src/memory/`, with:

- SQLite storage
- Zod-validated config
- explicit lifecycle APIs
- preset-driven recall
- revision-based optimistic concurrency
- importer/migration as a separate layer

Do not just transliterate the Python files one-to-one.
Port the behavior, but express it in repo-native module boundaries.
