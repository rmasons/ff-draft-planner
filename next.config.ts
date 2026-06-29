import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't pick up a stray parent lockfile.
  turbopack: {
    root: __dirname,
  },
  // Allow LAN access so browser automation testing works (dev only).
  allowedDevOrigins: ["192.168.1.215"],
};

export default nextConfig;
