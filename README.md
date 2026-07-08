# DraftBoard — Fantasy Football Draft Planner

A configurable pre-draft cheat sheet (à la Walter Picks), plus mock and auction
draft simulators. Pulls live player projections from Sleeper's free API,
enriches them with ESPN ADP and prior-season actuals, and computes **fantasy
points, VBD (value over replacement), and tiers** for *your* exact scoring and
roster settings.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000 (or next open port)
```

## What it does

- **Configurable scoring** — PPR / Half / Standard / TE-Premium presets, plus
  every stat value editable. Points are computed from raw stat projections, so
  any scoring system works.
- **Configurable roster** — teams, starters, FLEX, **SUPERFLEX**, bench.
- **K / DEF** — included using Sleeper's precomputed points (`pts_std`), since
  their scoring (FG distance, points-allowed tiers) doesn't fit the
  stat-based engine.
- **VBD done right** — replacement levels use greedy slot assignment, so FLEX
  and SUPERFLEX shift baselines correctly (QBs become premium in superflex; TEs
  rise in TE-premium). This is the part naive cheat sheets get wrong.
- **Tiers** — gap-based clustering per position.
- **Bye weeks** — 2026 team bye map baked in; shown inline per player.
- **ADP enrichment** — Sleeper ADP averaged with ESPN ADP for a consensus value
  column vs. rank; 7-day trend indicators (rising/falling) from a local ADP
  snapshot; a 2025 actual-points column alongside the projection.
- **Risk scores** — heuristic from injury status/notes and experience,
  sortable.
- **Player comparison modal** and a **Sleeper league import** (pulls a real
  league's scoring/roster settings, plus keeper/dynasty keep-lists, into the
  config).
- **Mock Draft tab** — CPU, manual, or live-sync (real Sleeper draft) modes;
  keepers, traded picks, custom team names, a post-draft letter grade vs. ADP,
  a watchlist, a full board grid view, a positional scarcity chart, CSV export.
- **Auction tab** — nomination/bidding flow with a suggested-bid tracker
  against remaining budget.
- **Draft tracker** — cross players off as they're taken; settings + drafted
  list persist in `localStorage`.

## Architecture

| File | Role |
|------|------|
| `lib/sleeper.ts` | Fetch + normalize Sleeper projections (memoized 12h); `SEASON` constant |
| `lib/sleeper-league.ts` | Sleeper user/league lookup; maps league scoring + roster settings onto our config; keeper/dynasty keep-list |
| `lib/espn.ts` | Fetch + normalize ESPN ADP (memoized 12h), fuzzy name matching |
| `lib/byes.ts` | 2026 team → bye week map |
| `lib/scoring.ts` | Raw stats → fantasy points for a scoring config |
| `lib/vbd.ts` | Greedy replacement levels, VBD, tiers, ranking |
| `lib/presets.ts` | Scoring/roster presets |
| `lib/types.ts` | Domain types: `Player`, `ScoringConfig`, `RosterConfig`, `RankedPlayer` |
| `app/api/players/route.ts` | Serves the normalized, enriched player pool (Sleeper + ESPN ADP + 2025 actuals) |
| `components/AppShell.tsx` | Tab switcher: Cheat Sheet / Mock Draft / Auction |
| `components/DraftBoard.tsx` | Cheat sheet: config-driven recompute, filters, cross-off, trends, risk, value-vs-ADP |
| `components/ConfigPanel.tsx` | Scoring/roster/VBD-method controls |
| `components/LeagueImport.tsx` | Sleeper league lookup UI, feeds `mapLeagueToConfig` |
| `components/PlayerCompare.tsx` | Side-by-side player comparison modal |
| `components/MockDraft.tsx` | Mock draft: CPU/manual/live modes, Sleeper draft import, keepers, traded picks, grading, CSV export |
| `components/DraftBoardGrid.tsx` | Full draft board grid view (round × team) |
| `components/ScarcityChart.tsx` | Positional scarcity chart used in the mock draft |
| `components/AuctionDraft.tsx` | Auction draft: nomination/bidding with suggested-bid tracker |
| `components/useLocalStorage.ts` | SSR-safe persisted state hook |

Data sources: Sleeper (`https://api.sleeper.com/projections/nfl/<season>` for
projections, `https://api.sleeper.app/v1` for users/leagues/drafts) and ESPN
(ADP). Season is set in `lib/sleeper.ts` (`SEASON`).

## Branching / CI

Features land on `dev` via PR (advisory fresh-context review). `dev` is
promoted to `test`, then `test` to `main`, each via a **blocking**
fresh-context review (`.github/workflows/promotion-review.yml`) plus a build/
typecheck check — both required by branch protection.
