# DraftBoard — Fantasy Football Draft Planner

DraftBoard is a configurable 2026 cheat sheet, snake/mock/live-draft assistant, and auction planner. It combines Sleeper projections and format-specific ADP with optional ESPN PPR ADP, then computes league-scored projections, first-undrafted replacement value, tiers, and explainable recommendations.

## Run and verify

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
npm run release:check
```

`release:check` runs lint, offline unit tests, a production build, starts the production server on a temporary port, validates `/api/players`, and stops the server. Deployment is intentionally separate.

## Features

- Custom PPR/Half/Standard/TE-premium scoring and configurable FLEX/SUPERFLEX rosters.
- VOLS/VORP rankings with one consistent definition: replacement is the first undrafted player.
- Format-safe market values: Sleeper's selected format is authoritative; ESPN supplements PPR only.
- Snake/mock drafts with true snake keepers, traded-pick ownership, roster-valid seeded CPU teams, pick-cost grades, persistent targets/avoids/notes, tier cliffs, runs, and next-pick survival context.
- Read-only Sleeper live sync through documented REST polling. There is no unofficial streaming protocol.
- Auction planning with $1-per-open-slot reserves, hard maximum bids, roster capacity checks, team-specific inflation, and dollars-per-slot guidance.
- Raw 2025 historical stats scored with the active league settings.
- Versioned browser-storage envelopes and shared server/CDN caching for normalized player responses.

## Architecture

| Area | Files |
| --- | --- |
| Ranking/scoring | `lib/scoring.ts`, `lib/vbd.ts`, `lib/market.ts`, `lib/risk.ts` |
| Draft domain | `lib/draft.ts`, `components/MockDraft.tsx`, `components/DraftBoardGrid.tsx` |
| Auction domain | `lib/auction.ts`, `components/AuctionDraft.tsx` |
| Persistence/input | `lib/persistence.ts`, `lib/validation.ts`, `lib/annotations.ts`, `components/useLocalStorage.ts` |
| Player data | `lib/sleeper.ts`, `lib/espn.ts`, `app/api/players/route.ts` |
| Regression suite | `tests/domain.test.ts` |

The raw Sleeper responses exceed Next's fetch-cache item limit, so they are normalized first. The API payload is cached in the Next Data Cache and returned with explicit shared CDN freshness/staleness headers. Optional ESPN/history failures degrade independently.

See [METHODOLOGY.md](METHODOLOGY.md) for formulas, examples, and limitations, and [ROADMAP.md](ROADMAP.md) for the implementation history and acceptance gates.

## Browser storage

Current `ffdp.*` values are stored in a versioned `{ version, data }` envelope. Legacy unversioned values migrate on read. Player annotations are keyed by season and player ID so they do not leak into a later player pool.

## Known approximations

CPU behavior, survival probability, auction inflation, tiers, recommendations, and risk are decision aids—not forecasts. Each uses deterministic inputs and exposes the factors available in the UI. Bye weeks remain a season-maintained static data source.
