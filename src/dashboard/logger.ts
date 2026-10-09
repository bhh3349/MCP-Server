/**
 * 日志采集：拦截 console 输出，存入内存环形缓冲，供 dashboard /api/logs /api/errors 查询。
 * 只在 dashboard 模式下 install()，不影响 stdio 模式。
 *
 * error 级日志同时落盘（见 crashlog.ts）：进程崩溃、重启后磁盘记录还在，
 * 重启后可通过 /api/crashes 与助手读取"死前发生了什么"。
 */
import { persistError } from "./crashlog.js";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  /** 来源：console / tool:<name> / gateway / channel:<id> */
  source: string;
  text: string;
}

export interface ErrorRecord extends LogEntry {
  /** 是否已处理（dashboard 标记） */
  acked: boolean;
}

const MAX_LOGS = 2000;
const MAX_ERRORS = 500;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold: LogLevel = "info";
/** 设置日志采集阈值：低于该级别的日志不再入库（实时生效） */
export function setLogThreshold(l: LogLevel): void { threshold = l; }
export function getLogThreshold(): LogLevel { return threshold; }
function pass(level: LogLevel): boolean { return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold]; }

class LogStore {
  private logs: LogEntry[] = [];
  private errors: ErrorRecord[] = [];
  private seq = 0;
  private installed = false;

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };
    const push = (level: LogLevel, source: string, args: unknown[]) => {
      if (!pass(level)) return;
      const text = args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ");
      this.add({ level, source, text });
    };
    console.log = (...a: unknown[]) => { push("info", "console", a); orig.log(...a); };
    console.warn = (...a: unknown[]) => { push("warn", "console", a); orig.warn(...a); };
    console.error = (...a: unknown[]) => { push("error", "console", a); orig.error(...a); };
    console.debug = (...a: unknown[]) => { push("debug", "console", a); orig.debug(...a); };
  }

  /** 工具/网关/信道等内部来源直接写入（受阈值过滤） */
  add(entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }): LogEntry | null {
    if (!pass(entry.level)) return null;
    const e: LogEntry = {
      id: ++this.seq,
      ts: entry.ts ?? Date.now(),
      level: entry.level,
      source: entry.source,
      text: entry.text,
    };
    this.logs.push(e);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    if (e.level === "error") {
      this.errors.push({ ...e, acked: false });
      if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
      // error 落盘：崩溃/重启后还能查（同步追加，失败静默，不阻塞主流程）
      // crashlog.ts 不依赖本模块，无循环导入，可静态引用
      try { persistError(e.source, e.text); } catch { /* 落盘失败不影响内存日志 */ }
    }
    return e;
  }

  query(opts: { level?: LogLevel; source?: string; limit?: number; since?: number } = {}): LogEntry[] {
    const { level, source, limit = 200, since = 0 } = opts;
    return this.logs
      .filter((e) => e.id > since && (!level || e.level === level) && (!source || e.source.includes(source)))
      .slice(-limit);
  }

  errorList(opts: { acked?: boolean; source?: string; limit?: number } = {}): ErrorRecord[] {
    const { acked, source, limit = 200 } = opts;
    return this.errors
      .filter((e) => (acked === undefined || e.acked === acked) && (!source || e.source.includes(source)))
      .slice(-limit)
      .reverse(); // 新的在前
  }

  ackError(id: number): boolean {
    const e = this.errors.find((x) => x.id === id);
    if (!e) return false;
    e.acked = true;
    return true;
  }

  errorStats(): { total: number; unacked: number; bySource: Record<string, number> } {
    const bySource: Record<string, number> = {};
    let unacked = 0;
    for (const e of this.errors) {
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      if (!e.acked) unacked++;
    }
    return { total: this.errors.length, unacked, bySource };
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logStore = new LogStore();
