# DraftBoard — Session Handoff

> Working doc for a future Claude (or human) session picking up this project.
> Last updated: docs refresh pass verifying against the shipped feature set
> (K/DEF, byes, ESPN ADP, Mock Draft, Auction, Sleeper league import, ADP
> trends, risk scores, player comparison, scarcity chart, promotion pipeline).

## TL;DR

A polished **fantasy football draft toolkit** (Walter Picks–style cheat sheet,
plus mock and auction draft simulators). Pulls live 2026 player projections
from Sleeper's free API, enriches with ESPN ADP and 2025 actuals, and computes
**fantasy points, VOR (value over replacement), and tiers** for *your* exact
scoring and roster settings. Next.js + TypeScript, deployed on GitHub with a
staged promotion pipeline.

**Status:** Well past v1. All the "pending work" from the original scaffolding
session has shipped (see "What's actually left" below for what remains).

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
- Work is committed as it lands — this is not an uncommitted-working-tree
  project anymore. Check `git log --oneline` and `git branch -a` for current
  state; there are typically several short-lived `worktree-agent-*` /
  `fix/*` branches from parallel agent sessions in flight.
- **Never push directly to `test` or `main`** — always go through a PR so the
  blocking review runs.

## Stack

- Next.js **16.2.9** (App Router, Turbopack), React **19**, TypeScript, Tailwind **v4**.
- Node **26**, npm **11**.
- ⚠️ Next 16 ships an `AGENTS.md` warning of breaking changes; bundled docs live in
  `node_modules/next/dist/docs/`. Read those before using unfamiliar APIs.
- Tailwind v4 is CSS-based: `@import "tailwindcss"` + `@theme inline` in
  `app/globals.css` (no `tailwind.config.js`).

## Product decisions (locked with the user)

| Decision | Choice |
|---|---|
| Core feature | Pre-draft cheat sheet **plus** mock draft and auction simulators |
| Scoring/roster | **Fully configurable** from day one, importable from a real Sleeper league |
| Data source | Sleeper free API (no key) + ESPN ADP (no key) |
| Tech | Polished TS web app, deployed via the `dev → test → main` pipeline |
| VOR baseline | Switchable: VOLS default + VORP, baselines shown in UI |

**User context:** Mason works in Python + T-SQL and does **not** know JS/TS. He
explicitly chose the TS app anyway — so *we* own/maintain the TypeScript; don't
hand him TS to debug. Keep code clearly commented.

## Architecture

| File | Role |
|---|---|
| `lib/types.ts` | Domain types: `Player`, `ScoringConfig`, `RosterConfig`, `RankedPlayer`, `Position` (`QB/RB/WR/TE/K/DEF`) |
| `lib/sleeper.ts` | Fetch + normalize Sleeper projections; `SEASON` constant; in-module 12h memo; 2025 actuals fetch |
| `lib/sleeper-league.ts` | Sleeper user/league lookup; `mapLeagueToConfig` maps a league's scoring/roster settings onto our config; `fetchKeptPlayerIds` for keeper/dynasty leagues |
| `lib/espn.ts` | Fetch + normalize ESPN ADP (12h memo), fuzzy name matching (`normalizeName`) |
| `lib/byes.ts` | 2026 team → bye week static map (filled) |
| `lib/scoring.ts` | `fantasyPoints(player, scoring)` — raw stats → points; K/DEF use Sleeper's precomputed `pts_std` |
| `lib/vbd.ts` | VOR engine: greedy replacement levels, tiers, `rankPlayers()`; K/DEF get a simple 1-starter-per-team baseline and are appended after skill positions in overall rank |
| `lib/presets.ts` | Scoring/roster presets + `adpKeyFor()` |
| `app/api/players/route.ts` | GET → normalized, enriched player pool as JSON (Sleeper + ESPN ADP + 2025 actuals, merged in parallel; ESPN/actuals failures are non-fatal) |
| `components/AppShell.tsx` | Tab switcher: Cheat Sheet / Mock Draft / Auction |
| `components/DraftBoard.tsx` | Cheat sheet: config-driven recompute, filters, cross-off, ADP trend indicators, risk scores, value-vs-ADP column, compare-mode trigger |
| `components/ConfigPanel.tsx` | Scoring/roster/VOR-method controls |
| `components/LeagueImport.tsx` | Sleeper league lookup UI → `mapLeagueToConfig` / keeper merge |
| `components/PlayerCompare.tsx` | Side-by-side player comparison modal |
| `components/MockDraft.tsx` (~1,900 lines — the biggest component by far) | CPU / manual / live-sync draft modes, Sleeper draft import (traded picks, team names, keepers), post-draft letter grade vs. ADP, watchlist, CSV export |
| `components/DraftBoardGrid.tsx` | Full draft board grid view (round × team), used inside Mock Draft |
| `components/ScarcityChart.tsx` | Positional scarcity chart, used inside Mock Draft |
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
  shape), supplies the 2025 actuals (`fetch2025ActualPts`) — falls back to
  `pts_std` when a position has no `pts_ppr`. It has its own 12h in-module memo,
  independent from the projections memo.
- Both the projections and 2025-stats raw responses are **~3MB+** — over Next's
  2MB fetch-cache limit. So both fetch with `cache: "no-store"` and **memoize
  the normalized result in-module for 12h** (`TTL_MS` in `lib/sleeper.ts`).
  Don't try `next: { revalidate }` on the raw fetch — it silently fails to cache.
- `SEASON` is hardcoded `"2026"` in `lib/sleeper.ts`. Bump it for a new season
  (and refresh `lib/byes.ts` — see Gotchas).
- League/user/draft endpoints (`lib/sleeper-league.ts`, and the Sleeper draft
  import in `MockDraft.tsx`) live on a different base URL:
  `https://api.sleeper.app/v1` (note: `.app`, not `.com` — the projections/stats
  endpoints above are `.com`). Don't conflate the two hosts.
- The Mock Draft "Live Sync" mode polls Sleeper's documented REST API
  (`GET https://api.sleeper.app/v1/draft/{id}/picks` every ~5 seconds, deduped
  by pick number, stops when draft status is `complete`, error state after 3
  consecutive failures). Uses no WebSocket.

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
  - **VOLS** (default) — "Value Over Last Starter": baseline = best player past all
    starters.
  - **VORP** — "bench depth": after starters, fill `bench × teams` more slots,
    prioritized by **value-over-last-starter** (NOT raw points — otherwise high-raw
    QBs wrongly flood the bench in 1-QB leagues). Deeper baseline → rewards scarce
    positions.
- **K/DEF baseline** is simpler by design: 1 starter per team, no greedy flex
  assignment (they don't feed FLEX/SUPERFLEX). They're always appended after
  all skill positions in overall rank, regardless of VBD, so draft advice stays
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
  three tabs (Cheat Sheet, Mock Draft, Auction).
- `ffdp.drafted` — cheat-sheet cross-off list.
- `ffdp.adp-snapshot` — periodic ADP snapshot used to compute the 7-day trend
  indicators on the cheat sheet.
- `ffdp.draft-setup`, `ffdp.pending-keepers` — Mock Draft setup state.
- `ffdp.auction.wonPlayers`, `ffdp.auction.setup` — Auction tab state.
- The Mock Draft **watchlist** is in-memory (`useState`), not persisted —
  don't go looking for an `ffdp.watchlist` key, it doesn't exist.

## How to run & verify

```bash
cd /Users/masonrussell/Development/ff-draft-planner
npm install        # if fresh
npm run dev        # opens on :3000, or next open port if taken
npm run build      # type + lint check (always run before declaring done)
```

**Verify the engine against live data** (pattern that's worked well):
1. Start dev server in background, `curl http://localhost:<port>/api/players` to
   confirm the data path.
2. Write a `scratch-*.mts` that imports `lib/vbd` + `lib/presets`, fetches the API,
   runs `rankPlayers` across formats, prints baselines + top players. Run with
   `npx tsx scratch-*.mts`. Delete the scratch file after.

## Gotchas (learned — don't rediscover)

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

## What's actually left

The original v1 punch list (value-vs-ADP column, K/DEF, byes, deploy +
review-workflow install) has **all shipped** — verified against the code on
this branch. What plausibly remains:

1. **`SEASON` bump** — `lib/sleeper.ts` hardcodes `"2026"`; will need updating
   (and a fresh `lib/byes.ts`) for the following season.
2. General polish/bug-fix work — check `git log` and open PRs/branches for
   in-flight fixes (e.g. auction math, cheat-sheet polish, mock-draft logic)
   before assuming a given area is unpolished from scratch.

Confirm against the actual code before acting on any of the above — this list
reflects a point-in-time read, and parallel agent work may have moved it.

## House rules (from parent CLAUDE.md)

- `github-recovery-codes.txt` and any tokens/keys in the dev tree are **secrets** —
  never commit, echo, or include in a PR.
- This repo uses the `dev → test → main` promotion pipeline (see "Branching /
  git" above) — never push directly to `test` or `main`.
