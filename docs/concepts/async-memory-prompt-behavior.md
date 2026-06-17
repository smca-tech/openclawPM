# Async memory prompt behavior

## Purpose

The memory prompt stack now supports async prompt builders so prompt-time recall can pull a small indexed memory summary before model execution.

## Current split

### Async path

Use this path when you want prompt-time recalled memory content:

- `buildMemoryPromptSection(...)`
- `buildMemorySystemPromptAddition(...)`
- `extensions/memory-core/src/prompt-section.ts`

Characteristics:

- Supports `MemoryPromptSectionBuilder` returning `Promise<string[]>`
- Can call async memory manager APIs
- Can include prompt-time recall summaries derived from indexed memory hits
- Best fit for context engines and other async assembly paths

### Sync path

This path remains synchronous for compatibility:

- `buildAgentSystemPrompt(...)`
- `buildStaticMemoryPromptSection(...)`

Characteristics:

- Preserves existing synchronous runtime call sites
- Preserves broad existing test expectations
- Only includes synchronously-available prompt guidance
- Does **not** inject async prompt-time recall summaries yet

## Why the split exists

Converting the full system prompt path to async would require a larger runtime migration across multiple synchronous callers. The async context-engine path can adopt prompt-time recall immediately without forcing that broader refactor.

## What is validated vs not fully validated here

Validated in this change:

- async memory prompt builder contract
- async memory prompt aggregation
- async context-engine memory prompt addition path
- prompt-time recall summary injection in memory-core prompt assembly
- sync compatibility fallback for full system prompt assembly

Not fully validated from constrained shell runs alone:

- the full memory extension Vitest lane may hang or emit incomplete output in constrained environments

## Required validation for future changes

If you touch async memory prompt behavior again:

1. run targeted host-side tests for plugin memory state and context-engine prompt addition
2. run targeted memory-core prompt builder tests
3. rerun the memory extension Vitest lane in a normal local/dev environment if constrained-shell runs are noisy or hang
4. do not claim full validation until both the host-side path and extension lane have been checked

## Future follow-up

If prompt-time recalled memory must also appear in the legacy full system prompt path, convert `buildAgentSystemPrompt(...)` and its runtime callers to async end-to-end, then remove the static fallback split.
