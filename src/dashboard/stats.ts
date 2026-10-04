/**
 * 工具调用统计：每个工具的调用次数、错误数、累计耗时。
 * 通过 buildServer 的 ServerOptions.stats 注入，registerTool 包裹自动采集，
 * 嵌套 server（本地信道/网关数据面）透传 opts.stats 即可一并统计。
 */
import { logStore } from "./logger.js";

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  lastAt: number;
  lastOk: boolean;
}

export class ToolStats {
  private map = new Map<string, ToolStat>();
  /** 工具目录：name → description（registerTool 包裹时采集） */
  private catalog = new Map<string, string>();

  describe(name: string, description: string): void {
    if (description && !this.catalog.has(name)) this.catalog.set(name, description);
  }

  catalogList(): { name: string; description: string }[] {
    return [...this.catalog.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  record(name: string, ms: number, ok: boolean, err?: unknown): void {
    let s = this.map.get(name);
    if (!s) {
      s = { name, calls: 0, errors: 0, totalMs: 0, lastAt: 0, lastOk: true };
      this.map.set(name, s);
    }
    s.calls++;
    s.totalMs += ms;
    s.lastAt = Date.now();
    s.lastOk = ok;
    if (!ok) {
      s.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      logStore.add({ level: "error", source: `tool:${name}`, text: `${name} 调用失败 (${ms}ms): ${msg}` });
    }
  }

  list(): (ToolStat & { avgMs: number; errRate: number })[] {
    return [...this.map.values()]
      .map((s) => ({
        ...s,
        avgMs: s.calls > 0 ? Math.round((s.totalMs / s.calls) * 10) / 10 : 0,
        errRate: s.calls > 0 ? s.errors / s.calls : 0,
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  summary(): { totalCalls: number; totalErrors: number; successRate: number } {
    let totalCalls = 0, totalErrors = 0;
    for (const s of this.map.values()) {
      totalCalls += s.calls;
      totalErrors += s.errors;
    }
    return {
      totalCalls,
      totalErrors,
      successRate: totalCalls > 0 ? (totalCalls - totalErrors) / totalCalls : 1,
    };
  }
}
