# DraftBoard Methodology and Limitations

## Replacement and VOR

Replacement means the first undrafted player. Dedicated starters are allocated league-wide, then FLEX and SUPER_FLEX slots greedily take the highest projected eligible player. VORP additionally allocates bench depth by value over the starter boundary. A 12-team, one-QB league therefore uses QB13 as the VOLS baseline; QB13 has VOR 0 and players below it are negative.

Flex slots go to the best available player, with no positional preference: each slot is handed to whichever eligible position's next unallocated player projects highest. The resulting split follows from the scoring config rather than from any rule — under PPR every flex slot currently goes to a wide receiver (WR25 projects 198.7 against RB25's 174.8), while under Standard the same code sends nine of twelve to running backs. This models who would actually be started league-wide, which is what replacement level depends on; it is not a forecast of how managers split flex in practice.

Baselines follow the imported league when there is one: a Sleeper draft's `roster_positions` and team count define the starter counts, the bench depth, and the ADP format. The saved Cheat Sheet config is the fallback for when nothing has been imported. Unrecognized slots (IDP, IR, taxi) are ignored, and a roster with no recognized slot falls back rather than collapsing every baseline to zero.

VOR is comparable across skill positions but not between skill positions and K/DEF, which are baselined at one starter per team. A top defense holds roughly +20 all draft long while static skill VOR decays toward zero, so K and DEF are excluded from overall rank ordering and are only ever recommended for their own open starter slot.

Once a draft is underway, replacement level is recomputed against the live board rather than the preseason pool. Demand is read as the roster slots still unfilled across every team, and supply as the players still available; a position's baseline therefore moves only when the draft has actually changed its supply-and-demand balance, not merely because picks have happened. Counting real open slots is what separates this from subtracting drafted players from total demand — those two agree only if every pick filled a starting job, and bench stashes break that. The Cheat Sheet stays static, since there is no draft to be relative to. Player order on the live board reshuffles as baselines move; that is the point, not a glitch.

## Market reference and pick value

Sleeper's active format (`ppr`, `half`, `std`, or `superflex`) is authoritative. ESPN's PPR ADP is averaged with Sleeper only in PPR. Missing sources are omitted and never treated as pick 0 or 999.

Pick value is `compatible market ADP − acquisition pick`. A player with ADP 40 selected at pick 25 is `+15`; at pick 55 the same player is `−15`. Keeper cost uses the keeper's team slot in true snake order: in a 12-team league, slot 3 costs pick 3 in round 1 and pick 22 in round 2.

## CPU drafts and recommendations

CPU candidate scores combine compatible market ADP, open starter needs, tier scarcity, an early K/DEF penalty, and bounded seeded variance. Candidates that cannot fit a legal completed roster are rejected. The same pick state produces the same seed and result; this is plausible simulation, not a model of a particular manager.

The best pick is chosen by scoring every candidate on VOR, the drop to the next same-position option, a next-user-pick survival estimate, and recent positional-run context — so a tier cliff or low survival odds can promote a player with slightly lower VOR. Survival uses a logistic distribution centered on ADP with spread increasing by ADP. It is an estimate, not calibrated draft-room probability.

Roster need is a weight on that score rather than a filter. Filling an open starter slot is worth up to 25 points for a dedicated slot and 12 for a flexible one, scaled by need urgency — open starter slots divided by picks remaining. Early, with picks to spare, that weight is near zero and the best player wins; it grows as picks run out. When every remaining pick is needed to fill a starter, the candidate list is hard-restricted to players who fill one, so no amount of surplus value can leave a starting spot empty.

Surplus depth is discounted in the other direction, because league-wide scarcity is not the same as usefulness to one roster: if most teams have skipped quarterback, every remaining quarterback scores well, and a seventh one still cannot start for you. A player's value holds at full while the lineup could still field them, then decays linearly to zero as holdings go from a full complement to double it — so a 1-QB league tolerates about one backup and a three-receiver lineup about three. Flexible slots count toward every position they accept, so a lineup with a FLEX treats itself as able to start three running backs and three receivers. A position at zero is dropped from consideration rather than scored at zero, since late in a draft almost everything left is below replacement and a zero would still win the pick.

## Auction guidance

For `R` remaining dollars and `S` open slots, the reserved minimum is `S × $1`; maximum bid is `R − (S − 1)`. Thus a team with $10 and three slots has an $8 maximum. Spendable dollars above the reserve are distributed over the remaining positive-VOR pool eligible for that specific team's open roster, then clamped to its legal maximum. This is budget allocation guidance, not a predicted clearing price.

## Tiers, runs, and risk

Tiers split when a positional point drop exceeds 1.5 times the average relevant gap. A run is at least four non-keeper picks at one position in the last six live picks. Risk uses supported availability/injury, surgery note, rookie, and late-career evidence. The UI shows factors and evidence confidence; missing evidence is unknown, not proof of safety, and this is not medical advice.

## Historical points and sources

The 2025 column applies the active scoring configuration to raw Sleeper historical stats. K/DEF use the available precomputed standard total because their granular scoring categories are not present. Optional source failures show unavailable data rather than zero.

