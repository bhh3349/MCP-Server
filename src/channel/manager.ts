/**
 * 信道管理模块（MCP 侧）。
 *
 * MCP 是所有信道的枢纽：不管有多少条信道，最终都连接到 MCP。
 * 本模块负责：
 * 1. 信道全生命周期：建立（两步协议）、查询、移除；
 * 2. 信道连接监控：存活状态、延迟、流量统计；
 * 3. 信道对端 AI 信息：哪个 AI 通过哪条信道接入，上线/离线；
 * 4. 为多 AI 协作任务提供基础：按能力查找 AI、向指定 AI 发任务
 *    （协作编排逻辑后续实现，数据结构先就位）。
 *
 * 两步建信道：
 * 步骤1（MCP → 网关）：MCP 通过 Bridge 管道发建信道请求，
 *   网关返回 { bindingId, pairingCode, mcpUrl }，网关↔MCP 双向信道建立。
 * 步骤2（网页AI → 网关 → join）：用户把 mcpUrl + 配对码给网页 AI，
 *   网关按配对码把两端接在一起，MCP 收到 ai_joined 通知。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { Bridge } from "../bridge/pipe.js";
import type { Bridge as BridgeType } from "../bridge/pipe.js";
import { isValidPairingCode, generatePairingCode } from "./pairing.js";
import {
  newLivenessRecord,
  onHeartbeat,
  onTransportDown,
  resumeLiveness,
  sweepLiveness,
  type LivenessRecord,
} from "./liveness.js";
import { AIInfo, type AISession } from "./ai.js";
import {
  LocalChannelServer,
  type LocalChannelInfo,
} from "../local/channel-server.js";
import { GatewayClient } from "./gateway-client.js";
import { GatewayChannelSession } from "./gateway-dataplane.js";

export type ChannelKind = "gateway" | "local";

export const EstablishInput = z.object({
  gatewayUrl: z.string().url(),
  /** 网关凭证：64 hex，仅用于向网关鉴权，绝不外泄 */
  token: z.string().regex(/^[0-9a-fA-F]{64}$/, "token must be 64 hex chars"),
  name: z.string().default("channel"),
});

/** 网关返回的建信道结果（步骤1） */
export const EstablishResponse = z.object({
  bindingId: z.string(),
  /** 配对码由网关生成，12 位，与 token 无关 */
  pairingCode: z.string().refine(isValidPairingCode, "bad pairing code format"),
  /** 给网页 AI 的 MCP 地址 */
  mcpUrl: z.string().url(),
});

/** 信道完整状态（监控视图） */
export interface ChannelStatus {
  bindingId: string;
  kind: ChannelKind;
  name: string;
  gatewayUrl: string;
  mcpUrl: string;
  /** 步骤2 是否完成（AI 已接入） */
  paired: boolean;
  liveness: LivenessRecord["state"];
  /** 心跳 RTT 毫秒，null = 未测到 */
  latencyMs: number | null;
  ai: AISession | null;
  stats: ChannelStats;
  createdAt: number;
}

export interface ChannelStats {
  requestsIn: number; // 网关→MCP（AI 调工具）
  requestsOut: number; // MCP→网关
  errors: number;
}

interface ChannelRecord {
  bindingId: string;
  kind: ChannelKind;
  name: string;
  gatewayUrl: string;
  mcpUrl: string;
  pairingCode: string;
  /** 网关凭证：只存内存，永不外泄（本地信道为空） */
  token: string;
  createdAt: number;
  liveness: LivenessRecord;
  latencyMs: number | null;
  ai: AISession | null;
  stats: ChannelStats;
  /** 本地信道的 HTTP 服务（gateway 信道为 null） */
  localServer: LocalChannelServer | null;
  /** 网关信道的数据平面会话（本地信道为 null） */
  gwSession: GatewayChannelSession | null;
  /** 所属网关客户端（gateway 信道） */
  gwClient: GatewayClient | null;
}

/** token → bindingId（sha256 公式，与网关一致） */
export function deriveBindingId(token: string): string {
  return createHash("sha256").update(token.toLowerCase()).digest("hex").slice(0, 32);
}

export class ChannelManager {
  private channels = new Map<string, ChannelRecord>();
  /** 配对码 → bindingId（本地索引，方便 join 通知快速定位） */
  private byPairingCode = new Map<string, string>();
  /** gatewayUrl → GatewayClient（每个网关一条管道，N 条信道共享） */
  private gwClients = new Map<string, { client: GatewayClient; token: string }>();
  /** Bridge 总开关（dashboard 用）：false = 用户手动关闭了到网关的管道 */
  private bridgeEnabled = true;

  /**
   * @param bridge Bridge 管道（网关信道用）
   * @param makeServer 建独立 McpServer 的工厂（本地信道用）
   */
  constructor(
    private bridge: Bridge,
    private makeServer?: () => Promise<import("@modelcontextprotocol/server").McpServer>,
  ) {
    // Bridge 意外断开 → 本地信道进入 mcp_lost（网关侧独立倒计时）
    // 重连由 MCP 侧 Bridge 自动发起（退避重连），因为所有信道都连到 MCP。
    this.bridge.on("drop", () => {
      for (const rec of this.channels.values()) {
        rec.liveness = onTransportDown(rec.liveness);
      }
    });
    // Bridge 重连成功 → 向网关发 resume，信道恢复
    this.bridge.on("reconnected", () => {
      for (const rec of this.channels.values()) {
        try {
          rec.liveness = resumeLiveness(rec.liveness);
          this.bridge.send(
            JSON.stringify({
              type: "resume",
              bindingId: rec.bindingId,
              ts: Date.now(),
            }),
          );
        } catch {
          // 信道已被网关关闭：本地清理
          void this.remove(rec.bindingId);
        }
      }
    });
  }

  // ---- 步骤1：建立信道 ----

  /**
   * 取（或建）到指定网关的协议客户端。每个网关一条 Bridge 管道，
   * N 条信道共享；事件统一接到本 manager 做信道管理。
   */
  private async getGatewayClient(gatewayUrl: string, token: string): Promise<GatewayClient> {
    const base = gatewayUrl.replace(/\/+$/, "");
    const existing = this.gwClients.get(base);
    if (existing) return existing.client;

    const bridge = new Bridge({ gatewayUrl: base, token, autoReconnect: true });
    const client = new GatewayClient(bridge);
    this.gwClients.set(base, { client, token });
    this.wireGatewayClient(base, client);

    await client.connect();
    return client;
  }

  /** 网关客户端事件 → 信道状态/数据面 */
  private wireGatewayClient(gatewayUrl: string, client: GatewayClient): void {
    // 数据帧 → 对应信道的数据平面会话
    client.on("data", (channelId: string, data: string) => {
      const rec = this.channels.get(channelId);
      if (!rec?.gwSession) return;
      rec.stats.requestsIn++;
      if (rec.ai) rec.ai.lastActiveAt = Date.now();
      void rec.gwSession.onData(data).catch(() => {
        rec.stats.errors++;
      });
    });
    // AI 配对成功
    client.on("peer.join", (channelId: string, ai: any) => {
      try {
        this.onAIJoined(channelId, {
          id: `gw-${channelId}`,
          name: ai?.name ?? "ai",
          model: "unknown",
          capabilities: [],
        });
      } catch { /* 未知信道，忽略 */ }
    });
    // AI 离开
    client.on("peer.leave", (channelId: string) => this.onAILeft(channelId));
    // 心跳延迟：更新该网关下所有信道的 latencyMs
    client.on("latency", (ms: number) => {
      for (const rec of this.channels.values()) {
        if (rec.kind === "gateway" && rec.gatewayUrl === gatewayUrl) {
          rec.latencyMs = ms;
        }
      }
    });
    // 网关关闭信道
    client.on("channel.closed", (channelId: string) => {
      void this.remove(channelId);
    });
    // 管道断开 → 该网关名下信道进入 mcp_lost 倒计时（网关侧独立计时 10 分钟）
    client.on("drop", () => {
      for (const rec of this.channels.values()) {
        if (rec.kind === "gateway" && rec.gatewayUrl === gatewayUrl) {
          rec.liveness = onTransportDown(rec.liveness);
        }
      }
    });
    // 管道重连成功 → 把旧信道挂回网关
    client.on("reconnected", () => {
      const ids = [...this.channels.values()]
        .filter((r) => r.kind === "gateway" && r.gatewayUrl === gatewayUrl)
        .map((r) => r.bindingId);
      if (ids.length === 0) return;
      client!.attachChannels(ids)
        .then(({ missing }) => {
          for (const rec of this.channels.values()) {
            if (rec.kind !== "gateway" || rec.gatewayUrl !== gatewayUrl) continue;
            if (missing.includes(rec.bindingId)) {
              void this.remove(rec.bindingId); // 网关侧已关闭（宽限期满）
            } else {
              rec.liveness = resumeLiveness(rec.liveness);
            }
          }
        })
        .catch(() => { /* 下次重连再试 */ });
    });
  }

  // ---- 步骤1：建立信道（真实网关往返） ----

  async establish(
    input: z.infer<typeof EstablishInput>,
  ): Promise<{ bindingId: string; pairingCode: string; mcpUrl: string }> {
    const { gatewayUrl, token, name } = EstablishInput.parse(input);

    // 步骤1：MCP → 网关 channel.create，网关返回 {channelId, pairingCode, aiUrl}
    const client = await this.getGatewayClient(gatewayUrl, token);
    const created = await client.createChannel(name);

    const resp = EstablishResponse.parse({
      bindingId: created.channelId,
      pairingCode: created.pairingCode,
      mcpUrl: created.aiUrl,
    });

    const now = Date.now();
    // 数据平面：该信道的独立 McpServer，AI 的 MCP 请求在本机执行
    const session = new GatewayChannelSession(
      resp.bindingId,
      (ch, data) => {
        const rec = this.channels.get(ch);
        if (rec) rec.stats.requestsOut++;
        client.sendData(ch, data);
      },
      async () => {
        if (!this.makeServer) throw new Error("makeServer factory not provided");
        return this.makeServer();
      },
    );
    await session.start();

    const rec: ChannelRecord = {
      bindingId: resp.bindingId,
      kind: "gateway",
      name,
      gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
      mcpUrl: resp.mcpUrl,
      pairingCode: resp.pairingCode,
      token,
      createdAt: now,
      liveness: newLivenessRecord(resp.bindingId, now),
      latencyMs: null,
      ai: null, // 等步骤2：AI join 后才有
      stats: { requestsIn: 0, requestsOut: 0, errors: 0 },
      localServer: null,
      gwSession: session,
      gwClient: client,
    };
    this.channels.set(resp.bindingId, rec);
    this.byPairingCode.set(resp.pairingCode, resp.bindingId);

    return {
      bindingId: resp.bindingId,
      pairingCode: resp.pairingCode,
      mcpUrl: resp.mcpUrl,
    };
  }


  // ---- 本地信道：不经过网关，AI 直连本机 IP ----

  /**
   * 开一条本地信道。
   * 在本机 IP 上起 HTTP 服务，返回一个 URL（自带 token），
   * 用户复制这一个 URL 给 AI 就能连，不用配对码。
   * @param token 可选：固定 token（32 位 hex）；不传随机生成。
   *   轮换 = 换 token 重启；撤销 = 关掉进程。环境变量 MCP_LOCAL_TOKEN 同效。
   */
  async openLocalChannel(
    name = "local",
    port = 0,
    token?: string,
  ): Promise<LocalChannelInfo & { bindingId: string }> {
    if (!this.makeServer) {
      throw new Error("makeServer factory not provided");
    }
    const local = new LocalChannelServer(this.makeServer, port, token);
    const info = await local.start();

    const bindingId = `local-${info.port}`;
    const now = Date.now();
    const rec: ChannelRecord = {
      bindingId,
      kind: "local",
      name,
      gatewayUrl: "",
      mcpUrl: info.url,
      pairingCode: "", // 本地信道不用配对码，URL 自带 token
      token: "",
      createdAt: now,
      liveness: newLivenessRecord(bindingId, now),
      latencyMs: null,
      ai: null,
      stats: { requestsIn: 0, requestsOut: 0, errors: 0 },
      localServer: local,
      gwSession: null,
      gwClient: null,
    };
    this.channels.set(bindingId, rec);
    return { ...info, bindingId };
  }

  /** 本地信道 AI 接入状态同步（从 LocalChannelServer 轮询） */
  syncLocalAI(bindingId: string): void {
    const rec = this.channels.get(bindingId);
    if (!rec || rec.kind !== "local" || !rec.localServer) return;
    const aiName = rec.localServer.connectedAI;
    if (aiName && !rec.ai) {
      // AI 已建会话：记一笔（名字来自 initialize 的 clientInfo）
      this.onAIJoined(
        bindingId,
        { id: `local-${bindingId}`, name: aiName, capabilities: [] },
      );
    } else if (!aiName && rec.ai) {
      this.onAILeft(bindingId);
    }
  }

  // ---- 步骤2：AI 接入/离开（网关通知） ----

  /** 网关通知：AI 用配对码 join 成功 */
  onAIJoined(bindingId: string, ai: z.infer<typeof AIInfo>, now = Date.now()): void {
    const rec = this.channels.get(bindingId);
    if (!rec) throw new Error(`unknown channel ${bindingId}`);
    const parsed = AIInfo.parse(ai);
    rec.ai = {
      ...parsed,
      bindingId,
      joinedAt: now,
      lastActiveAt: now,
      online: true,
    };
    rec.liveness = onHeartbeat(rec.liveness, now);
  }

  /** 网关通知：AI 离开 */
  onAILeft(bindingId: string): void {
    const rec = this.channels.get(bindingId);
    if (rec?.ai) rec.ai.online = false;
  }

  /** AI 有活动（收到工具调用）：刷新 lastActiveAt */
  onAIActivity(bindingId: string, now = Date.now()): void {
    const rec = this.channels.get(bindingId);
    if (rec?.ai) rec.ai.lastActiveAt = now;
    if (rec) rec.stats.requestsIn++;
  }

  // ---- 连接监控 ----

  /** 心跳 pong：刷新存活 + 计算 RTT */
  onHeartbeatAck(bindingId: string, pingTs: number, now = Date.now()): void {
    const rec = this.channels.get(bindingId);
    if (!rec) return;
    rec.liveness = onHeartbeat(rec.liveness, now);
    rec.latencyMs = now - pingTs;
  }

  /** 本地扫描：清理已关闭的信道（网关会主动通知，sweep 是兜底） */
  async sweep(now = Date.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const rec of this.channels.values()) {
      rec.liveness = sweepLiveness(rec.liveness, now);
      if (rec.liveness.state === "closed") {
        closed.push(rec.bindingId);
        await this.remove(rec.bindingId);
      }
    }
    return closed;
  }

  // ---- 查询 ----

  /**
   * Bridge 总开关状态 + 各网关管道状态（dashboard 概览用）。
   * connected=false 可能是用户手动关闭，也可能是网络断开（state 区分）。
   */
  bridgeStatus(): {
    enabled: boolean;
    pipes: { gatewayUrl: string; state: string; connected: boolean; channelCount: number; avgLatencyMs: number | null }[];
  } {
    const pipes = [...this.gwClients.entries()].map(([gatewayUrl, { client }]) => {
      const state = client.getState();
      const recs = [...this.channels.values()].filter(
        (r) => r.kind === "gateway" && r.gatewayUrl.replace(/\/+$/, "") === gatewayUrl,
      );
      const lat = recs.map((r) => r.latencyMs).filter((x): x is number => x !== null);
      return {
        gatewayUrl,
        state,
        connected: state === "open",
        channelCount: recs.length,
        avgLatencyMs: lat.length > 0 ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      };
    });
    return { enabled: this.bridgeEnabled, pipes };
  }

  /**
   * Bridge 总开关：关闭 = 断开所有网关管道（信道进入 mcp_lost，网关侧独立倒计时）；
   * 开启 = 用保存的 url+token 重连所有管道（网关侧宽限期内自动恢复信道）。
   */
  async setBridgeEnabled(on: boolean): Promise<{ enabled: boolean }> {
    this.bridgeEnabled = on;
    if (!on) {
      for (const { client } of this.gwClients.values()) {
        await client.close().catch(() => {});
      }
    } else {
      for (const { client } of this.gwClients.values()) {
        if (client.getState() !== "open") {
          await client.connect().catch(() => {});
        }
      }
    }
    return { enabled: this.bridgeEnabled };
  }

  /** 全部信道状态（监控面板用） */
  listChannels(): ChannelStatus[] {
    return [...this.channels.values()].map((r) => ({
      bindingId: r.bindingId,
      kind: r.kind,
      name: r.name,
      gatewayUrl: r.gatewayUrl,
      mcpUrl: r.mcpUrl,
      paired: r.ai !== null,
      liveness: r.liveness.state,
      latencyMs: r.latencyMs,
      ai: r.ai,
      stats: { ...r.stats },
      createdAt: r.createdAt,
    }));
  }

  /** 全部在线的 AI（多 AI 协作时用） */
  listOnlineAIs(): AISession[] {
    return [...this.channels.values()]
      .map((r) => r.ai)
      .filter((a): a is AISession => a !== null && a.online);
  }

  /** 按能力找 AI（将来任务路由用） */
  findAIsByCapability(cap: string): AISession[] {
    return this.listOnlineAIs().filter((a) => a.capabilities.includes(cap));
  }

  getChannel(bindingId: string): ChannelStatus | undefined {
    const r = this.channels.get(bindingId);
    if (!r) return undefined;
    return {
      bindingId: r.bindingId,
      kind: r.kind,
      name: r.name,
      gatewayUrl: r.gatewayUrl,
      mcpUrl: r.mcpUrl,
      paired: r.ai !== null,
      liveness: r.liveness.state,
      latencyMs: r.latencyMs,
      ai: r.ai,
      stats: { ...r.stats },
      createdAt: r.createdAt,
    };
  }

  /**
   * 给用户复制的分享文本。
   * - 网关信道：mcpUrl + 配对码（不含 token）
   * - 本地信道：URL 本身（含 token），复制一个就行
   */
  shareText(bindingId: string): string {
    const r = this.channels.get(bindingId);
    if (!r) throw new Error(`unknown channel ${bindingId}`);
    if (r.kind === "local") return r.mcpUrl;
    const aiUrl = r.mcpUrl;
    const code = r.pairingCode;
    return [
      `【MCP 配对信息 - 直接发给 AI】`,
      ``,
      `配对: POST ${aiUrl}/claim`,
      `Body: {"pairingCode":"${code}"}`,
      `→ 返回 {"endpoint":"...","bearer":"..."}`,
      ``,
      `调用: POST {endpoint}`,
      `Header: Authorization: Bearer {bearer}`,
      `Body: 标准 MCP JSON-RPC 2.0（先 initialize → notifications/initialized → tools/list）`,
      ``,
      `注意: 用服务端 HTTP 请求，别带 Origin 头。配对码 15 分钟有效。`,
    ].join("\n");
  }

  /**
   * 给网关信道换发配对码（AI 断线重配对用，旧码作废）。
   * 返回新的配对码。
   */
  async recode(bindingId: string): Promise<string> {
    const r = this.channels.get(bindingId);
    if (!r) throw new Error(`unknown channel ${bindingId}`);
    if (r.kind !== "gateway" || !r.gwClient) throw new Error(`channel ${bindingId} is not a gateway channel`);
    const recoded = await r.gwClient.recode(bindingId);
    // 更新本地索引：旧码删除，新码登记
    this.byPairingCode.delete(r.pairingCode);
    r.pairingCode = recoded.pairingCode;
    this.byPairingCode.set(r.pairingCode, bindingId);
    return r.pairingCode;
  }

  async remove(bindingId: string): Promise<boolean> {    const r = this.channels.get(bindingId);
    if (!r) return false;
    this.byPairingCode.delete(r.pairingCode);
    this.bridge.detachChannel(bindingId);
    if (r.localServer) await r.localServer.stop();
    if (r.gwSession) await r.gwSession.stop();
    if (r.gwClient && r.kind === "gateway") {
      r.gwClient.closeChannel(bindingId); // 通知网关（fire-and-forget）
    }
    return this.channels.delete(bindingId);
  }

  get size(): number {
    return this.channels.size;
  }
}
