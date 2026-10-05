/**
 * Bridge — 管道组件（传输层）。
 *
 * 这是一条巨大的管道，平时是关闭的，只有启动时才打开。
 * 管道一旦打开，MCP Server 和网关之间就可以双向传输数据。
 *
 * Bridge 本身不理解业务协议，它只负责：
 * - 建立到底层传输（到网关的 WebSocket 长连接 + token 认证）
 * - 双向转发数据
 * - 断线自动重连（退避），关闭时清理
 *
 * 建信道的协议逻辑在 ../channel/gateway-client.ts。
 */
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { HEARTBEAT_INTERVAL_MS } from "../channel/liveness.js";

export type BridgeState = "closed" | "opening" | "open" | "error";

export interface BridgeOptions {
  gatewayUrl: string;
  /** 网关 token（64 hex）：MCP 连接网关的长期凭证 */
  token?: string;
  /** 心跳间隔 ms，默认 30s */
  heartbeatMs?: number;
  /** 是否自动重连（默认 true）；手动 close() 时不重连 */
  autoReconnect?: boolean;
  /** 重连退避序列 ms，默认 [5s, 10s, 30s, 60s]，之后固定 60s */
  reconnectBackoffMs?: number[];
  /** 认证超时 ms，默认 10s */
  authTimeoutMs?: number;
}

const DEFAULT_BACKOFF = [5_000, 10_000, 30_000, 60_000];
const MCP_WS_PATH = "/v1/mcp";

/** 认证失败（坏 token）：永久性错误，不重连，直接抛给调用方 */
export class AuthError extends Error {
  readonly permanent = true;
}

export class Bridge extends EventEmitter {
  private state: BridgeState = "closed";
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  /** 该 Bridge 承载的信道 bindingId 列表，心跳时上报 */
  private channelIds = new Set<string>();
  /** 最后收到网关消息的时间戳，用于检测半开连接 */
  private lastMsgAt = 0;

  constructor(private opts: BridgeOptions) {
    super();
  }

  getState(): BridgeState {
    return this.state;
  }

  attachChannel(bindingId: string): void {
    this.channelIds.add(bindingId);
  }

  detachChannel(bindingId: string): void {
    this.channelIds.delete(bindingId);
  }

  /** 打开管道 */
  async open(): Promise<void> {
    if (this.state === "open" || this.state === "opening") return;
    this.manualClose = false;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  private wsUrl(): string {
    const base = this.opts.gatewayUrl.replace(/\/+$/, "");
    // gatewayUrl 可能是 ws(s):// 或 http(s)://，统一转成 ws(s)://
    const wsBase = base.replace(/^http(s?):\/\//, "ws$1://");
    return `${wsBase}${MCP_WS_PATH}`;
  }

  private async connect(): Promise<void> {
    this.state = "opening";
    this.emit("state", this.state);

    try {
      await this.dial();
    } catch (err) {
      this.state = "error";
      this.emit("state", this.state);
      if (err instanceof AuthError) {
        // 坏 token：永久失败，不重连，如实抛给调用方
        this.emit("auth_failed", (err as Error).message);
        throw err;
      }
      // 瞬时失败：后台按退避重连，但如实告诉调用方这次没连上
      this.scheduleReconnect();
      throw err;
    }

    this.state = "open";
    this.emit("state", this.state);
    this.emit(this.reconnectAttempts > 0 ? "reconnected" : "open");
    this.reconnectAttempts = 0;

    // 心跳：每 30s 上报一次，携带本 Bridge 上的全部信道
    // 同时检测半开连接：若 2 个心跳周期无任何消息，判定连接已死，主动重连
    const hb = this.opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.lastMsgAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMsgAt > hb * 2) {
        // 半开连接：ping 发出去了但没有任何回包（含 pong）
        console.warn(`[bridge] 连接疑似半开（${Math.round((Date.now() - this.lastMsgAt) / 1000)}s 无消息），主动重连`);
        this.emit("stale");
        try { this.ws?.terminate(); } catch { /* ignore */ }
        return;
      }
      this.send(
        JSON.stringify({
          type: "ping",
          channels: [...this.channelIds],
          ts: Date.now(),
        }),
      );
    }, hb);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /** 建连 + token 认证，失败抛错 */
  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(), {
        perMessageDeflate: false,
        maxPayload: 32 * 1024 * 1024,
      });
      this.ws = ws;

      const authTimeout = setTimeout(() => {
        ws.close(4001, "auth timeout");
        reject(new Error("gateway auth timeout"));
      }, this.opts.authTimeoutMs ?? 10_000);
      if (authTimeout.unref) authTimeout.unref();

      ws.on("open", () => {
        // 首帧必须是 auth
        ws.send(JSON.stringify({ type: "auth", token: this.opts.token ?? "" }));
      });

      ws.on("message", (buf) => {
        const raw = buf.toString("utf-8");
        // 认证阶段：等 auth.ok
        if (this.state === "opening") {
          let msg: any;
          try {
            msg = JSON.parse(raw);
          } catch {
            clearTimeout(authTimeout);
            reject(new Error("gateway auth: invalid response"));
            ws.close();
            return;
          }
          if (msg?.type === "auth.ok") {
            clearTimeout(authTimeout);
            this.wire(ws);
            resolve();
          } else {
            clearTimeout(authTimeout);
            reject(new AuthError(`gateway auth failed: ${msg?.reason ?? "unknown"}`));
            ws.close();
          }
          return;
        }
        this.emit("message", raw);
      });

      ws.on("close", () => {
        clearTimeout(authTimeout);
        // opening 阶段断开 = 建连失败
        if (this.state === "opening") {
          reject(new Error("gateway connection closed during auth"));
          return;
        }
        this.onUnexpectedClose();
      });

      ws.on("error", () => {
        // error 后 close 事件会跟上，统一在 close 处理
        if (this.state === "opening") {
          clearTimeout(authTimeout);
          reject(new Error("gateway connection error"));
        }
      });
    });
  }

  /** 认证通过后：把后续消息转成 message 事件 */
  private wire(ws: WebSocket): void {
    ws.removeAllListeners("message");
    ws.on("message", (buf) => {
      this.lastMsgAt = Date.now();
      this.emit("message", buf.toString("utf-8"));
    });
  }

  /** transport 意外断开：走重连流程（快路径的 MCP 侧） */
  private onUnexpectedClose(): void {
    this.clearHeartbeat();
    this.ws = null;
    if (this.state === "open") {
      this.state = "error";
      this.emit("state", this.state);
      this.emit("drop"); // 通知 ChannelManager：信道进入 mcp_lost 倒计时
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    if (this.opts.autoReconnect === false) return;
    if (this.reconnectTimer) return;

    const backoff = this.opts.reconnectBackoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.reconnectAttempts, backoff.length - 1)]!;
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    this.emit("reconnect_scheduled", { attempt: this.reconnectAttempts, delayMs: delay });
  }

  /** 手动关闭管道：不触发重连 */
  async close(): Promise<void> {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    try {
      this.ws?.close(1000, "manual close");
    } catch { /* noop */ }
    this.ws = null;
    this.state = "closed";
    this.emit("state", this.state);
    this.emit("close");
  }

  /** 通过管道发送数据（管道必须已打开） */
  send(data: string | Buffer): void {
    if (this.state !== "open" || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("bridge is not open");
    }
    this.ws.send(data);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
