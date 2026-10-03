/**
 * 信道存活检测（MCP ↔ 网关）。
 *
 * 规则（用户确认）：
 * - 信道本身永久有效，没有 TTL；
 * - MCP 侧断线满 10 分钟 → 信道关闭，配对码作废；
 * - 10 分钟内重连成功 → 信道无缝恢复。
 *
 * 检测手段（网关侧为权威）：
 * 1. 快路径：Bridge 的 WebSocket close/error 事件 → 立刻标记 mcp_lost；
 * 2. 慢路径：应用层心跳 — MCP 每 30s 发 ping，网关 90s（3 次）没收到
 *    也算断线。兜底 TCP 半开连接（close 事件永远不来的情况）。
 *
 * 本模块是纯状态机（无 I/O），网关和 MCP 两侧共用同一套语义。
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000; // 3 次心跳没收到 = 断线
export const DISCONNECT_GRACE_MS = 10 * 60 * 1000; // 10 分钟宽限期
export const SWEEP_INTERVAL_MS = 30_000;

export type ChannelLiveness = "active" | "mcp_lost" | "closed";

export interface LivenessRecord {
  bindingId: string;
  state: ChannelLiveness;
  /** 网关最后一次收到该信道心跳的时间 */
  lastHeartbeat: number;
  /** 被判定断线的时间（宽限期起点），null = 未断线 */
  disconnectAt: number | null;
  closedAt: number | null;
  closeReason: string | null;
}

export function newLivenessRecord(bindingId: string, now = Date.now()): LivenessRecord {
  return {
    bindingId,
    state: "active",
    lastHeartbeat: now,
    disconnectAt: null,
    closedAt: null,
    closeReason: null,
  };
}

/** 收到心跳（或 transport 层确认存活）：回到 active，宽限期清零 */
export function onHeartbeat(rec: LivenessRecord, now = Date.now()): LivenessRecord {
  if (rec.state === "closed") return rec; // 已关闭的信道不能复活
  return { ...rec, state: "active", lastHeartbeat: now, disconnectAt: null };
}

/** transport 层断开（WS close）：快路径，立刻标记断线 */
export function onTransportDown(rec: LivenessRecord, now = Date.now()): LivenessRecord {
  if (rec.state !== "active") return rec;
  return { ...rec, state: "mcp_lost", disconnectAt: now };
}

/**
 * 网关定时扫描（每 30s 跑一次）。
 * - active 但 90s 没心跳 → mcp_lost（慢路径）
 * - mcp_lost 满 10 分钟 → closed（配对码由网关同步作废）
 */
export function sweepLiveness(rec: LivenessRecord, now = Date.now()): LivenessRecord {
  if (rec.state === "closed") return rec;

  if (rec.state === "active" && now - rec.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
    return { ...rec, state: "mcp_lost", disconnectAt: now };
  }

  if (
    rec.state === "mcp_lost" &&
    rec.disconnectAt !== null &&
    now - rec.disconnectAt > DISCONNECT_GRACE_MS
  ) {
    return {
      ...rec,
      state: "closed",
      closedAt: now,
      closeReason: "mcp_disconnected_10min",
    };
  }

  return rec;
}

/** 宽限期内重连成功：恢复信道（网关收到 resume 请求时调用） */
export function resumeLiveness(rec: LivenessRecord, now = Date.now()): LivenessRecord {
  if (rec.state === "closed") {
    throw new Error(`channel ${rec.bindingId} is closed, cannot resume`);
  }
  return { ...rec, state: "active", lastHeartbeat: now, disconnectAt: null };
}

/** 信道关闭时网关要做的清理（供网关实现参考） */
export interface ChannelCloseCleanup {
  bindingId: string;
  /** 作废配对码（即使还在 15 分钟 TTL 内） */
  invalidatePairingCode: boolean;
  /** 如果网页 AI 已接入，通知它 MCP 已断线 */
  notifyWebSide: boolean;
  reason: string;
}

export function closeCleanup(rec: LivenessRecord): ChannelCloseCleanup | null {
  if (rec.state !== "closed") return null;
  return {
    bindingId: rec.bindingId,
    invalidatePairingCode: true,
    notifyWebSide: true,
    reason: rec.closeReason ?? "unknown",
  };
}
