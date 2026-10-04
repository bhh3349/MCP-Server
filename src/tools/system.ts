/**
 * System tools: host info, health, uptime, self-description.
 */
import { hostname, platform, arch, totalmem, freemem, uptime, cpus } from "node:os";
import { z } from "zod";
import { VERSION } from "../version.js";

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
    version: VERSION,
    uptimeSec: Math.round(process.uptime()),
  };
}

export const ServerInfoInput = z.object({});

/**
 * 自描述端点（测试报告 P2）：版本 / 能力 / 限额 / 并发模型 / 沙箱边界。
 * AI 连上后先读这个，再读 skill://mcp-guide。
 */
export async function serverInfo() {
  return {
    name: "mcp-server",
    version: VERSION,
    transport: "mcp-streamable-http",
    capabilities: [
      "tools",
      "resources",
      "plugins",
      "skills",
      "connectors",
      "local-channel",
      "background-jobs",
      "cas-writes",
      "byte-range-reads",
    ],
    limits: {
      readFileMaxLines: 2000,
      readFileMaxBytes: 10 * 1024 * 1024,
      listFilesDefaultLimit: 200,
      listFilesMaxLimit: 1000,
      execDefaultTimeoutMs: 30000,
      execMaxTimeoutMs: 300000,
      execMaxOutputChars: 200000,
      writeAtomicTempRename: true,
    },
    concurrency: {
      model: "server-side unbounded: every exec/background job runs in its own process, fully parallel",
      caveat:
        "Some MCP clients serialize foreground tool calls. For parallelism use background:true and poll job_output.",
      heartbeat: "GET /healthz needs no token and no session",
    },
    sandbox: {
      fileToolsRoot: "MCP_SERVER_ROOT (default: process cwd)",
      fileToolsJailed: true,
      execJailed: false,
      note: "exec runs arbitrary shell commands: whoever holds the channel URL/token controls the host",
    },
  };
}

// ---------------------------------------------------------------- process_list

export const ProcessListInput = z.object({
  name: z.string().optional().describe("按进程名过滤（子串匹配）"),
  limit: z.number().int().min(1).max(500).default(100).describe("最多返回条数"),
});
export async function processList(args: z.infer<typeof ProcessListInput>) {
  const { name, limit } = ProcessListInput.parse(args);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { platform } = await import("node:os");
  const p = platform();
  let procs: { pid: number; name: string; cpu?: number; memMB?: number }[] = [];
  try {
    if (p === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet | ConvertTo-Json -Compress",
      ], { timeout: 15000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
      const arr = JSON.parse(String(stdout));
      const list = Array.isArray(arr) ? arr : [arr];
      for (const x of list as any[]) {
        const e: { pid: number; name: string; cpu?: number; memMB?: number } = {
          pid: Number(x.Id) || 0,
          name: String(x.ProcessName ?? ""),
        };
        if (typeof x.CPU === "number") e.cpu = Math.round(x.CPU * 10) / 10;
        if (typeof x.WorkingSet === "number") e.memMB = Math.round(x.WorkingSet / 1024 / 1024);
        procs.push(e);
      }
    } else {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid,pcpu,rss,comm"], { timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
      for (const line of stdout.split("\n").slice(1)) {
        const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
        if (!m || !m[1] || !m[2] || !m[3] || !m[4]) continue;
        procs.push({
          pid: parseInt(m[1], 10),
          name: m[4].trim(),
          cpu: parseFloat(m[2]),
          memMB: Math.round(parseInt(m[3], 10) / 1024),
        });
      }
    }
  } catch (e) {
    throw new Error(`process-list-failed: ${(e as Error).message}`);
  }
  if (name) {
    const q = name.toLowerCase();
    procs = procs.filter((x) => x.name.toLowerCase().includes(q));
  }
  procs.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
  return { total: procs.length, processes: procs.slice(0, limit) };
}
