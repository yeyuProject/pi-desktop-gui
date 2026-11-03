# macOS build and test isolation

- Use `npm run package` or `npm run package:dir`. Mac output belongs in `release/mac-builds.noindex/`; the packaging hook rejects indexed output directories.
- Keep every `.app` extracted for manual release verification or debugging under a real directory ending in `.noindex`, such as `work/mac-validation.noindex/`. This also applies to failed-test artifacts and temporary copies.
- Run automated tests against an isolated build with `PI_DESKTOP_DATA_DIR`, not the user's installed `/Applications/Pi Desktop.app`.
- After a packaged Mac test exits, use `unregisterMacTestApp` from `scripts/mac-builds.mjs`. Pass the owned `.noindex` root when testing outside the default build directory. Clean up only that test app's registration; never reset the system application database.
- Preserve the released application's bundle identifier, product name and signed bundle contents. The exclusion belongs to the build directory, not to the distributed app.
