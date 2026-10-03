/**
 * GatewayClient — 网关协议层（MCP 侧），跑在 Bridge 管道之上。
 *
 * Bridge 是 dumb pipe，只负责传输；本类负责网关协议：
 * - channel.create / attach / recode 的 reqId 请求-响应关联
 * - 收到的 msg / peer.join / peer.leave / channel.closed 转成事件
 *
 * 数据面（MCP 协议载荷）见 ./gateway-dataplane.ts。
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Bridge } from "../bridge/pipe.js";

export interface CreatedChannel {
  channelId: string;
  pairingCode: string;
  aiUrl: string;
  expiresAt: number;
}

export interface AttachedResult {
  attached: string[];
  missing: string[];
}

const REQUEST_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayClient extends EventEmitter {
  private pending = new Map<string, Pending>();

  constructor(private bridge: Bridge) {
    super();
    this.bridge.on("message", (raw: string) => this.onMessage(raw));
    // Bridge 重连/关闭时，所有 pending 请求失败；事件向上传递给 ChannelManager 做存活管理
    this.bridge.on("drop", () => {
      this.failAllPending(new Error("bridge dropped"));
      this.emit("drop");
    });
    this.bridge.on("close", () => {
      this.failAllPending(new Error("bridge closed"));
      this.emit("close");
    });
    this.bridge.on("reconnected", () => this.emit("reconnected"));
  }

  /** 打开底层管道（建连 + token 认证） */
  async connect(): Promise<void> {
    await this.bridge.open();
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }

  getState(): string {
    return this.bridge.getState();
  }

  // ------------------------------------------------ 建信道（两步走之一步）

  /** 建信道 → 返回 {channelId, pairingCode, aiUrl}，用户把后两者给网页 AI */
  async createChannel(name?: string): Promise<CreatedChannel> {
    const res = await this.request("channel.create", { name }, "channel.created");
    return {
      channelId: res.channelId,
      pairingCode: res.pairingCode,
      aiUrl: res.aiUrl,
      expiresAt: res.expiresAt,
    };
  }

  /** 重连后把旧信道挂回网关 */
  async attachChannels(channels: string[]): Promise<AttachedResult> {
    const res = await this.request("channel.attach", { channels }, "channel.attached");
    return { attached: res.attached ?? [], missing: res.missing ?? [] };
  }

  /** 给已有关信道换发配对码（AI 断线重配对用，旧码作废） */
  async recode(channelId: string): Promise<CreatedChannel> {
    const res = await this.request("channel.recode", { channelId }, "channel.recoded");
    if (!res.pairingCode) throw new Error(`recode failed for ${channelId}`);
    return {
      channelId: res.channelId,
      pairingCode: res.pairingCode,
      aiUrl: "",
      expiresAt: res.expiresAt,
    };
  }

  /** 关信道（fire-and-forget） */
  closeChannel(channelId: string): void {
    try {
      this.bridge.send(JSON.stringify({ type: "channel.close", channelId }));
    } catch { /* 管道没开就算了 */ }
  }

  /** 发数据帧（data 是不透明 MCP JSON-RPC 字符串） */
  sendData(channelId: string, data: string): void {
    this.bridge.send(JSON.stringify({ type: "msg", ch: channelId, data }));
  }

  // ------------------------------------------------ 请求-响应

  private request(type: string, params: Record<string, unknown>, expectType: string): Promise<any> {
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`gateway request timeout: ${type}`));
      }, REQUEST_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.bridge.send(JSON.stringify({ type, reqId, ...params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(e);
      }
      // 记下期望的响应类型，onMessage 里校验
      (this.pending.get(reqId) as any).expectType = expectType;
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 请求的响应
    if (msg?.reqId && this.pending.has(msg.reqId)) {
      const p = this.pending.get(msg.reqId)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.reqId);
      p.resolve(msg);
      return;
    }
    // 服务端推送事件
    switch (msg?.type) {
      case "msg":
        // data 不透明，原样交数据面
        this.emit("data", msg.ch, msg.data);
        return;
      case "peer.join":
        this.emit("peer.join", msg.channelId, msg.ai);
        return;
      case "peer.leave":
        this.emit("peer.leave", msg.channelId, msg.reason);
        return;
      case "channel.closed":
        this.emit("channel.closed", msg.channelId, msg.reason);
        return;
      case "pong":
        this.emit("pong", msg.ts);
        return;
      default:
        return;
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
