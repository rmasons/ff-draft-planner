"use client";

import { useState } from "react";
import DraftBoard from "./DraftBoard";
import MockDraft from "./MockDraft";
import AuctionDraft from "./AuctionDraft";

type Mode = "cheat-sheet" | "mock-draft" | "auction";

const MODE_LABELS: Record<Mode, string> = {
  "cheat-sheet": "Cheat Sheet",
  "mock-draft": "Mock Draft",
  auction: "Auction",
};

export default function AppShell() {
  const [mode, setMode] = useState<Mode>("cheat-sheet");

  function handleModeChange(next: Mode) {
    if (next === mode) return;
    // Mock drafts persist to sessionStorage and restore on remount (see
    // MockDraft), so switching tabs no longer loses in-progress draft state —
    // no confirmation needed here anymore.
    setMode(next);
  }

  return (
    <>
      <header className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">
            Draft<span className="text-emerald-400">Board</span>
          </h1>
          <p className="text-sm text-zinc-500">
            Configurable fantasy football draft cheat sheet · VBD &amp; tiers ·
            live Sleeper projections
          </p>
        </div>
        <div className="flex rounded-lg border border-zinc-800 p-0.5">
          {(["cheat-sheet", "mock-draft", "auction"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                mode === m
                  ? "bg-emerald-500 text-zinc-950"
                  : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </header>
      {mode === "cheat-sheet" ? (
        <DraftBoard />
      ) : mode === "mock-draft" ? (
        <MockDraft />
      ) : (
        <AuctionDraft />
      )}
    </>
  );
}
