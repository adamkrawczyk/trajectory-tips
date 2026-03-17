# Architecture Review

## Overview

`trajectory-tips` is a file-backed CLI for extracting, storing, retrieving, and injecting agent-memory tips.
The current structure is workable, but path resolution and dependency injection are inconsistent across the call graph, which leaks `process.cwd()` and environment state into tests and command behavior.

## Dependency Graph

- `bin/tips.js` -> `src/cli.js`
- `src/cli.js` -> `src/extract.js`, `src/analyzer.js`, `src/contrastive.js`, `src/inject.js`, `src/retrieve.js`, `src/store.js`, `src/utils.js`
- `src/extract.js` -> `src/embeddings.js`, `src/analyzer.js`, `src/utils.js`, `src/store.js`
- `src/inject.js` -> `src/retrieve.js`, `src/utils.js`
- `src/retrieve.js` -> `src/utils.js`, `src/embeddings.js`, `src/store.js`
- `src/store.js` -> `src/utils.js`, `src/embeddings.js`
- `src/seed.js` -> `src/utils.js`, `src/store.js`, `src/embeddings.js`
- `src/analyzer.js` -> `src/embeddings.js`
- `src/contrastive.js` -> `src/analyzer.js`, `src/embeddings.js`, `src/store.js`
- `test/*.test.js` mostly target public module exports directly; `test/add.test.js` and `test/cli.test.js` go through `createProgram()`

## Issue Inventory

### 1. Path resolution is only partially dynamic

- `src/utils.js`
  - `DEFAULT_TIPS_DIR` is computed at module load from `process.env.TIPS_DIR` or `process.cwd()`.
  - `DEFAULT_INDEX_PATH` is computed at module load from `process.cwd()`.
  - `getTipsDir()` still falls back to `DEFAULT_TIPS_DIR`, so changing cwd after import keeps a stale tips directory.
  - `getIndexPath()` is dynamic already, but the module still exports a stale `DEFAULT_INDEX_PATH`, so the path model is internally inconsistent.
- `src/store.js`
  - `saveTip()`, `loadIndex()`, `saveIndex()`, `consolidateTips()`, `reindexAllTips()`, and `recordFeedback()` default through `getTipsDir()` / `getIndexPath()`, so they inherit the stale `DEFAULT_TIPS_DIR` issue.
- `src/retrieve.js`
  - `queryTips()` defaults through `getTipsDir()` / `getIndexPath()`.
- `src/cli.js`
  - `addTipFromOptions()` resolves paths internally via `getTipsDir()` / `getIndexPath()` instead of accepting a shared context.
  - `list`, `health`, and every command that omits explicit paths rely on ambient cwd/env.
- `src/seed.js`
  - `seedBaseTips()` defaults `tipsDir` via `getTipsDir()`.
  - It bypasses helpers and hardcodes `path.resolve(process.cwd(), 'index.json')` for the index, which is another direct cwd dependency.

### 2. Test isolation is brittle

- `test/add.test.js`
  - Uses `process.chdir()` and `process.env.TIPS_DIR` to steer CLI outputs.
  - Imports `getIndexPath()` from `src/utils.js`, so assertions still depend on process-global state.
- `test/store.test.js` and `test/retrieve.test.js`
  - Already pass `tipsDir` / `indexPath` explicitly, which is the better pattern and should become standard.
- Current fake embedders are inconsistent
  - `test/store.test.js` still uses a 3-dimensional vector, which is too small and can collapse unrelated texts into high cosine similarity.
  - `test/add.test.js` already uses a 16-dimensional hash-spread embedder; that approach should be shared.

### 3. `createProgram()` DI stops at `add`

- `src/cli.js`
  - `createProgram()` accepts overrides for `addTip`, `embedder`, `promptForFields`, and `yaml`, but all other commands call hard imports directly.
  - `extract`, `query`, `inject`, `consolidate`, `feedback`, `import`, `reindex`, `seed`, `contrast`, `list`, and `health` all read ambient state and use concrete module functions instead of injected dependencies.
  - This makes command-level testing harder and prevents a single context from carrying `tipsDir`, `indexPath`, `embedder`, or service implementations.

### 4. Additional architectural debt worth tracking

- `src/cli.js` mixes command definition, formatting, path resolution, and execution wiring in one module.
- `src/extract.js`, `src/contrastive.js`, and `src/seed.js` call `saveManyTips()` / `loadIndex()` without a shared runtime context, so storage concerns are scattered.
- `src/seed.js` independently updates the index instead of delegating to store-layer save/reindex primitives.
- `src/store.js` still uses environment-derived model defaults internally, which keeps storage logic partially coupled to process state.
- Planned but not implemented: proactive tip seeding from skill metadata, already hinted by README issue references and explicitly requested here.

# Plan

Review the path and command wiring first, then drive the refactor through failing tests that remove cwd/env coupling and replace it with an explicit runtime context. The implementation should keep current behavior intact while making storage paths and embedders injectable across the full CLI surface.

## Scope
- In:
- Dynamic or injectable path resolution for tips and index files
- Consistent runtime context / DI through CLI commands and storage entry points
- Test refactor away from `process.chdir()` and fragile embedders
- Architecture findings and follow-up issue filing
- Out:
- Proactive skill-metadata seeding implementation
- Large command-module decomposition beyond what is needed for DI consistency

## Action items
[ ] Add failing tests that prove path defaults break when cwd changes after module import and that CLI commands should honor injected paths without `process.chdir()`.
[ ] Introduce a small runtime context helper that carries `tipsDir`, `indexPath`, `embedder`, and command implementation overrides through `createProgram()`.
[ ] Refactor store/retrieve/seed entry points to resolve paths from explicit options or the shared context instead of cached module-level defaults.
[ ] Update CLI command actions to use the same context for `add`, `extract`, `query`, `inject`, `list`, `consolidate`, `feedback`, `import`, `reindex`, `seed`, `contrast`, and `health`.
[ ] Replace test embedders with a shared 16+ dimensional hash-spread fake and migrate CLI tests to per-test temp paths instead of `process.chdir()`.
[ ] Run `node --test test/*.test.js` and `eslint src/ test/ bin/`, then inspect the diff for any behavior or API regressions before committing.
[ ] File GitHub issues for proactive skill-metadata seeding and any remaining architectural debt that should not be addressed in this refactor.

## Open questions
- Should the runtime context remain an internal CLI-only concept, or should it become a first-class public API for library consumers later?
- Should `seedBaseTips()` eventually reuse `saveTip()` / `saveManyTips()` to centralize index updates, or stay optimized for bootstrap copy semantics?
- Should model selection also move into the runtime context in a follow-up, to fully decouple storage/retrieval from process environment?
