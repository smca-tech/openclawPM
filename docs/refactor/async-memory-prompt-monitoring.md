# Async memory prompt split monitoring

## Goal

Track real-world behavior of the current memory prompt split for about 2 weeks before deciding whether full async end-to-end system prompt migration is necessary.

Current split:

- **Async path**: context-engine memory prompt assembly can include prompt-time recalled memory summaries
- **Sync path**: legacy full system prompt remains sync and only includes synchronously-available memory guidance

## Monitoring window

- Start: 2026-06-12
- Duration: ~2 weeks
- Decision target: after enough real usage examples are collected

## What to watch

### 1. Prompt quality

- Did a prompt-time memory hint appear when it should have?
- Was it relevant to the user’s request?
- Was it concise enough to help instead of distract?

### 2. Latency

- Did reply startup feel normal?
- Did recall-heavy turns feel slower than expected?
- Did fresh sessions show any noticeable warm-up penalty?

### 3. Behavior consistency

- Did the async context-engine path feel meaningfully better than the sync legacy path?
- Did the split create confusion or inconsistent answers?
- Did the same kind of task behave differently depending on which path handled prompt assembly?

### 4. Failure modes

- Missing memory hint when one was expected
- Irrelevant memory hint
- Duplicate guidance
- Prompt bloat / too much recalled context
- Startup delay or hang around memory recall
- Memory manager reuse/startup oddities

### 5. Operational stability

- Noisy logs
- Test/runtime regressions surfacing during normal use
- Strange cache/state behavior across sessions

## What to record per incident

Use a short entry with:

- Date/time
- Session or surface type
- User request summary
- Path involved (`async-context-engine`, `sync-full-system-prompt`, or `unknown`)
- Did memory hint appear? (`yes` / `no`)
- Was it helpful? (`yes` / `mixed` / `no`)
- Latency impression (`normal` / `slower` / `bad`)
- Notes

## Suggested log template

```md
### YYYY-MM-DD HH:MM

- Surface/session:
- Request:
- Path:
- Memory hint appeared:
- Helpfulness:
- Latency:
- Notes:
```

## Decision rules after monitoring window

### Keep split as-is

Use this if:

- prompt-time recall is helpful in the async path
- sync path is still good enough in practice
- no repeated confusion or operational instability shows up

### Migrate full system prompt to async end-to-end

Use this if:

- users repeatedly miss prompt-time recall in sync-only flows
- async path consistently performs better in meaningful ways
- the split causes repeated confusion, bugs, or maintenance overhead

### Rework or trim recall behavior

Use this if:

- hints are often noisy or irrelevant
- prompt-time recall causes noticeable latency or token bloat
- operational behavior is unstable

## Minimum evidence threshold

Before deciding, try to collect at least:

- 10 to 20 real usage examples
- a few recall-heavy cases
- a few fresh-session cases
- at least 2 or 3 examples where the split clearly mattered, if such examples occur
