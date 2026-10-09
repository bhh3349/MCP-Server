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

/** 时间窗口内保留的调用历史时长：5 分钟，足够覆盖 dashboard 的最长窗口查询 */
const WINDOW_KEEP_MS = 5 * 60 * 1000;
/** 单次窗口查询返回的延迟样本上限：防止响应体过大 */
const MAX_LATENCY_SAMPLES = 2000;

export interface CallRecord {
  name: string;
  ts: number;
  ms: number;
  ok: boolean;
}

/** 时间桶内某个工具的聚合 */
export interface WindowToolStat {
  name: string;
  calls: number;
  errors: number;
  avgMs: number;
  /** 延迟样本（升序），供前端算真实 p50/p95 */
  samples: number[];
}

export interface WindowStats {
  /** 实际覆盖的时间跨度（ms），可能是请求窗口的一部分（服务刚启动时） */
  spanMs: number;
  totalCalls: number;
  totalErrors: number;
  successRate: number;
  /** 按调用量降序 */
  tools: WindowToolStat[];
  /** 全部调用的延迟样本（升序，用于分位数） */
  latencies: number[];
}

export class ToolStats {
  private map = new Map<string, ToolStat>();
  /** 工具目录：name → description（registerTool 包裹时采集） */
  private catalog = new Map<string, string>();
  /** 最近调用环形缓冲（供 Dashboard 滚动展示） */
  private recentCalls: CallRecord[] = [];
  /**
   * 时间序列环形缓冲：保留最近 WINDOW_KEEP_MS 的调用，
   * 让 dashboard 能回答"最近 60 秒成功率"这类窗口问题，
   * 而不是只能给"自进程启动以来的累计值"。
   * 累计值在长期运行的进程里会严重滞后（昨天的失败一直稀释着今天的成功率）。
   */
  private windowBuf: CallRecord[] = [];

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
    this.recentCalls.push({ name, ts: Date.now(), ms, ok });
    if (this.recentCalls.length > 30) this.recentCalls.shift();
    // 时间窗口缓冲：定期裁剪，保证 window() 只扫最近 WINDOW_KEEP_MS
    this.windowBuf.push({ name, ts: Date.now(), ms, ok });
    const cutoff = Date.now() - WINDOW_KEEP_MS;
    if (this.windowBuf.length > 512) {
      let drop = 0;
      while (drop < this.windowBuf.length && (this.windowBuf[drop]?.ts ?? 0) < cutoff) drop++;
      if (drop > 0) this.windowBuf.splice(0, drop);
    }
  }

  /** 最近 N 次调用（新→旧） */
  recent(n = 15): CallRecord[] {
    return this.recentCalls.slice(-n).reverse();
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

  /**
   * 最近 windowMs 毫秒内的统计（默认 60s）。
   * 与 summary() 的区别：summary 是"自进程启动累计"，会随运行时长越来越滞后；
   * window() 回答的是"最近这段时间怎么样"，这才是监控面板该展示的口径。
   *
   * 无调用时返回空窗口（successRate=1、spanMs=0），前端据此显示"暂无数据"
   * 而不是伪造 100%。
   */
  window(windowMs = 60_000, now = Date.now()): WindowStats {
    const from = now - windowMs;
    const perTool = new Map<string, { calls: number; errors: number; totalMs: number; samples: number[] }>();
    const latencies: number[] = [];
    let totalCalls = 0, totalErrors = 0, minTs = now, maxTs = 0;

    for (const c of this.windowBuf) {
      if (c.ts < from || c.ts > now) continue;
      let t = perTool.get(c.name);
      if (!t) {
        t = { calls: 0, errors: 0, totalMs: 0, samples: [] };
        perTool.set(c.name, t);
      }
      t.calls++;
      t.totalMs += c.ms;
      // 采样上限：高频工具不把响应体撑爆
      if (t.samples.length < MAX_LATENCY_SAMPLES) t.samples.push(c.ms);
      if (!c.ok) t.errors++;
      if (latencies.length < MAX_LATENCY_SAMPLES) latencies.push(c.ms);
      totalCalls++;
      if (!c.ok) totalErrors++;
      if (c.ts < minTs) minTs = c.ts;
      if (c.ts > maxTs) maxTs = c.ts;
    }

    latencies.sort((a, b) => a - b);
    const tools: WindowToolStat[] = [...perTool.entries()]
      .map(([name, t]) => ({
        name,
        calls: t.calls,
        errors: t.errors,
        avgMs: t.calls > 0 ? Math.round((t.totalMs / t.calls) * 10) / 10 : 0,
        samples: t.samples.sort((a, b) => a - b),
      }))
      .sort((a, b) => b.calls - a.calls);

    return {
      // 实际跨度：服务刚启动 / 长期空闲时会是 0 或很小值，前端据此说明数据可信度
      spanMs: totalCalls > 0 ? maxTs - minTs : 0,
      totalCalls,
      totalErrors,
      successRate: totalCalls > 0 ? (totalCalls - totalErrors) / totalCalls : 1,
      tools,
      latencies,
    };
  }
}
