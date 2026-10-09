/**
 * 崩溃留痕：服务崩溃也要能记录，还要记录当时的情况。
 *
 * 设计：
 * - 日志落盘：ERROR 级别实时追加到 `crashlog/` 目录的 JSONL 文件（按天轮换）。
 *   进程崩溃、重启后，磁盘上的记录还在。
 * - 崩溃处理器：接管 uncaughtException / unhandledRejection，先把
 *   「错误 + 堆栈 + 现场快照（内存/运行时间/最近日志）」同步写入磁盘，再退出。
 *   同步写是关键：异步写在退出前可能来不及刷盘。
 * - 现场快照：崩溃那一刻的 rss/堆内存、uptime、Node 版本、最近 50 条内存日志、
 *   工具调用统计摘要。重启后读文件就能还原"死前发生了什么"。
 * - 启动时回放：dashboard 启动时扫描 `crashlog/` 目录，把上一次运行的
 *   未读崩溃记录载入内存，供 /api/crashes 与助手读取。
 *
 * 目录：`~/.mcp-server/crashlog/`（与 gateways.json 同级，用户级目录，
 * 不污染项目目录，打包后 sidecar 也能写）。
 * 环境变量 MCP_CRASHLOG_DIR 可覆盖。
 *
 * 文件：`crash-<YYYY-MM-DD>.jsonl`，每行一个 JSON（崩溃记录或 error 日志）。
 * 保留最近 7 天，超期自动删除。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, totalmem, freemem } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.js";

export interface CrashRecord {
  /** "crash" = 进程崩溃/未捕获异常；"error" = error 级日志落盘 */
  kind: "crash" | "error";
  ts: number;
  /** 进程名：local-channel / dashboard / gateway / channel / stdio */
  proc: string;
  source: string;
  text: string;
  stack?: string;
  /** 崩溃时的现场快照（error 记录没有） */
  snapshot?: CrashSnapshot;
  /** 启动回放时标记：是不是上一次运行留下来的 */
  replayed?: boolean;
}

export interface CrashSnapshot {
  version: string;
  node: string;
  platform: string;
  arch: string;
  pid: number;
  uptimeSec: number;
  rssMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  freeMemMB: number;
  totalMemMB: number;
  argv: string[];
  /** 崩溃前最近的内存日志（最多 50 条） */
  recentLogs: { ts: number; level: string; source: string; text: string }[];
  /** 工具调用统计摘要（崩溃前） */
  toolStats?: { totalCalls: number; totalErrors: number; topErrors: { name: string; errors: number }[] };
}

const RETENTION_DAYS = 7;
const MAX_TEXT_LEN = 8000;

let crashDir = "";
let currentProc = "unknown";
let getRecentLogs: () => { ts: number; level: string; source: string; text: string }[] = () => [];
let getToolStats: (() => { totalCalls: number; totalErrors: number; topErrors: { name: string; errors: number }[] }) | null = null;
let installed = false;

function dir(): string {
  if (!crashDir) {
    crashDir = process.env["MCP_CRASHLOG_DIR"] || join(homedir(), ".mcp-server", "crashlog");
  }
  return crashDir;
}

function ensureDir(): string {
  const d = dir();
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

function dayFile(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(ensureDir(), `crash-${y}-${m}-${day}.jsonl`);
}

/** 同步追加一行（崩溃路径用：异步写可能来不及刷盘） */
function appendSync(rec: CrashRecord): void {
  try {
    appendFileSync(dayFile(), JSON.stringify(rec) + "\n", "utf-8");
  } catch { /* 磁盘满/无权限也不应让崩溃处理本身再崩 */ }
  pruneOld();
}

/** 删除超期文件（保留最近 7 天） */
function pruneOld(): void {
  try {
    const d = ensureDir();
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    for (const f of readdirSync(d)) {
      const m = /^crash-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (!Number.isNaN(t) && t < cutoff) {
        try { unlinkSync(join(d, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function snapshot(): CrashSnapshot {
  const mem = process.memoryUsage();
  return {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    freeMemMB: Math.round(freemem() / 1024 / 1024),
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    argv: process.argv.slice(1, 6),
    recentLogs: getRecentLogs().slice(-50),
    ...(getToolStats ? { toolStats: getToolStats() } : {}),
  };
}

function toText(e: unknown): { text: string; stack?: string } {
  if (e instanceof Error) {
    return { text: (e.stack || e.message).slice(0, MAX_TEXT_LEN), stack: (e.stack || "").slice(0, MAX_TEXT_LEN) };
  }
  return { text: String(e).slice(0, MAX_TEXT_LEN) };
}

/**
 * 安装崩溃处理器。每个进程入口调用一次：
 *   installCrashHandler("local-channel" | "dashboard" | "gateway" | "channel" | "stdio")
 *
 * 可选：传入内存日志与工具统计的读取函数，崩溃快照会带上"死前现场"。
 */
export function installCrashHandler(
  proc: string,
  opts: {
    recentLogs?: () => { ts: number; level: string; source: string; text: string }[];
    toolStats?: () => { totalCalls: number; totalErrors: number; topErrors: { name: string; errors: number }[] };
  } = {},
): void {
  currentProc = proc;
  if (opts.recentLogs) getRecentLogs = opts.recentLogs;
  if (opts.toolStats) getToolStats = opts.toolStats;
  if (installed) return;
  installed = true;

  // 未捕获异常：记快照 → 同步落盘 → 退出（不吞：吞了进程状态未知，不如重启）
  process.on("uncaughtException", (e) => {
    try {
      const { text, stack } = toText(e);
      appendSync({ kind: "crash", ts: Date.now(), proc: currentProc, source: "uncaughtException", text, ...(stack ? { stack } : {}), snapshot: snapshot() });
    } catch { /* ignore */ }
    // 给 stdout 留一行，sidecar 日志文件里也能看到
    try { console.error(`[crash] uncaughtException 已记录 (${dir()})`); } catch { /* ignore */ }
    process.exit(1);
  });

  // 未处理的 Promise 拒绝：同样记快照落盘（Node 默认行为也是退出，这里先留痕）
  process.on("unhandledRejection", (reason) => {
    try {
      const { text, stack } = toText(reason);
      appendSync({ kind: "crash", ts: Date.now(), proc: currentProc, source: "unhandledRejection", text, ...(stack ? { stack } : {}), snapshot: snapshot() });
    } catch { /* ignore */ }
    try { console.error(`[crash] unhandledRejection 已记录 (${dir()})`); } catch { /* ignore */ }
    process.exit(1);
  });
}

/**
 * error 级日志实时落盘（crashlog 的另一半：不只记崩溃那一下，
 * 崩溃前的 error 也有时间线）。由 logger.ts 调用，同步追加，失败静默。
 */
export function persistError(source: string, text: string): void {
  appendSync({ kind: "error", ts: Date.now(), proc: currentProc, source, text: text.slice(0, MAX_TEXT_LEN) });
}

/** 供测试/诊断：当前落盘目录 */
export function crashlogDir(): string {
  return dir();
}

/**
 * 读取落盘记录（供 /api/crashes 与助手）。
 * 默认读最近 7 天的全部文件，按时间倒序。
 */
export function readCrashlog(opts: { limit?: number; kind?: "crash" | "error"; since?: number } = {}): CrashRecord[] {
  const { limit = 100, kind, since = 0 } = opts;
  const out: CrashRecord[] = [];
  try {
    const d = ensureDir();
    const files = readdirSync(d)
      .filter((f) => /^crash-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
    for (const f of files) {
      let lines: string[];
      try { lines = readFileSync(join(d, f), "utf-8").split("\n"); } catch { continue; }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as CrashRecord;
          if (kind && rec.kind !== kind) continue;
          if (rec.ts <= since) continue;
          out.push(rec);
          if (out.length >= limit) return out;
        } catch { /* 脏行跳过 */ }
      }
    }
  } catch { /* ignore */ }
  return out;
}
