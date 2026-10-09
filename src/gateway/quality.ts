/**
 * 信道质量测量：AI ↔ 网关 的延迟与稳定性。
 *
 * 为什么不能直接测 RTT（重要）：
 *   常见做法是网关定时发 ping、AI 回 pong，取往返时间。但本项目的 AI 是
 *   市面第三方网页 AI，走的是 /v1/ai/poll + /v1/ai/msg 这套无状态 HTTP，
 *   协议从未要求它回应自定义 JSON（GATEWAY_PROTOCOL.md 只规定了 MCP→网关
 *   方向的 ping）。实测行为是：网关发 ping → 网页 AI 收到不认识的帧 →
 *   丢弃 → 网关超时。也就是说主动 ping 测出来的"丢包率 100%"反映的是
 *   协议不支持，而不是网络质量。
 *
 * 因此这里测两个第三方 AI 真实可测、且真正反映用户体验的量：
 *
 *  1. 端到端业务延迟（e2eMs）
 *     AI 发出请求 → 网关转发给 MCP → MCP 执行工具 → 结果回到 AI。
 *     测的是"AI 调一次工具要等多久"，这是用户实际感受到的延迟，
 *     而不是脱离业务上下文的网络 RTT。
 *     实现方式：给 AI 的每个请求打一个网关侧时间戳，MCP 回包时按消息里的
 *     信道 id 匹配回来取差值，不需要改 MCP 协议（只利用已有的消息流转）。
 *
 *  2. AI 消息到达节奏抖动（jitterMs）
 *     记录 AI 每次发消息的时间戳，相邻间隔的波动幅度。抖动比平均值更能反映
 *     "忽快忽慢"的不稳定感。
 *
 * 另外埋了 ping 应答率（pongRate），但只在 AI 确实回应时才计入分母——
 * 第三方 AI 不回应时显示"未支持"，而不是虚假的 0%。
 */

/** 一条被跟踪的 AI 请求：发出时间 + 用于匹配的字段 */
interface PendingProbe {
  sentAt: number;
  /** MCP 回包匹配的键：信道 id（一条信道同时只有一条端到端往返在途） */
  chId: string;
  /** 序号，避免连续请求互相覆盖 */
  seq: number;
}

/** 固定容量滑动窗口的统计器 */
class RollingStats {
  private vals: number[] = [];
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(v: number): void {
    this.vals.push(v);
    if (this.vals.length > this.cap) this.vals.shift();
  }

  get size(): number {
    return this.vals.length;
  }

  /** 分位数（q 取 0~1），vals 未排序时内部会排序副本 */
  quantile(q: number): number | null {
    if (!this.vals.length) return null;
    const s = [...this.vals].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)));
    return s[i] ?? null;
  }

  mean(): number | null {
    if (!this.vals.length) return null;
    return this.vals.reduce((a, b) => a + b, 0) / this.vals.length;
  }

  /**
   * 抖动：相邻样本差的平均绝对值（MAD of successive differences）。
   * 比标准差更贴近"这次比上次慢了多少"的主观感受。
   */
  jitter(): number | null {
    if (this.vals.length < 2) return null;
    let s = 0;
    for (let i = 1; i < this.vals.length; i++) s += Math.abs(this.vals[i]! - this.vals[i - 1]!);
    return s / (this.vals.length - 1);
  }
}

/** 某条信道的质量快照（对外形状） */
export interface ChannelQuality {
  /** 端到端业务延迟样本数 */
  samples: number;
  /** 端到端平均延迟（ms），无样本时 null */
  e2eAvgMs: number | null;
  /** 端到端 p95（ms），无样本时 null */
  e2eP95Ms: number | null;
  /** AI 消息到达间隔的抖动（ms），样本 <2 时 null */
  jitterMs: number | null;
  /** AI 活动是否发生过（false = AI 从未发过消息，指标无意义） */
  aiActive: boolean;
  /** 最近一次 AI 消息距今（ms） */
  lastAiMsgAgoMs: number | null;
  /**
   * ping 应答率：只统计"AI 确实回过 pong"的信道。
   * null = AI 不支持 ping/pong（第三方网页 AI 的常态），不是 0%。
   */
  pongRate: number | null;
}

export interface QualityOptions {
  /** 每个指标保留的样本数 */
  windowSize?: number;
  /** ping 发送间隔（默认 30s） */
  pingIntervalMs?: number;
}

const DEFAULT_WINDOW = 60;

export class QualityTracker {
  private readonly win: number;
  private readonly pingIntervalMs: number;

  /** 信道 id → 端到端延迟样本 */
  private e2e = new Map<string, RollingStats>();
  /** 信道 id → AI 消息到达间隔 */
  private gaps = new Map<string, RollingStats>();
  /** 信道 id → 在途请求（发出时间） */
  private pending = new Map<string, PendingProbe>();
  /** 信道 id → AI 上次发消息时间 */
  private lastAiMsgAt = new Map<string, number>();
  /** 信道 id → ping 统计 */
  private pings = new Map<string, { sent: number; got: number; lastPingTs: number | null }>();
  private seq = 0;

  constructor(opts: QualityOptions = {}) {
    this.win = opts.windowSize ?? DEFAULT_WINDOW;
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  }

  /** AI 发出一个请求（在 forwardToMcp 之前调用） */
  onAiRequest(chId: string, now = Date.now()): void {
    this.e2e.get(chId) ?? this.e2e.set(chId, new RollingStats(this.win));
    this.gaps.get(chId) ?? this.gaps.set(chId, new RollingStats(this.win));

    // 到达节奏：记录与上一条的间隔
    const last = this.lastAiMsgAt.get(chId);
    if (last !== undefined) {
      const gap = now - last;
      // 过滤异常间隔（页面切后台/断网重连会产生分钟级空洞，不是网络抖动）
      if (gap >= 0 && gap < 30_000) this.gaps.get(chId)!.push(gap);
    }
    this.lastAiMsgAt.set(chId, now);

    // 端到端：记录发起时间，回包时结算
    this.pending.set(chId, { sentAt: now, chId, seq: ++this.seq });
  }

  /**
   * MCP 回包给 AI 时调用，结算端到端延迟。
   * 只统计"一问一答"能配上的往返：连续多次调用时以最近一次发起为准。
   */
  onMcpResponse(chId: string, now = Date.now()): void {
    const p = this.pending.get(chId);
    if (!p) return;
    this.pending.delete(chId);
    const ms = now - p.sentAt;
    // 上限保护：超过 2 分钟的多半是 AI 发了请求没等回包就又发了，不是真实往返
    if (ms >= 0 && ms <= 120_000) this.e2e.get(chId)?.push(ms);
  }

  /** 网关发出一次 ping（返回 true 表示该信道被 ping 了） */
  onPingSent(chId: string, ts = Date.now()): void {
    const p = this.pings.get(chId);
    if (p) {
      p.sent++;
      p.lastPingTs = ts;
    } else {
      this.pings.set(chId, { sent: 1, got: 0, lastPingTs: ts });
    }
  }

  /** 收到该信道的 pong */
  onPong(chId: string): void {
    const p = this.pings.get(chId);
    if (p) p.got++;
  }

  /**
   * 是否该给这条信道发 ping（默认每 pingIntervalMs 一次）。
   * 放在网关既有的单一定时器里调用，不额外起定时器。
   */
  dueForPing(chId: string, now = Date.now()): boolean {
    const p = this.pings.get(chId);
    if (!p) return true;
    return p.lastPingTs === null || now - p.lastPingTs >= this.pingIntervalMs;
  }

  /** 某条信道的质量快照 */
  snapshot(chId: string, now = Date.now()): ChannelQuality {
    const e = this.e2e.get(chId);
    const g = this.gaps.get(chId);
    const lastAt = this.lastAiMsgAt.get(chId);
    const p = this.pings.get(chId);
    return {
      samples: e?.size ?? 0,
      e2eAvgMs: e?.mean() != null ? Math.round(e.mean()!) : null,
      e2eP95Ms: e?.quantile(0.95) != null ? Math.round(e.quantile(0.95)!) : null,
      jitterMs: g?.jitter() != null ? Math.round(g.jitter()!) : null,
      aiActive: lastAt !== undefined,
      lastAiMsgAgoMs: lastAt !== undefined ? now - lastAt : null,
      // 只有 AI 真的回过 pong 才给应答率；从未回应 → null（未支持），不是 0%
      pongRate: p && p.got > 0 ? Math.round((p.got / p.sent) * 100) / 100 : null,
    };
  }

  /** 清理已关闭信道的状态（防内存泄漏） */
  forget(chId: string): void {
    this.e2e.delete(chId);
    this.gaps.delete(chId);
    this.pending.delete(chId);
    this.lastAiMsgAt.delete(chId);
    this.pings.delete(chId);
  }
}