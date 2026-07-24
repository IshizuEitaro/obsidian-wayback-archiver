# Plugin load-time measurements

The production bundle was built with Node.js 24.17.0 and pnpm 10.32.1 on 2026-07-22.
Startup stopwatch measurements require an interactive Obsidian session and remain a release-checklist item; no synthetic values are substituted for them.

| Measurement | Before | After |
| --- | ---: | ---: |
| Production `main.js` bytes | 201,291 | 101,341 |
| Obsidian startup plugin time run 1 (ms) | Manual measurement required | Manual measurement required |
| Obsidian startup plugin time run 2 (ms) | Manual measurement required | Manual measurement required |
| Obsidian startup plugin time run 3 (ms) | Manual measurement required | Manual measurement required |
| Median startup plugin time (ms) | Manual measurement required | Manual measurement required |

## Reproduction

1. Run `pnpm build` and record `(Get-Item -LiteralPath main.js).Length`.
2. Install that production bundle in the same vault with the same enabled plugins.
3. Open Settings → General → Advanced → Startup time, reload Obsidian three times, and record the Wayback Archiver duration.
4. Repeat once with an empty pending queue and once with one pending archive.
5. Use the median of each three-run set.

The automated lifecycle tests verify that pending polling is deferred until layout ready, an empty queue retains no timer, a newly queued entry wakes the scheduler, and unload prevents deferred startup.
