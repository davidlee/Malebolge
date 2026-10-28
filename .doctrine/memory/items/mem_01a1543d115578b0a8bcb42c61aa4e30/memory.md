Under `src/`, the runner (`src/runner/`, entered via `src/runner-main.ts`) imports a set of shared top-level modules: `context`, `fields`, `grep`, `json`, `message-of`, `models`, `ndjson`, `project-context`, `registry`, `toolsets` and `unix-socket` (plus `room/` modules). No file outside `runner/` imports from it except `runner-main.ts`.

Nothing in the tree marks these modules as the runner contract; the set is only discoverable by tracing imports. The original 12-of-26 count (RV-001) is not reproduced here: `src/*.ts` now has 42 files.
