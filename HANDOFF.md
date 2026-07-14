# DraftBoard — Maintainer Handoff

## Current state

DraftBoard is a Next.js 16.2.9 / React 19 / TypeScript application covering cheat-sheet, snake/mock/live REST sync, and auction workflows. The active data season is `2026` (`lib/sleeper.ts`); raw 2025 stats provide the comparison column. No deployment was performed.

Before changing Next.js APIs, read the relevant bundled guide in `node_modules/next/dist/docs/` as required by `AGENTS.md`.

## Maintenance commands

```bash
npm run dev
npm test
npm run test:coverage
npm run lint
npm run build
npm run release:check
```

The release command validates required Sleeper data, unique IDs, supported positions, season, and a non-empty pool. ESPN and history are optional and reported through source flags.

## Locked product semantics

- Replacement is the first undrafted player at a position.
- Sleeper's format-specific ADP is authoritative outside PPR; ESPN ADP supplements PPR only.
- Live sync is bounded, visibility-aware REST polling until Sleeper documents an official streaming protocol.
- Pick grades compare compatible market ADP with the actual acquisition pick; keepers are separate.
- Auction teams retain at least $1 for every remaining roster slot.
- Historical totals are recalculated from raw stats with active scoring.

## Data and caching

`/api/players` fetches Sleeper projections, ESPN PPR ADP, and Sleeper 2025 raw stats concurrently. Sleeper is required; optional sources degrade to empty maps. Normalized output uses the Next Data Cache for 12 hours and emits `s-maxage=43200, stale-while-revalidate=86400` for shared CDN reuse.

## Persistence

`useLocalStorage` reads/writes versioned envelopes through `lib/persistence.ts`. Existing keys migrate from their prior unversioned JSON shape. `ffdp.annotations` is season/player scoped and shared between cheat sheet and mock draft. Session-only Sleeper import state remains in `sessionStorage` because it contains transient draft connection context.

## Annual rollover

1. Change `SEASON` and historical endpoint/field labels in `lib/sleeper.ts` and `lib/types.ts`.
2. Refresh `lib/byes.ts` only from a confirmed schedule.
3. Run `npm run release:check` and inspect optional-source flags.
4. Update README/methodology examples if formulas or source contracts change.

See `METHODOLOGY.md` for reproducible formulas and `ROADMAP.md` for dependency and acceptance context.
