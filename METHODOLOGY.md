# DraftBoard Methodology and Limitations

## Replacement and VOR

Replacement means the first undrafted player. Dedicated starters are allocated league-wide, then FLEX and SUPER_FLEX slots greedily take the highest projected eligible player. VORP additionally allocates bench depth by value over the starter boundary. A 12-team, one-QB league therefore uses QB13 as the VOLS baseline; QB13 has VOR 0 and players below it are negative.

## Market reference and pick value

Sleeper's active format (`ppr`, `half`, `std`, or `superflex`) is authoritative. ESPN's PPR ADP is averaged with Sleeper only in PPR. Missing sources are omitted and never treated as pick 0 or 999.

Pick value is `compatible market ADP − acquisition pick`. A player with ADP 40 selected at pick 25 is `+15`; at pick 55 the same player is `−15`. Keeper cost uses the keeper's team slot in true snake order: in a 12-team league, slot 3 costs pick 3 in round 1 and pick 22 in round 2.

## CPU drafts and recommendations

CPU candidate scores combine compatible market ADP, open starter needs, tier scarcity, an early K/DEF penalty, and bounded seeded variance. Candidates that cannot fit a legal completed roster are rejected. The same pick state produces the same seed and result; this is plausible simulation, not a model of a particular manager.

The best-pick explanation combines VOR, the drop to the next same-position option, a next-user-pick survival estimate, and recent positional-run context. Survival uses a logistic distribution centered on ADP with spread increasing by ADP. It is an estimate, not calibrated draft-room probability.

## Auction guidance

For `R` remaining dollars and `S` open slots, the reserved minimum is `S × $1`; maximum bid is `R − (S − 1)`. Thus a team with $10 and three slots has an $8 maximum. Spendable dollars above the reserve are distributed over the remaining positive-VOR pool eligible for that specific team's open roster, then clamped to its legal maximum. This is budget allocation guidance, not a predicted clearing price.

## Tiers, runs, and risk

Tiers split when a positional point drop exceeds 1.5 times the average relevant gap. A run is at least four non-keeper picks at one position in the last six live picks. Risk uses supported availability/injury, surgery note, rookie, and late-career evidence. The UI shows factors and evidence confidence; missing evidence is unknown, not proof of safety, and this is not medical advice.

## Historical points and sources

The 2025 column applies the active scoring configuration to raw Sleeper historical stats. K/DEF use the available precomputed standard total because their granular scoring categories are not present. Optional source failures show unavailable data rather than zero.

