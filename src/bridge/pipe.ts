/**
 * Bridge — 管道组件（传输层）。
 *
 * 这是一条巨大的管道，平时是关闭的，只有启动时才打开。
 * 管道一旦打开，MCP Server 和网关之间就可以双向传输数据。
 *
 * Bridge 本身不理解业务协议，它只负责：
 * - 建立到底层传输（到网关的长连接）
 * - 双向转发数据
 * - 关闭时清理
 *
 * 建信道的协议逻辑在 ../channel/。
 */
import { EventEmitter } from "node:events";

export type BridgeState = "closed" | "opening" | "open" | "error";

export interface BridgeOptions {
  gatewayUrl: string;
  /** 心跳间隔 ms */
  heartbeatMs?: number;
}

export class Bridge extends EventEmitter {
  private state: BridgeState = "closed";
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: BridgeOptions) {
    super();
  }

  getState(): BridgeState {
    return this.state;
  }

  /** 打开管道 */
  async open(): Promise<void> {
    if (this.state === "open" || this.state === "opening") return;
    this.state = "opening";
    this.emit("state", this.state);

    // TODO: 实际的传输建立（WebSocket / SSE 长连接）
    // const ws = new WebSocket(this.opts.gatewayUrl + "/bridge");
    // await once(ws, "open");

    this.state = "open";
    this.emit("state", this.state);
    this.emit("open");

    // 心跳保活
    const hb = this.opts.heartbeatMs ?? 30000;
    this.heartbeatTimer = setInterval(() => this.emit("heartbeat"), hb);
  }

  /** 关闭管道 */
  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.state = "closed";
    this.emit("state", this.state);
    this.emit("close");
  }

  /** 通过管道发送数据（管道必须已打开） */
  send(data: string | Buffer): void {
    if (this.state !== "open") throw new Error("bridge is not open");
    // TODO: ws.send(data)
    this.emit("send", data);
  }
}
