/**
 * 日志采集：拦截 console 输出，存入内存环形缓冲，供 dashboard /api/logs /api/errors 查询。
 * 只在 dashboard 模式下 install()，不影响 stdio 模式。
 */
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

  /** 工具/网关/信道等内部来源直接写入 */
  add(entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }): LogEntry {
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
