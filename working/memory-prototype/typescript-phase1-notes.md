# TypeScript Phase 1 Scaffold Notes

Implemented initial TypeScript-native scaffolding under `src/memory/`:

- `src/memory/types.ts`
- `src/memory/schema/memory-schema.ts`
- `src/memory/store/memory-db.ts`
- `src/memory/write/memory-versioning.ts`
- `src/memory/write/memory-writer.ts`

## Scope of this phase

This is a structural scaffold, not a fully wired production implementation yet.

It establishes:

- typed row/input contracts
- schema SQL home
- DB initialization helpers
- revision-based optimistic concurrency helpers
- a TS lifecycle writer surface for:
  - `remember`
  - `updateMemory`
  - `supersedeMemory`

## Important note

`memory-writer.ts` currently depends on an abstract `MemoryWriterStore` interface.

That is deliberate.

Next work should implement a concrete SQLite-backed store in TypeScript, then connect it to command/runtime surfaces.

## Recommended next steps after phase 1 scaffold

1. implement `MemoryWriterStore` against SQLite
2. add TS unit tests for `memory-writer.ts`
3. port config loaders/validators into `src/memory/config/`
4. port recall engine into `src/memory/recall/`
