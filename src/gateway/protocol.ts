/**
 * 网关协议 v1（MCP ↔ 网关 ↔ 网页 AI）。
 *
 * 两条 WebSocket 端点：
 *   WS /v1/mcp   MCP 侧（Bridge）：首帧 {type:"auth", token}
 *   WS /v1/ai    网页 AI 侧：首帧 {type:"join", pairingCode}
 *
 * 所有消息都是 JSON 对象，带 `type` 字段。
 * 数据面（MCP 协议本身）走 {type:"msg", ch, data} —— data 是不透明字符串，
 * 网关只解析外层 {type, ch} 做路由，**不解析、不重组 data**：
 * 四个方向的 msg 信封完全一致，转发时直接送原始字符串，零拷贝（性能关键）。
 *
 * 建信道两步走：
 *   1. MCP → 网关 channel.create → 返回 {channelId, pairingCode, aiUrl}
 *   2. 网页 AI 用 pairingCode → 网关 channel.join → 双向打通
 */

// ------------------------------------------------------------------ 常量

/** 配对码：12 位，大小写字母+数字（去易混淆），见 ../channel/pairing.ts */
export const PAIRING_CODE_LENGTH = 12;
/** 配对码 TTL：15 分钟未用则失效 */
export const PAIRING_TTL_MS = 15 * 60 * 1000;
/** 网关 token：64 位 hex，MCP 连接网关的长期凭证 */
export const TOKEN_RE = /^[0-9a-f]{64}$/;
/** 心跳：MCP 每 30s ping，网关 90s 未收到判断线 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/** MCP 断线宽限：10 分钟内重连可无缝恢复，超时信道关闭、配对码作废 */
export const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
/** 存活扫描间隔 */
export const SWEEP_INTERVAL_MS = 30_000;
/** 单帧最大载荷 32MB（防内存炸弹；MCP 侧单次读上限 10MB） */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** 背压高水位：对端缓冲超 8MB 视为慢消费者，断开并计数 */
export const BACKPRESSURE_HIGH_WATER_BYTES = 8 * 1024 * 1024;

// ------------------------------------------------------------------ MCP → 网关

export type McpToGateway =
  | { type: "auth"; token: string }
  | { type: "channel.create"; reqId: string; name?: string }
  | { type: "channel.attach"; reqId: string; channels: string[] }
  | { type: "channel.recode"; reqId: string; channelId: string }
  | { type: "channel.close"; channelId: string }
  | { type: "ping"; channels: string[]; ts: number }
  | { type: "msg"; ch: string; data: string }; // data 不透明，直转

// ------------------------------------------------------------------ 网关 → MCP

export type GatewayToMcp =
  | { type: "auth.ok"; mcpId: string }
  | { type: "auth.error"; reason: string }
  | { type: "channel.created"; reqId: string; channelId: string; pairingCode: string; aiUrl: string; expiresAt: number }
  | { type: "channel.attached"; reqId: string; attached: string[]; missing: string[] }
  | { type: "channel.recoded"; reqId: string; channelId: string; pairingCode: string; expiresAt: number }
  | { type: "channel.closed"; channelId: string; reason: string }
  | { type: "peer.join"; channelId: string; ai: { name: string } }
  | { type: "peer.leave"; channelId: string; reason: string }
  | { type: "msg"; ch: string; data: string } // 信封四向一致，不透明直转
  | { type: "pong"; ts: number };

// ------------------------------------------------------------------ AI → 网关

export type AiToGateway =
  | { type: "join"; pairingCode: string; ai?: { name?: string; model?: string } }
  | { type: "msg"; ch: string; data: string } // ch 须与 joined 的信道一致，网关校验
  | { type: "ping"; ts: number };

// ------------------------------------------------------------------ 网关 → AI

export type GatewayToAi =
  | { type: "joined"; channelId: string }
  | { type: "join.error"; reason: string }
  | { type: "msg"; ch: string; data: string } // 信封四向一致，不透明直转
  | { type: "peer.join"; graceMs?: number }
  | { type: "peer.leave"; reason: string; graceMs: number }
  | { type: "channel.closed"; reason: string }
  | { type: "pong"; ts: number };

/** 信道关闭原因 */
export type ChannelCloseReason =
  | "mcp_closed"      // MCP 主动关闭
  | "grace_expired"   // MCP 断线超 10 分钟
  | "replaced"        // 配对码被 recode 替换（旧码作废，信道本身保留）
  | "ai_gone";        // 预留

/** 对端离开原因 */
export type PeerLeaveReason =
  | "mcp_lost"        // MCP 断线（10 分钟宽限期内，可能回来）
  | "mcp_back"        // 反义词不用；重连成功发 peer.join
  | "ai_left"         // AI 断开
  | "closed";         // 信道已关闭
