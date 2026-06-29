"use client";

import type { RosterConfig, ScoringConfig } from "@/lib/types";
import { ROSTER_PRESETS, SCORING_PRESETS } from "@/lib/presets";
import { BASELINE_LABELS, type BaselineMethod } from "@/lib/vbd";
import LeagueImport from "./LeagueImport";

interface Props {
  scoring: ScoringConfig;
  roster: RosterConfig;
  method: BaselineMethod;
  setScoring: (s: ScoringConfig) => void;
  setRoster: (r: RosterConfig) => void;
  setMethod: (m: BaselineMethod) => void;
  onKeepersMerge: (ids: string[]) => void;
}

const METHOD_HELP: Record<BaselineMethod, string> = {
  VOLS: "Baseline = best player past your starters. Standard, balanced.",
  VORP: "Baseline pushed deeper to account for bench depth. Rewards scarce positions (RB).",
};

function NumberField({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-zinc-400">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-right text-zinc-100 focus:border-emerald-500 focus:outline-none"
      />
    </label>
  );
}

export default function ConfigPanel({
  scoring,
  roster,
  method,
  setScoring,
  setRoster,
  setMethod,
  onKeepersMerge,
}: Props) {
  const s = (patch: Partial<ScoringConfig>) => setScoring({ ...scoring, ...patch });
  const r = (patch: Partial<RosterConfig>) => setRoster({ ...roster, ...patch });

  return (
    <aside className="flex w-full flex-col gap-6 lg:w-72 lg:shrink-0">
      {/* League import from Sleeper */}
      <LeagueImport
        currentScoring={scoring}
        setScoring={setScoring}
        setRoster={setRoster}
        onKeepersMerge={onKeepersMerge}
      />

      {/* VOR baseline method */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-300">
          VOR baseline
        </h2>
        <div className="mb-2 grid grid-cols-2 gap-2">
          {(["VOLS", "VORP"] as BaselineMethod[]).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                method === m
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {m}
              <span className="block text-[10px] font-normal text-zinc-500">
                {BASELINE_LABELS[m]}
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs leading-snug text-zinc-500">{METHOD_HELP[method]}</p>
      </section>

      {/* Scoring */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
            Scoring
          </h2>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          {Object.keys(SCORING_PRESETS).map((name) => (
            <button
              key={name}
              onClick={() => setScoring({ ...SCORING_PRESETS[name] })}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-emerald-500 hover:text-emerald-400"
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <NumberField label="Pass yd" step={0.01} value={scoring.passYd} onChange={(n) => s({ passYd: n })} />
          <NumberField label="Pass TD" value={scoring.passTd} onChange={(n) => s({ passTd: n })} />
          <NumberField label="Interception" value={scoring.passInt} onChange={(n) => s({ passInt: n })} />
          <NumberField label="Rush yd" step={0.01} value={scoring.rushYd} onChange={(n) => s({ rushYd: n })} />
          <NumberField label="Rush TD" value={scoring.rushTd} onChange={(n) => s({ rushTd: n })} />
          <NumberField label="Rec yd" step={0.01} value={scoring.recYd} onChange={(n) => s({ recYd: n })} />
          <NumberField label="Rec TD" value={scoring.recTd} onChange={(n) => s({ recTd: n })} />
          <NumberField label="Per reception" step={0.5} value={scoring.rec} onChange={(n) => s({ rec: n })} />
          <NumberField label="TE rec bonus" step={0.5} value={scoring.teRecBonus} onChange={(n) => s({ teRecBonus: n })} />
          <NumberField label="Fumble lost" value={scoring.fumLost} onChange={(n) => s({ fumLost: n })} />
        </div>
      </section>

      {/* Roster */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-300">
          League &amp; roster
        </h2>
        <div className="mb-3 flex flex-col gap-2">
          {Object.keys(ROSTER_PRESETS).map((name) => (
            <button
              key={name}
              onClick={() => setRoster({ ...ROSTER_PRESETS[name] })}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-emerald-500 hover:text-emerald-400"
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <NumberField label="Teams" value={roster.teams} onChange={(n) => r({ teams: n })} />
          <NumberField label="QB" value={roster.qb} onChange={(n) => r({ qb: n })} />
          <NumberField label="RB" value={roster.rb} onChange={(n) => r({ rb: n })} />
          <NumberField label="WR" value={roster.wr} onChange={(n) => r({ wr: n })} />
          <NumberField label="TE" value={roster.te} onChange={(n) => r({ te: n })} />
          <NumberField label="FLEX (R/W/T)" value={roster.flex} onChange={(n) => r({ flex: n })} />
          <NumberField label="SUPERFLEX" value={roster.superflex} onChange={(n) => r({ superflex: n })} />
          <NumberField label="Bench" value={roster.bench} onChange={(n) => r({ bench: n })} />
        </div>
      </section>
    </aside>
  );
}
