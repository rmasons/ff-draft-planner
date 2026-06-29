"use client";

import { useState } from "react";
import DraftBoard from "./DraftBoard";
import MockDraft from "./MockDraft";

type Mode = "cheat-sheet" | "mock-draft";

export default function AppShell() {
  const [mode, setMode] = useState<Mode>("cheat-sheet");
  const [draftActive, setDraftActive] = useState(false);

  function handleModeChange(next: Mode) {
    if (next === mode) return;
    if (
      draftActive &&
      !window.confirm("Leave the mock draft? Your current progress will be lost.")
    ) {
      return;
    }
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
          {(["cheat-sheet", "mock-draft"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                mode === m
                  ? "bg-emerald-500 text-zinc-950"
                  : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {m === "cheat-sheet" ? "Cheat Sheet" : "Mock Draft"}
            </button>
          ))}
        </div>
      </header>
      {mode === "cheat-sheet" ? (
        <DraftBoard />
      ) : (
        <MockDraft onActiveChange={setDraftActive} />
      )}
    </>
  );
}
