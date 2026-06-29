# DraftBoard — Session Handoff

> Working doc for a future Claude (or human) session picking up this project.
> Last updated by the session that scaffolded the app + built the VOR engine.

## TL;DR

A polished **fantasy football pre-draft cheat sheet** (Walter Picks–style). Pulls
live 2026 player projections from Sleeper's free API and computes **fantasy
points, VOR (value over replacement), and tiers** for *your* exact scoring and
roster settings. Next.js + TypeScript, deployable to Vercel.

**Status:** Core app is built and verified working. Not deployed yet (deploy is
intentionally the *last* step). All work is uncommitted on top of the initial
`create-next-app` commit.

## Location & git

- **Path:** `~/Desktop/development/ff-draft-planner`
- **Self-contained git repo** (own `git init` from create-next-app), branch `main`,
  one commit: `Initial commit from Create Next App`.
- Parent `~/Desktop/development` is **not** a git repo — this project is isolated.
- **No GitHub remote yet.** All real work (`lib/`, `components/`, `app/api/`,
  config edits) is **uncommitted**. Don't commit unless the user asks.

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
| Core feature | **Pre-draft cheat sheet** (NOT live draft assistant, NOT mock sim) |
| Scoring/roster | **Fully configurable** from day one |
| Data source | **Sleeper free API** (no key) |
| Tech | **Polished TS web app**, Vercel-deployable |
| VOR baseline | **Switchable: VOLS default + VORP**, baselines shown in UI |

**User context:** Mason works in Python + T-SQL and does **not** know JS/TS. He
explicitly chose the TS app anyway — so *we* own/maintain the TypeScript; don't
hand him TS to debug. Keep code clearly commented.

## Architecture

| File | Role |
|---|---|
| `lib/types.ts` | Domain types: `Player`, `ScoringConfig`, `RosterConfig`, `RankedPlayer` |
| `lib/sleeper.ts` | Fetch + normalize Sleeper projections; `SEASON` constant; in-module 12h memo |
| `lib/scoring.ts` | `fantasyPoints(player, scoring)` — raw stats → points |
| `lib/vbd.ts` | VOR engine: greedy replacement levels, tiers, `rankPlayers()` |
| `lib/presets.ts` | Scoring/roster presets + `adpKeyFor()` |
| `lib/byes.ts` | Stubbed static bye-week map (empty — see Pending) |
| `app/api/players/route.ts` | GET → normalized player pool as JSON |
| `components/DraftBoard.tsx` | Main client board: config-driven recompute, filters, cross-off, baseline UI |
| `components/ConfigPanel.tsx` | Scoring/roster/VOR-method controls |
| `components/useLocalStorage.ts` | SSR-safe persisted state hook |

**Data flow:** `/api/players` serves normalized players (server-side fetch avoids
CORS + the 3.9MB payload). The client fetches once, then `rankPlayers()` recomputes
points/VOR/tiers in a `useMemo` whenever scoring/roster/method changes — instant,
no refetch.

### Sleeper API specifics

- Endpoint: `https://api.sleeper.com/projections/nfl/{SEASON}?season_type=regular&order_by=pts_ppr&position[]=QB&position[]=RB&position[]=WR&position[]=TE`
- Returns per player: granular stat projections (`pass_yd/td/int/2pt`, `rush_yd/td`,
  `rec/rec_yd/rec_td/rec_2pt`, `fum_lost`, …), ADP across formats (`adp_ppr`,
  `adp_half_ppr`, `adp_std`, `adp_2qb` = superflex, dynasty variants), and embedded
  player metadata (name, position, team, exp, injury). **No bye weeks.**
- Raw response is **~3.9MB** — over Next's 2MB fetch-cache limit. So we fetch with
  `cache: "no-store"` and **memoize the normalized (~200KB) result in-module for 12h**
  (`lib/sleeper.ts`). Don't try `next: { revalidate }` on the raw fetch — it silently
  fails to cache.
- `SEASON` is hardcoded `"2026"` in `lib/sleeper.ts`. Bump it for a new season.
- Draftable filter: keep players with `pts_ppr > 0` OR `adp_ppr < 999`. Yields ~559
  players (76 QB / 140 RB / 216 WR / 127 TE).

### VOR methodology (the core IP)

`rankPlayers(players, scoring, roster, method)` returns `{ players, baselines, method }`.

- **Replacement levels via greedy slot assignment** (`computeBaselines` in `lib/vbd.ts`):
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
- **Tiers:** gap-based per position — new tier when the drop to the next player
  exceeds `1.5× average gap` (top-40 window).
- VOR field on `RankedPlayer` is named `vbd` (legacy name; UI label is "VOR").

**Verified numbers (PPR, 12-team standard):**
- VOLS baselines: `QB12 / RB24 / WR36 / TE12` (textbook last-starter).
- VORP baselines: `QB22 / RB41 / WR65 / TE28` — added depth `10+17+29+16 = 72 = bench(6)×teams(12)` ✓.

### localStorage keys

`ffdp.scoring`, `ffdp.roster`, `ffdp.method`, `ffdp.drafted`.

## How to run & verify

```bash
cd ~/Desktop/development/ff-draft-planner
npm install        # if fresh
npm run dev        # opens on :3000, or :3001 if 3000 is taken
npm run build      # type + lint check (always run before declaring done)
```

**Verify the engine against live data** (pattern that's worked well — the preview
browser is unavailable, see Gotchas):
1. Start dev server in background, `curl http://localhost:<port>/api/players` to
   confirm the data path.
2. Write a `scratch-*.mts` that imports `lib/vbd` + `lib/presets`, fetches the API,
   runs `rankPlayers` across formats, prints baselines + top players. Run with
   `npx tsx scratch-*.mts`. Delete the scratch file after.

## Gotchas (learned — don't rediscover)

- **`preview_start` MCP fails** with `EPERM: process.cwd ... uv_cwd` (sandbox can't
  spawn npm). So **no browser screenshots** in this environment. Run the dev server
  via the **Bash** tool instead and verify with curl + `tsx`. Visual verification
  must be done by the user locally.
- **Port 3000 is occupied** by a separate pre-existing process (not ours — leave it).
  `npm run dev` auto-selects 3001.
- A stray `~/package-lock.json` made Next infer the wrong workspace root → fixed by
  pinning `turbopack.root: __dirname` in `next.config.ts`. Keep that.
- Dark theme is forced in `app/globals.css` (`:root` = zinc-950/zinc-50), not
  `prefers-color-scheme`.
- Clean up any background dev servers you start (`lsof -ti tcp:3001 | xargs kill`).

## Pending work (priority order)

### 1. Value-vs-ADP column (next feature — user asked for this)
Flag players whose VOR rank beats market ADP (the "steal" highlight).
- In `DraftBoard.tsx`, per row compute `value = adp - overallRank` where `adp` is
  `p.adp[adpKey]` (already computed via `adpKeyFor`), skipping `adp >= 999`.
- Positive (ADP later than our rank) = **value/steal** → green; negative = **reach**
  → red/amber. Add a "Value" column (e.g. `+12` / `−8`) next to ADP.
- Consider a small "💎 / ⚠" glyph or sort-by-value option. Keep it subtle.
- `adpKey` (`ppr`/`half`/`std`/`superflex`) already follows the active config.

### 2. Deploy to Vercel (LAST — user wants local-first, then deploy)
Two paths:
- **Vercel CLI** from the folder (no GitHub needed), OR
- **GitHub remote + push**, then import in Vercel for push-deploys.
- ⚠️ Per parent `~/Desktop/development/CLAUDE.md`: when this repo gets a GitHub
  remote/first push, **install the fresh-context PR-review workflow** via
  `~/Desktop/development/.claude-review/setup.sh` (needs the Claude GitHub App +
  a model-credential repo secret — the user sets the secret, never commit it).

### 3. K / DEF positions (deferred from v1)
Different scoring schema (FG distance, points-allowed tiers) — the granular-stats
engine doesn't apply. Use Sleeper's precomputed `pts_std`/`pts_ppr` for these, and
don't make them configurable. Verify the projections endpoint returns them with
`position[]=K` / `position[]=DEF` first.

### 4. Bye weeks
`lib/byes.ts` is an empty static map (Sleeper's feed has no byes). Fill the 2026
team→bye map once the NFL schedule is final. Left empty on purpose — wrong bye data
is worse than none. UI already shows "Bye N" when present.

## House rules (from parent CLAUDE.md)

- `github-recovery-codes.txt` and any tokens/keys in the dev tree are **secrets** —
  never commit, echo, or include in a PR.
- Repos here use a `dev → test → main` promotion pipeline as the preferred model
  (see `.claude-review/PIPELINE.md`) — relevant only once this is on GitHub.
