import DraftBoard from "@/components/DraftBoard";

export default function Home() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex items-end justify-between border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">
            Draft<span className="text-emerald-400">Board</span>
          </h1>
          <p className="text-sm text-zinc-500">
            Configurable fantasy football draft cheat sheet · VBD &amp; tiers ·
            live Sleeper projections
          </p>
        </div>
      </header>
      <DraftBoard />
    </div>
  );
}
