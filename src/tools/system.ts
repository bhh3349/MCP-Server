/**
 * System tools: host info, health, uptime.
 */
import { hostname, platform, arch, totalmem, freemem, uptime, cpus } from "node:os";
import { z } from "zod";

export async function systemInfo() {
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    freeMemMB: Math.round(freemem() / 1024 / 1024),
    uptimeSec: Math.round(uptime()),
    node: process.version,
  };
}

export const HealthInput = z.object({});
export async function health() {
  return {
    status: "ok",
    server: "mcp-server",
    version: "0.1.0",
    uptimeSec: Math.round(process.uptime()),
  };
}
