/**
 * 信道建立模块。
 *
 * 两步建信道：
 *
 * 步骤1（MCP → 网关）：
 *   MCP 通过 Bridge 管道向网关发送建信道请求，
 *   网关返回信道连接信息 {url, pairingCode}，
 *   此时网关↔MCP 的双向信道已建立。
 *   MCP 可通过信道感知网关延迟 / 健康度。
 *
 * 步骤2（网页AI → 网关 → join）：
 *   用户复制信道连接信息发给网页AI，
 *   网页AI 用 url + pairingCode 向网关发起通信，
 *   网关把相同 pairingCode 的请求连接在一起，
 *   形成 MCP → 网关 → 网页AI 的完整双向信道。
 *
 * 网页AI 随后可通过信道控制 MCP，使用 MCP 内置工具操作 PC，
 * 也可以添加自己的技能 / 插件 / 连接器。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Bridge } from "../bridge/pipe.js";

export const EstablishInput = z.object({
  gatewayUrl: z.string().url(),
  token: z.string().regex(/^[0-9a-fA-F]{64}$/, "token must be 64 hex chars"),
  name: z.string().default("channel"),
});

export interface ChannelInfo {
  /** 信道 ID（网关侧） */
  bindingId: string;
  /** 配对码（即 token） */
  pairingCode: string;
  /** 给网页AI 的 MCP 地址 */
  mcpUrl: string;
  /** 分享链接 */
  shareLink: string;
  gatewayUrl: string;
  name: string;
}

/** token → bindingId（sha256 公式，与网关一致） */
export function deriveBindingId(token: string): string {
  return createHash("sha256").update(token.toLowerCase()).digest("hex").slice(0, 32);
}

export class ChannelManager {
  private channels = new Map<string, ChannelInfo>();

  constructor(private bridge: Bridge) {}

  /**
   * 步骤1：向网关发送建信道请求。
   * 要求 Bridge 管道已打开。
   */
  async establish(input: z.infer<typeof EstablishInput>): Promise<ChannelInfo> {
    const { gatewayUrl, token, name } = EstablishInput.parse(input);
    const pairingCode = token.toLowerCase();
    const bindingId = deriveBindingId(pairingCode);

    if (this.bridge.getState() !== "open") {
      throw new Error("bridge pipe is not open — start the bridge first");
    }

    // TODO: 通过 Bridge 向网关发送 establish 请求，等待网关返回确认。
    // 为保持与网关约定的 URL 格式，本地先按公式拼出连接信息：
    const base = gatewayUrl.replace(/\/+$/, "");
    const info: ChannelInfo = {
      bindingId,
      pairingCode,
      mcpUrl: `${base}/mcp/${bindingId}`,
      shareLink: `${base}/s/${bindingId}/${pairingCode}`,
      gatewayUrl: base,
      name,
    };
    this.channels.set(bindingId, info);

    // TODO: 启动该信道的 pull 循环（网关→MCP 方向），保持双向信道活跃。
    return info;
  }

  list(): ChannelInfo[] {
    return [...this.channels.values()];
  }

  get(bindingId: string): ChannelInfo | undefined {
    return this.channels.get(bindingId);
  }

  remove(bindingId: string): boolean {
    return this.channels.delete(bindingId);
  }
}
