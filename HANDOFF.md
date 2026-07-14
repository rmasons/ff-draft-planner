# DraftBoard — Maintainer Handoff

## Current state

> Working doc for a future Claude (or human) session picking up this project.
> Last updated: roadmap correctness pass (market/risk/persistence/validation
> engine work) reconciled with the parallel `dev` cluster fixes (PlayerCompare,
> ScarcityChart, shared UI/badge helpers, promotion pipeline docs).

DraftBoard is a Next.js 16.2.9 / React 19 / TypeScript application covering cheat-sheet, snake/mock/live REST sync, and auction workflows. The active data season is derived from today's date (`lib/sleeper.ts`, `SEASON`); raw 2025 stats provide the comparison column, scored under the active league settings. No deployment was performed.

Before changing Next.js APIs, read the relevant bundled guide in `node_modules/next/dist/docs/` as required by `AGENTS.md`.

## Location & git

- **Path:** `/Users/masonrussell/Development/ff-draft-planner`
- **GitHub remote:** `rmasons/ff-draft-planner` (origin, both fetch/push).
- **Branch model:** `dev → test → main` staged promotion. Feature work lands
  on `dev` via PR (advisory fresh-context review,
  `.github/workflows/claude-code-review.yml`). `dev` is promoted to `test`,
  then `test` to `main`, each via a PR gated by a **blocking** fresh-context
  review (`.github/workflows/promotion-review.yml`) plus a build/typecheck
  check (`.github/workflows/build.yml`) — both required by branch protection
  on `test` and `main`.
- **Never push directly to `test` or `main`** — always go through a PR so the
  blocking review runs.

## Stack

- Next.js **16.2.9** (App Router, Turbopack), React **19**, TypeScript, Tailwind **v4**.
- ⚠️ Next 16 ships an `AGENTS.md` warning of breaking changes; bundled docs live in
  `node_modules/next/dist/docs/`. Read those before using unfamiliar APIs.
- Tailwind v4 is CSS-based: `@import "tailwindcss"` + `@theme inline` in
  `app/globals.css` (no `tailwind.config.js`).

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

## Architecture

| File | Role |
|---|---|
| `lib/types.ts` | Domain types: `Player`, `ScoringConfig`, `RosterConfig`, `RankedPlayer`, `Position` (`QB/RB/WR/TE/K/DEF`) |
| `lib/sleeper.ts` | Fetch + normalize Sleeper projections; `SEASON` constant (derived from today's date); in-module 12h memo; raw 2025 stats fetch |
| `lib/sleeper-league.ts` | Sleeper user/league lookup; `mapLeagueToConfig` maps a league's scoring/roster settings onto our config; `fetchKeptPlayerIds` for keeper/dynasty leagues |
| `lib/espn.ts` | Fetch + normalize ESPN ADP (12h memo), fuzzy name matching (`normalizeName`, strips trailing Jr./Sr./II-IV suffixes) |
| `lib/byes.ts` | 2026 team → bye week static map (filled) |
| `lib/scoring.ts` | `fantasyPoints`/`fantasyPointsForStats` — raw stats → points under a scoring config; K/DEF use Sleeper's precomputed `pts_std` |
| `lib/vbd.ts` | VOR engine: greedy replacement levels, tiers, `rankPlayers()`; replacement is always the first undrafted player (all positions, including K/DEF) |
| `lib/market.ts` | `marketReference()`/`valueVsMarket()` — format-compatible consensus ADP (Sleeper authoritative outside PPR; ESPN supplements PPR only) and value-vs-market, shared by every screen |
| `lib/risk.ts` | `assessRisk()` — evidence-based risk score with explainable factors + a confidence level |
| `lib/draft.ts` | Snake-draft domain: pick/slot math, roster-slot assignment, CPU pick selection, grading, keeper value, positional runs, survival estimate, the draft status state machine |
| `lib/auction.ts` | Auction budget/legality/suggested-value math ($1-per-open-slot reserves, hard max bid) |
| `lib/annotations.ts` | Target/avoid/note annotations, keyed by season + player ID |
| `lib/validation.ts` | Bounds-checked scoring/roster config validation |
| `lib/persistence.ts` | Versioned `{ version, data }` browser-storage envelope, with migration from legacy unversioned shapes |
| `lib/ui.ts` | Shared Tailwind class maps for position badges/dots, used across every screen |
| `lib/presets.ts` | Scoring/roster presets + `adpKeyFor()` |
| `app/api/players/route.ts` | GET → normalized, enriched player pool as JSON (Sleeper + ESPN ADP + 2025 actuals, merged in parallel; ESPN/actuals failures are non-fatal); `unstable_cache` + shared CDN freshness headers |
| `components/AppShell.tsx` | Tab switcher: Cheat Sheet / Mock Draft / Auction |
| `components/DraftBoard.tsx` | Cheat sheet: config-driven recompute, filters, cross-off, ADP trend indicators, risk scores, value-vs-market column, target/avoid/note annotations, compare-mode trigger |
| `components/ConfigPanel.tsx` | Scoring/roster/VOR-method controls |
| `components/LeagueImport.tsx` | Sleeper league lookup UI → `mapLeagueToConfig` / keeper merge |
| `components/PlayerCompare.tsx` | Side-by-side player comparison modal (proj, 2025 actual, VOR, rank, market ADP/value, risk, bye, injury, age) |
| `components/MockDraft.tsx` (~2,100 lines — the biggest component by far) | CPU / manual / live-sync draft modes, Sleeper draft import (traded picks, team names, keepers), post-draft letter grade vs. market, target/avoid-aware watchlist, board grid + scarcity chart views, CSV export |
| `components/DraftBoardGrid.tsx` | Full draft board grid view (round × team), used inside Mock Draft |
| `components/ScarcityChart.tsx` | Positional scarcity chart (starters vs. depth remaining per position), used inside Mock Draft |
| `components/AuctionDraft.tsx` | Auction draft: nomination/bidding flow, suggested-bid tracker against remaining budget |
| `components/useLocalStorage.ts` | SSR-safe persisted state hook |

**Data flow:** `/api/players` fetches Sleeper projections, ESPN ADP, and 2025
actuals in parallel server-side (server-side fetch avoids CORS + the raw
Sleeper payload size) and merges them into one enriched player list. The
client fetches once, then `rankPlayers()` recomputes points/VOR/tiers in a
`useMemo` whenever scoring/roster/method changes — instant, no refetch.

### Sleeper API specifics

- Projections endpoint (`lib/sleeper.ts`, `SLEEPER_URL`):
  `https://api.sleeper.com/projections/nfl/{SEASON}?season_type=regular&order_by=pts_ppr`
  followed by a `&position[]=<pos>` for every entry in `ALL_POSITIONS`
  (`QB, RB, WR, TE, K, DEF`) — built with `.map(...).join("")`, not hand-typed.
- Returns per player: granular stat projections (`pass_yd/td/int/2pt`, `rush_yd/td`,
  `rec/rec_yd/rec_td/rec_2pt`, `fum_lost`, …) for skill positions, precomputed
  `pts_std` for K/DEF, ADP across formats (`adp_ppr`, `adp_half_ppr`, `adp_std`,
  `adp_2qb` = superflex), and embedded player metadata (name, position, team,
  exp, injury). **No bye weeks** — that's why `lib/byes.ts` exists as a static map.
- Draftable filter (`normalize()` in `lib/sleeper.ts`): exclude only if
  `pts_ppr <= 0 AND pts_std <= 0 AND adp_ppr >= 999` — i.e. keep a player if
  *any* of those three signals a real projection/market presence. This is what
  lets DEF through (DEF has `pts_std > 0` but `pts_ppr ≈ 0`).
- A separate endpoint, `https://api.sleeper.com/stats/nfl/2025` (same query
  shape), supplies raw 2025 stats (`fetch2025ActualStats`) so the client can
  score them under the *active* league settings instead of a fixed PPR total.
  It has its own 12h in-module memo, independent from the projections memo.
- Both the projections and 2025-stats raw responses are **~3MB+** — over Next's
  2MB fetch-cache limit. So both fetch with `cache: "no-store"` and **memoize
  the normalized result in-module for 12h** (`TTL_MS` in `lib/sleeper.ts`).
  Don't try `next: { revalidate }` on the raw fetch — it silently fails to cache.
- `SEASON` is derived from today's date in `lib/sleeper.ts` (year rolls over in
  March, so the offseason still reads as the prior season) — no manual bump
  needed season to season. `lib/byes.ts` still needs a manual refresh (see
  Annual rollover below).
- League/user/draft endpoints (`lib/sleeper-league.ts`, and the Sleeper draft
  import in `MockDraft.tsx`) live on a different base URL:
  `https://api.sleeper.app/v1` (note: `.app`, not `.com` — the projections/stats
  endpoints above are `.com`). Don't conflate the two hosts.
- The Mock Draft "Live Sync" mode polls Sleeper's documented REST API
  (`GET https://api.sleeper.app/v1/draft/{id}/picks` every 8 seconds, only
  while the tab is visible, mapping picks back to their true owner via traded-pick
  records). It flips to a `stale` status after repeated consecutive failures
  rather than erroring immediately on one dropped request. There is no
  officially documented streaming protocol, so this is REST polling only —
  don't reach for a WebSocket implementation here.

### VOR methodology (the core IP)

`rankPlayers(players, scoring, roster, method)` returns `{ players, baselines, method }`.

- **Replacement levels via greedy slot assignment** (`computeSkillBaselines` in
  `lib/vbd.ts`, skill positions only — QB/RB/WR/TE):
  1. Fill dedicated starter slots league-wide (`qb/rb/wr/te × teams`).
  2. Fill FLEX (`× teams`) from RB/WR/TE by best remaining projected points.
  3. Fill SUPERFLEX (`× teams`) from QB/RB/WR/TE the same way.
  - This is what makes flex/superflex correct: positions feeding flex get more
    starters drafted → deeper baseline. Superflex makes QBs premium; TE-premium
    raises TEs and reshuffles flex.
- **Two baseline methods (`BaselineMethod`):**
  - **VOLS** (default) — "Value Over Last Starter": baseline anchored at the
    first undrafted player past all starters.
  - **VORP** — "bench depth": after starters, fill `bench × teams` more slots,
    prioritized by **value-over-last-starter** (NOT raw points — otherwise high-raw
    QBs wrongly flood the bench in 1-QB leagues). Deeper baseline → rewards scarce
    positions.
- **Replacement is always the first undrafted player at a position — for
  every position, including K/DEF.** K/DEF use a simpler 1-starter-per-team
  index (no greedy flex assignment, since they don't feed FLEX/SUPERFLEX), and
  both `rank` and `points` come from that same single player, consistent with
  the skill-position baselines. They're always appended after all skill
  positions in overall rank, regardless of VBD, so draft advice stays
  conventional (skill positions before K/DEF).
- **Tiers:** gap-based per position — new tier when the drop to the next player
  exceeds `1.5× average gap` (top-40 window).
- VOR field on `RankedPlayer` is named `vbd` (legacy name; UI label is "VOR").

**Verified numbers (PPR, 12-team standard, skill positions):**
- VOLS baselines: `QB12 / RB24 / WR36 / TE12` (textbook last-starter).
- VORP baselines: `QB22 / RB41 / WR65 / TE28` — added depth `10+17+29+16 = 72 = bench(6)×teams(12)` ✓.

### localStorage keys

All prefixed `ffdp.` — grep `ffdp\.` across `components/` to enumerate if this
list drifts:
- `ffdp.scoring`, `ffdp.roster`, `ffdp.method` — shared config, read by all
  three tabs (Cheat Sheet, Mock Draft, Auction). Read/written through
  `lib/persistence.ts`'s versioned envelope.
- `ffdp.drafted` — cheat-sheet cross-off list.
- `ffdp.annotations` — target/avoid/note annotations, keyed by season + player
  ID, shared between the cheat sheet and mock draft. The Mock Draft watchlist
  is *derived* from this (players flagged "target") rather than its own key.
- `ffdp.adp-snapshot` — periodic ADP snapshot used to compute the 7-day trend
  indicators on the cheat sheet; tagged with the `adpKey` format it was seeded
  under so a scoring/roster format switch doesn't produce bogus trend arrows.
- `ffdp.draft-setup`, `ffdp.pending-keepers` — Mock Draft setup state
  (`sessionStorage`, since it's transient import/connection context).
- `ffdp.auction.wonPlayers`, `ffdp.auction.setup` — Auction tab state.

## Locked product semantics

- Replacement is the first undrafted player at a position — every position,
  including K/DEF.
- Sleeper's format-specific ADP is authoritative outside PPR; ESPN ADP supplements PPR only.
- Live sync is bounded, visibility-aware REST polling until Sleeper documents an official streaming protocol.
- Pick grades compare compatible market ADP with the actual acquisition pick; keepers are separate.
- Auction teams retain at least $1 for every remaining roster slot.
- Historical totals are recalculated from raw stats with active scoring.

## Data and caching

`/api/players` fetches Sleeper projections, ESPN PPR ADP, and Sleeper 2025 raw stats concurrently. Sleeper is required; optional sources degrade to empty maps. Normalized output uses the Next Data Cache for 12 hours and emits `s-maxage=43200, stale-while-revalidate=86400` for shared CDN reuse.

## Persistence

`useLocalStorage` reads/writes versioned envelopes through `lib/persistence.ts`. Existing keys migrate from their prior unversioned JSON shape. `ffdp.annotations` is season/player scoped and shared between cheat sheet and mock draft. Session-only Sleeper import state remains in `sessionStorage` because it contains transient draft connection context.

## Gotchas

- **`preview_start` MCP fails** with `EPERM: process.cwd ... uv_cwd` (sandbox can't
  spawn npm) in some environments. If browser screenshots aren't available, run
  the dev server via the **Bash** tool and verify with curl + `tsx` instead.
- If Claude in Chrome can't reach `localhost:3000` while `npm run dev` is
  running, it's usually a network-isolation mismatch between the shell that
  started the server and the browser process — use the LAN URL Next.js prints
  (`Network: http://<ip>:3000`, also whitelisted in `next.config.ts`
  `allowedDevOrigins`) instead of `localhost` (see project `CLAUDE.md`).
- A stray parent-directory `package-lock.json` can make Next infer the wrong
  workspace root → fixed by pinning `turbopack.root: __dirname` in
  `next.config.ts`. Keep that.
- Dark theme is forced in `app/globals.css` (`:root` = zinc-950/zinc-50), not
  `prefers-color-scheme`.
- Clean up any background dev servers you start (`lsof -ti tcp:3000 | xargs kill`,
  adjust port as needed).
- The Sleeper projections host is `api.sleeper.com`; the users/leagues/drafts
  host is `api.sleeper.app` — easy to typo one for the other.

## Annual rollover

1. `lib/byes.ts` needs a fresh bye-week map from a confirmed schedule (`SEASON`
   itself now rolls over automatically from today's date, see Sleeper API
   specifics above).
2. Run `npm run release:check` and inspect optional-source flags.
3. Update README/methodology examples if formulas or source contracts change.

See `METHODOLOGY.md` for reproducible formulas and `ROADMAP.md` for dependency and acceptance context.

- `github-recovery-codes.txt` and any tokens/keys in the dev tree are **secrets** —
  never commit, echo, or include in a PR.
- This repo uses the `dev → test → main` promotion pipeline (see "Location &
  git" above) — never push directly to `test` or `main`.
