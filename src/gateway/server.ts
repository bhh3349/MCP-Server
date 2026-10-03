/**
 * 网关服务端：MCP ↔ 网关 ↔ 网页 AI 的配对与消息管道。
 *
 * 一个网关带 N 条信道。MCP 用长期 token 连 /v1/mcp 建信道，
 * 网页 AI 用 12 位配对码连 /v1/ai 加入。网关只做路由，不理解 MCP 协议。
 *
 * 性能设计（无瓶颈）：
 * 1. 数据面零拷贝：msg 四向信封一致，网关只解析外层 {type,ch}，
 *    转发原始字符串，不解析、不重组 data。
 * 2. O(1) 路由：channelId → Channel、pairingCode → channelId 全是 Map。
 * 3. 无压缩（perMessageDeflate 关）：MCP 载荷多为小 JSON，压缩省的带宽
 *    换不回 CPU 延迟；延迟可预测优先。
 * 4. 背压：对端 bufferedAmount 超 8MB 视为慢消费者，断开并计数，
 *    不让一个慢端拖住网关内存。
 * 5. 单一定时器做存活扫描；心跳/宽限全部用时间戳比较，无 per-channel 定时器。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { generatePairingCode, isValidPairingCode } from "../channel/pairing.js";
import {
  TOKEN_RE,
  PAIRING_TTL_MS,
  HEARTBEAT_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  SWEEP_INTERVAL_MS,
  MAX_PAYLOAD_BYTES,
  BACKPRESSURE_HIGH_WATER_BYTES,
  type ChannelCloseReason,
} from "./protocol.js";

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** 允许的网关 token 列表（64 hex）。MCP 的长期凭证。 */
  tokens?: string[];
  /** 对外公布的 AI 接入地址前缀，如 wss://gw.example.com（用于 aiUrl） */
  publicUrl?: string;
  /** 心跳超时/宽限可覆盖（测试用） */
  heartbeatTimeoutMs?: number;
  disconnectGraceMs?: number;
  sweepIntervalMs?: number;
}

export interface GatewayMetrics {
  startTime: number;
  mcpConnections: number;
  aiConnections: number;
  channelsCreated: number;
  channelsActive: number;
  channelsClosed: number;
  pairingAttempts: number;
  pairingFailures: number;
  msgsRouted: number;
  bytesRouted: number;
  slowConsumerDrops: number;
  authFailures: number;
}

type ChannelState = "waiting" | "active" | "mcp_lost" | "closed";

interface Channel {
  id: string;
  name: string;
  tokenId: string;
  pairingCode: string | null;
  pairingExpiresAt: number;
  state: ChannelState;
  mcp: McpConn | null;
  ai: AiConn | null;
  aiName: string | null;
  createdAt: number;
  mcpLostAt: number | null;
  msgsRouted: number;
}

interface McpConn {
  id: string;
  ws: WebSocket;
  tokenId: string;
  lastSeen: number; // 最后收到任何消息的时间（心跳或业务）
  channels: Set<string>;
  closed: boolean;
}

interface AiConn {
  id: string;
  ws: WebSocket;
  channelId: string | null; // join 成功后绑定
  aiName: string;
  lastSeen: number;
  closed: boolean;
}

const WS_OPEN = WebSocket.OPEN;

export class GatewayServer {
  private http: Server | null = null;
  private wssMcp: WebSocketServer | null = null;
  private wssAi: WebSocketServer | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly tokens: Set<string>;
  private readonly heartbeatTimeoutMs: number;
  private readonly disconnectGraceMs: number;

  private channels = new Map<string, Channel>();
  private byPairingCode = new Map<string, string>();
  private mcpConns = new Set<McpConn>();
  private aiConns = new Set<AiConn>();

  readonly metrics: GatewayMetrics;

  constructor(private opts: GatewayOptions = {}) {
    this.tokens = new Set(opts.tokens ?? []);
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.disconnectGraceMs = opts.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
    this.metrics = {
      startTime: Date.now(),
      mcpConnections: 0,
      aiConnections: 0,
      channelsCreated: 0,
      channelsActive: 0,
      channelsClosed: 0,
      pairingAttempts: 0,
      pairingFailures: 0,
      msgsRouted: 0,
      bytesRouted: 0,
      slowConsumerDrops: 0,
      authFailures: 0,
    };
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ port: number; url: string }> {
    this.http = createServer((req, res) => this.handleHttp(req, res));

    this.wssMcp = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    this.wssAi = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });

    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/v1/mcp" && this.wssMcp) {
        this.wssMcp.handleUpgrade(req, socket, head, (ws) => {
          this.wssMcp!.emit("connection", ws, req);
        });
      } else if (url.pathname === "/v1/ai" && this.wssAi) {
        this.wssAi.handleUpgrade(req, socket, head, (ws) => {
          this.wssAi!.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wssMcp.on("connection", (ws) => this.onMcpConnection(ws));
    this.wssAi.on("connection", (ws) => this.onAiConnection(ws));

    const port = await new Promise<number>((resolve, reject) => {
      this.http!.listen(this.opts.port ?? 0, this.opts.host ?? "0.0.0.0", () => {
        const addr = this.http!.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("listen failed"));
      });
      this.http!.on("error", reject);
    });

    this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    if (this.sweepTimer.unref) this.sweepTimer.unref();

    const host = this.opts.host ?? "0.0.0.0";
    return { port, url: `ws://${host}:${port}` };
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const c of this.mcpConns) { c.closed = true; try { c.ws.close(); } catch { /* noop */ } }
    for (const c of this.aiConns) { c.closed = true; try { c.ws.close(); } catch { /* noop */ } }
    this.mcpConns.clear();
    this.aiConns.clear();
    this.wssMcp?.close();
    this.wssAi?.close();
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    this.http = null;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, channels: this.channels.size }));
      return;
    }
    if (url.pathname === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...this.metrics,
        uptimeSec: Math.round((Date.now() - this.metrics.startTime) / 1000),
        channelsTracked: this.channels.size,
      }));
      return;
    }
    res.writeHead(404).end("not found");
  }

  // ------------------------------------------------------------ MCP side

  private onMcpConnection(ws: WebSocket): void {
    const conn: McpConn = {
      id: `mcp_${randomBytes(6).toString("hex")}`,
      ws,
      tokenId: "",
      lastSeen: Date.now(),
      channels: new Set(),
      closed: false,
    };

    // 首帧必须是 auth，5s 内没收到就断开
    const authTimer = setTimeout(() => {
      if (!conn.tokenId && !conn.closed) {
        this.sendMcp(conn, { type: "auth.error", reason: "auth timeout" });
        this.closeMcp(conn, 4001, "auth timeout");
      }
    }, 5000);
    if (authTimer.unref) authTimer.unref();

    ws.on("message", (buf) => {
      const raw = buf.toString("utf-8");
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // 非法帧忽略
      }
      conn.lastSeen = Date.now();

      // 未认证：只接受 auth
      if (!conn.tokenId) {
        clearTimeout(authTimer);
        if (msg?.type === "auth" && typeof msg.token === "string") {
          this.authMcp(conn, msg.token);
        } else {
          this.sendMcp(conn, { type: "auth.error", reason: "first message must be auth" });
          this.closeMcp(conn, 4001, "no auth");
        }
        return;
      }

      this.handleMcpMessage(conn, msg, raw);
    });

    ws.on("close", () => this.onMcpGone(conn, false));
    ws.on("error", () => { /* close 事件会跟上 */ });
  }

  private authMcp(conn: McpConn, token: string): void {
    if (!TOKEN_RE.test(token) || !this.tokens.has(token)) {
      this.metrics.authFailures++;
      this.sendMcp(conn, { type: "auth.error", reason: "bad token" });
      this.closeMcp(conn, 4001, "bad token");
      return;
    }
    // 同一 token 的旧连接被顶掉（MCP 重连时旧 socket 可能还没断）
    for (const c of this.mcpConns) {
      if (c !== conn && c.tokenId === token && !c.closed) {
        this.closeMcp(c, 4000, "replaced by new connection");
      }
    }
    conn.tokenId = token;
    this.mcpConns.add(conn);
    this.metrics.mcpConnections++;
    this.sendMcp(conn, { type: "auth.ok", mcpId: conn.id });
    // 自动接管该 token 名下所有未关闭信道（断线重连无缝恢复）
    for (const ch of this.channels.values()) {
      if (ch.tokenId === token && ch.state !== "closed") {
        this.attachMcp(ch, conn);
      }
    }
  }

  private handleMcpMessage(conn: McpConn, msg: any, raw: string): void {
    switch (msg?.type) {
      case "channel.create": {
        const channelId = `ch_${randomBytes(9).toString("hex")}`;
        const pairingCode = generatePairingCode();
        const now = Date.now();
        const ch: Channel = {
          id: channelId,
          name: typeof msg.name === "string" ? msg.name : "channel",
          tokenId: conn.tokenId,
          pairingCode,
          pairingExpiresAt: now + PAIRING_TTL_MS,
          state: "waiting",
          mcp: conn,
          ai: null,
          aiName: null,
          createdAt: now,
          mcpLostAt: null,
          msgsRouted: 0,
        };
        this.channels.set(channelId, ch);
        this.byPairingCode.set(pairingCode, channelId);
        conn.channels.add(channelId);
        this.metrics.channelsCreated++;
        this.sendMcp(conn, {
          type: "channel.created",
          reqId: msg.reqId,
          channelId,
          pairingCode,
          aiUrl: this.aiUrl(),
          expiresAt: ch.pairingExpiresAt,
        });
        return;
      }
      case "channel.attach": {
        const attached: string[] = [];
        const missing: string[] = [];
        for (const id of msg.channels ?? []) {
          const ch = this.channels.get(id);
          if (ch && ch.tokenId === conn.tokenId && ch.state !== "closed") {
            this.attachMcp(ch, conn);
            attached.push(id);
          } else {
            missing.push(id);
          }
        }
        this.sendMcp(conn, { type: "channel.attached", reqId: msg.reqId, attached, missing });
        return;
      }
      case "channel.recode": {
        const ch = this.channels.get(msg.channelId);
        if (!ch || ch.tokenId !== conn.tokenId || ch.state === "closed") {
          this.sendMcp(conn, { type: "channel.recoded", reqId: msg.reqId, channelId: msg.channelId, pairingCode: "", expiresAt: 0 });
          return;
        }
        // 旧码作废，发新码（AI 断线重配对用）
        if (ch.pairingCode) this.byPairingCode.delete(ch.pairingCode);
        const pairingCode = generatePairingCode();
        ch.pairingCode = pairingCode;
        ch.pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
        this.byPairingCode.set(pairingCode, ch.id);
        this.sendMcp(conn, {
          type: "channel.recoded", reqId: msg.reqId,
          channelId: ch.id, pairingCode, expiresAt: ch.pairingExpiresAt,
        });
        return;
      }
      case "channel.close": {
        const ch = this.channels.get(msg.channelId);
        if (ch && ch.tokenId === conn.tokenId) this.closeChannel(ch, "mcp_closed");
        return;
      }
      case "ping": {
        this.sendMcp(conn, { type: "pong", ts: msg.ts ?? Date.now() });
        return;
      }
      case "msg": {
        // 数据面：只读外层 ch，原始字符串零拷贝直转
        const ch = this.channels.get(msg.ch);
        if (!ch || ch.mcp !== conn || ch.state === "closed") return;
        this.forwardToAi(ch, raw);
        return;
      }
      default:
        return; // 未知类型忽略
    }
  }

  /** MCP（重）连上后把信道挂回去 */
  private attachMcp(ch: Channel, conn: McpConn): void {
    const wasLost = ch.state === "mcp_lost";
    ch.mcp = conn;
    ch.mcpLostAt = null;
    ch.state = ch.ai ? "active" : "waiting";
    conn.channels.add(ch.id);
    if (wasLost && ch.ai) {
      this.sendAi(ch.ai, { type: "peer.join" });
    }
  }

  private onMcpGone(conn: McpConn, _bySweep: boolean): void {
    if (conn.closed) return;
    conn.closed = true;
    this.mcpConns.delete(conn);
    const now = Date.now();
    for (const id of conn.channels) {
      const ch = this.channels.get(id);
      if (!ch || ch.mcp !== conn || ch.state === "closed") continue;
      ch.mcp = null;
      ch.state = "mcp_lost";
      ch.mcpLostAt = now;
      if (ch.ai) {
        this.sendAi(ch.ai, { type: "peer.leave", reason: "mcp_lost", graceMs: this.disconnectGraceMs });
      }
    }
    conn.channels.clear();
  }

  // ------------------------------------------------------------ AI side

  private onAiConnection(ws: WebSocket): void {
    const conn: AiConn = {
      id: `ai_${randomBytes(6).toString("hex")}`,
      ws,
      channelId: null,
      aiName: "ai",
      lastSeen: Date.now(),
      closed: false,
    };

    const joinTimer = setTimeout(() => {
      if (!conn.channelId && !conn.closed) {
        this.sendAi(conn, { type: "join.error", reason: "join timeout" });
        this.closeAi(conn, 4001, "join timeout");
      }
    }, 30_000);
    if (joinTimer.unref) joinTimer.unref();

    ws.on("message", (buf) => {
      const raw = buf.toString("utf-8");
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      conn.lastSeen = Date.now();

      if (!conn.channelId) {
        clearTimeout(joinTimer);
        if (msg?.type === "join") {
          this.joinAi(conn, msg);
        } else {
          this.sendAi(conn, { type: "join.error", reason: "first message must be join" });
          this.closeAi(conn, 4001, "no join");
        }
        return;
      }

      const ch = this.channels.get(conn.channelId);
      if (!ch || ch.ai !== conn) {
        this.sendAi(conn, { type: "channel.closed", reason: "closed" });
        this.closeAi(conn, 4000, "channel gone");
        return;
      }
      switch (msg?.type) {
        case "ping":
          this.sendAi(conn, { type: "pong", ts: msg.ts ?? Date.now() });
          return;
        case "msg":
          // 防串信道：ch 必须与绑定的一致
          if (msg.ch !== ch.id) return;
          this.forwardToMcp(ch, raw);
          return;
        default:
          return;
      }
    });

    ws.on("close", () => this.onAiGone(conn));
    ws.on("error", () => { /* close 事件会跟上 */ });
  }

  private joinAi(conn: AiConn, msg: any): void {
    this.metrics.pairingAttempts++;
    const code = msg?.pairingCode;
    if (!isValidPairingCode(code)) {
      this.metrics.pairingFailures++;
      this.sendAi(conn, { type: "join.error", reason: "bad code format" });
      this.closeAi(conn, 4001, "bad code");
      return;
    }
    const channelId = this.byPairingCode.get(code);
    const ch = channelId ? this.channels.get(channelId) : undefined;
    if (!ch || ch.state === "closed" || ch.pairingCode !== code) {
      this.metrics.pairingFailures++;
      this.sendAi(conn, { type: "join.error", reason: "unknown or expired code" });
      this.closeAi(conn, 4001, "bad code");
      return;
    }
    if (Date.now() > ch.pairingExpiresAt) {
      this.metrics.pairingFailures++;
      this.byPairingCode.delete(code);
      ch.pairingCode = null;
      this.sendAi(conn, { type: "join.error", reason: "code expired" });
      this.closeAi(conn, 4001, "expired");
      return;
    }
    if (ch.ai && !ch.ai.closed) {
      this.metrics.pairingFailures++;
      this.sendAi(conn, { type: "join.error", reason: "channel already paired" });
      this.closeAi(conn, 4001, "paired");
      return;
    }
    // 配对成功：配对码一次性作废
    this.byPairingCode.delete(code);
    ch.pairingCode = null;
    ch.ai = conn;
    ch.aiName = msg?.ai?.name ?? "ai";
    conn.channelId = ch.id;
    conn.aiName = ch.aiName ?? "ai";
    ch.state = ch.mcp ? "active" : "mcp_lost";
    this.aiConns.add(conn);
    this.metrics.aiConnections++;
    if (ch.state === "active") this.metrics.channelsActive++;
    this.sendAi(conn, { type: "joined", channelId: ch.id });
    if (ch.mcp) {
      this.sendMcp(ch.mcp, { type: "peer.join", channelId: ch.id, ai: { name: ch.aiName } });
    }
  }

  private onAiGone(conn: AiConn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.aiConns.delete(conn);
    const ch = conn.channelId ? this.channels.get(conn.channelId) : undefined;
    if (!ch || ch.ai !== conn || ch.state === "closed") return;
    ch.ai = null;
    ch.aiName = null;
    if (ch.state === "active") {
      ch.state = "waiting";
      this.metrics.channelsActive--;
    }
    if (ch.mcp) {
      this.sendMcp(ch.mcp, { type: "peer.leave", channelId: ch.id, reason: "ai_left" });
    }
    // 信道保留：MCP 可用 channel.recode 发新配对码重新配对
  }

  // ------------------------------------------------------------ 数据面（零拷贝转发）

  /** MCP → AI：raw 是原始字符串，直接送，不重组 */
  private forwardToAi(ch: Channel, raw: string): void {
    const ai = ch.ai;
    if (!ai || ai.closed || ai.ws.readyState !== WS_OPEN) return;
    if (ai.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER_BYTES) {
      this.metrics.slowConsumerDrops++;
      this.closeAi(ai, 1013, "slow consumer");
      return;
    }
    ai.ws.send(raw);
    this.metrics.msgsRouted++;
    this.metrics.bytesRouted += raw.length;
    ch.msgsRouted++;
  }

  /** AI → MCP：同理 */
  private forwardToMcp(ch: Channel, raw: string): void {
    const mcp = ch.mcp;
    if (!mcp || mcp.closed || mcp.ws.readyState !== WS_OPEN) return;
    if (mcp.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER_BYTES) {
      this.metrics.slowConsumerDrops++;
      this.closeMcp(mcp, 1013, "slow consumer");
      return;
    }
    mcp.ws.send(raw);
    this.metrics.msgsRouted++;
    this.metrics.bytesRouted += raw.length;
    ch.msgsRouted++;
  }

  // ------------------------------------------------------------ 存活扫描

  /** 单一定时器：MCP 心跳超时 → mcp_lost；宽限期满 → 关闭信道 */
  private sweep(): void {
    const now = Date.now();
    // 慢路径：90s 没收到任何消息也算断线（兜底 TCP 半开）
    for (const conn of [...this.mcpConns]) {
      if (now - conn.lastSeen > this.heartbeatTimeoutMs) {
        try { conn.ws.terminate(); } catch { /* noop */ }
        this.onMcpGone(conn, true);
      }
    }
    for (const conn of [...this.aiConns]) {
      if (now - conn.lastSeen > this.heartbeatTimeoutMs) {
        try { conn.ws.terminate(); } catch { /* noop */ }
        this.onAiGone(conn);
      }
    }
    // 配对码过期清理
    for (const [code, id] of this.byPairingCode) {
      const ch = this.channels.get(id);
      if (!ch || ch.pairingCode !== code || now > ch.pairingExpiresAt) {
        this.byPairingCode.delete(code);
        if (ch && ch.pairingCode === code) ch.pairingCode = null;
      }
    }
    // 宽限期满 → 关闭信道，配对码作废
    for (const ch of this.channels.values()) {
      if (ch.state === "mcp_lost" && ch.mcpLostAt !== null && now - ch.mcpLostAt > this.disconnectGraceMs) {
        this.closeChannel(ch, "grace_expired");
      }
    }
  }

  private closeChannel(ch: Channel, reason: ChannelCloseReason): void {
    if (ch.state === "closed") return;
    const wasActive = ch.state === "active";
    ch.state = "closed";
    if (ch.pairingCode) {
      this.byPairingCode.delete(ch.pairingCode);
      ch.pairingCode = null;
    }
    if (ch.ai && !ch.ai.closed) {
      this.sendAi(ch.ai, { type: "channel.closed", reason });
      this.closeAi(ch.ai, 4000, reason);
    }
    if (ch.mcp && !ch.mcp.closed) {
      this.sendMcp(ch.mcp, { type: "channel.closed", channelId: ch.id, reason });
      ch.mcp.channels.delete(ch.id);
    }
    ch.mcp = null;
    ch.ai = null;
    if (wasActive) this.metrics.channelsActive--;
    this.metrics.channelsClosed++;
  }

  // ------------------------------------------------------------ 小工具

  private aiUrl(): string {
    if (this.opts.publicUrl) return `${this.opts.publicUrl.replace(/\/+$/, "")}/v1/ai`;
    const host = this.opts.host && this.opts.host !== "0.0.0.0" ? this.opts.host : "localhost";
    const port = (this.http?.address() as any)?.port ?? this.opts.port ?? 0;
    return `ws://${host}:${port}/v1/ai`;
  }

  private sendMcp(conn: McpConn, msg: object): void {
    if (conn.closed || conn.ws.readyState !== WS_OPEN) return;
    conn.ws.send(JSON.stringify(msg));
  }

  private sendAi(conn: AiConn, msg: object): void {
    if (conn.closed || conn.ws.readyState !== WS_OPEN) return;
    conn.ws.send(JSON.stringify(msg));
  }

  private closeMcp(conn: McpConn, code: number, reason: string): void {
    conn.closed = true;
    try { conn.ws.close(code, reason); } catch { /* noop */ }
  }

  private closeAi(conn: AiConn, code: number, reason: string): void {
    conn.closed = true;
    try { conn.ws.close(code, reason); } catch { /* noop */ }
  }

  /** 测试用：当前信道快照 */
  channelCount(): number {
    return this.channels.size;
  }
}

/** 生成一个网关 token（64 hex），发给 MCP 配到环境变量里 */
export function generateGatewayToken(): string {
  return randomBytes(32).toString("hex");
}

/** 生成随机的 MCP 身份（演示/测试用） */
export function generateMcpId(): string {
  return `mcp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
