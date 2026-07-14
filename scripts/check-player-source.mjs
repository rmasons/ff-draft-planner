import { spawn } from "node:child_process";

const startServer = process.argv.includes("--start");
const port = 4317;
const url = process.env.PLAYER_API_URL ?? `http://127.0.0.1:${port}/api/players`;
let child;

if (startServer) {
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { stdio: "inherit" });
}

try {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      response = await fetch(url);
      if (response.ok) break;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!response?.ok) throw lastError ?? new Error("Player API did not become ready");
  const payload = await response.json();
  if (payload.season !== "2026") throw new Error(`Unexpected season ${payload.season}`);
  if (!payload.sources?.sleeper) throw new Error("Required Sleeper source is unhealthy");
  if (!Array.isArray(payload.players) || payload.players.length < 100) throw new Error("Player pool is unexpectedly small");
  const ids = new Set(payload.players.map((player) => player.id));
  if (ids.size !== payload.players.length) throw new Error("Player IDs are not unique");
  const supported = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
  if (payload.players.some((player) => !supported.has(player.position))) throw new Error("Unsupported position in player pool");
  console.log(JSON.stringify({ season: payload.season, count: payload.players.length, sources: payload.sources, cache: payload.cache }, null, 2));
} finally {
  if (child) child.kill("SIGTERM");
}

