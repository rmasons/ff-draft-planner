# DraftBoard — Fantasy Football Draft Planner

A configurable pre-draft cheat sheet (à la Walter Picks). Pulls live player
projections from Sleeper's free API and computes **fantasy points, VBD (value
over replacement), and tiers** for *your* exact scoring and roster settings.

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
- **VBD done right** — replacement levels use greedy slot assignment, so FLEX
  and SUPERFLEX shift baselines correctly (QBs become premium in superflex; TEs
  rise in TE-premium). This is the part naive cheat sheets get wrong.
- **Tiers** — gap-based clustering per position.
- **Draft tracker** — cross players off as they're taken; settings + drafted
  list persist in `localStorage`.

## Architecture

| File | Role |
|------|------|
| `lib/sleeper.ts` | Fetch + normalize Sleeper projections (memoized 12h) |
| `lib/scoring.ts` | Raw stats → fantasy points for a scoring config |
| `lib/vbd.ts` | Greedy replacement levels, VBD, tiers, ranking |
| `lib/presets.ts` | Scoring/roster presets |
| `app/api/players/route.ts` | Serves the normalized player pool |
| `components/DraftBoard.tsx` | Client board: config-driven recompute, filters, cross-off |

Data source: `https://api.sleeper.com/projections/nfl/<season>`. Season is set in
`lib/sleeper.ts` (`SEASON`).

## Not yet built (v1 scope)

- **K / DEF** — different scoring schema (FG distance, points-allowed tiers); use
  Sleeper's precomputed points when added.
- **Bye weeks** — `lib/byes.ts` is a stubbed static map; fill once the 2026 NFL
  schedule is final (left empty rather than guessing).
