# macOS build and test isolation

- Use `npm run package` or `npm run package:dir`. Mac output belongs in `release/mac-builds.noindex/`; the packaging hook rejects indexed output directories.
- Keep every `.app` extracted for manual release verification or debugging under a real directory ending in `.noindex`, such as `work/mac-validation.noindex/`. This also applies to failed-test artifacts and temporary copies.
- Run automated tests against an isolated build with `PI_DESKTOP_DATA_DIR`, not the user's installed `/Applications/Pi Desktop.app`.
- After a packaged Mac test exits, use `unregisterMacTestApp` from `scripts/mac-builds.mjs`. Pass the owned `.noindex` root when testing outside the default build directory. Clean up only that test app's registration; never reset the system application database.
- Preserve the released application's bundle identifier, product name and signed bundle contents. The exclusion belongs to the build directory, not to the distributed app.

# Handoff between agents

Reviews, questions and replies between agents (for example Claude reviewing and Codex implementing) go through files, so the user does not copy text between sessions.

- Use `work/handoff/` in the main checkout. From another worktree, the main checkout is the first path printed by `git worktree list`. The directory is ignored by Git; never commit it or copy it into a build.
- Before starting work, read the files in `work/handoff/` and pick up open items for your role.
- Write one Markdown file per topic, such as `work/handoff/UI18-UI20-review.md`. Name the author and the implementer at the top. Give each item an ID (`R1`, `R2`, …), a `file:line` location, a way to reproduce it, a suggested fix and a `状态` line starting at `待处理`.
- The implementer changes `状态` to `已修复（<commit> or 未提交）` or `不改：<reason>` and may add a `回复` line. Do not delete items or rewrite the other agent's text.
- When every item is handled, the implementer adds a line under `复审请求` with the date and commit. The reviewer then marks each item `已确认`, or sets it back to `待处理` with a note.
