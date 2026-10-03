/**
 * 信道管理工具：MCP 侧开启 Bridge、建立网关信道、换发配对码。
 *
 * 两步建立流程：
 *   1. channel_create → 返回 {bindingId, pairingCode, mcpUrl}（MCP→网关）
 *   2. 把 mcpUrl + pairingCode 发给网页 AI，AI join 后信道打通（网关→AI）
 */
import { z } from "zod";
import type { ChannelManager } from "../channel/manager.js";

export const ChannelCreateInput = z.object({
  /** 网关地址，如 ws://23.251.34.248:8080（/v1/mcp 由 Bridge 自动拼接） */
  gatewayUrl: z.string().min(1).describe("网关地址，如 ws://23.251.34.248:8080"),
  /** 网关 token（64 位 hex）：MCP 连接网关的长期凭证 */
  token: z.string().min(1).describe("网关 token（64 位 hex）"),
  /** 信道名称（可选，用于区分多条信道） */
  name: z.string().optional(),
});

export const ChannelCloseInput = z.object({
  bindingId: z.string().min(1),
});

export const ChannelRecodeInput = z.object({
  bindingId: z.string().min(1).describe("要换发配对码的网关信道 ID"),
});

export const ChannelShareInput = z.object({
  bindingId: z.string().min(1),
});

export async function channelCreate(mgr: ChannelManager, args: z.infer<typeof ChannelCreateInput>) {
  const { gatewayUrl, token, name } = ChannelCreateInput.parse(args);
  const r = await mgr.establish({ gatewayUrl, token, name: name ?? "channel" });
  return {
    ...r,
    hint: "把 mcpUrl 和 pairingCode 发给网页 AI，AI 用配对码 join 后信道打通（配对码一次性，15 分钟有效）",
  };
}

export async function channelList(mgr: ChannelManager) {
  return mgr.listChannels().map((c) => ({
    bindingId: c.bindingId,
    kind: c.kind,
    name: c.name,
    paired: c.paired,
    liveness: c.liveness,
    latencyMs: c.latencyMs,
    mcpUrl: c.mcpUrl,
    stats: c.stats,
    createdAt: c.createdAt,
  }));
}

export async function channelClose(mgr: ChannelManager, args: z.infer<typeof ChannelCloseInput>) {
  const { bindingId } = ChannelCloseInput.parse(args);
  const ok = await mgr.remove(bindingId);
  return { bindingId, closed: ok };
}

export async function channelRecode(mgr: ChannelManager, args: z.infer<typeof ChannelRecodeInput>) {
  const { bindingId } = ChannelRecodeInput.parse(args);
  const pairingCode = await mgr.recode(bindingId);
  const ch = mgr.getChannel(bindingId);
  return {
    bindingId,
    pairingCode,
    mcpUrl: ch?.mcpUrl ?? "",
    hint: "旧配对码已作废，把新配对码发给 AI 重新 join",
  };
}

export async function channelShare(mgr: ChannelManager, args: z.infer<typeof ChannelShareInput>) {
  const { bindingId } = ChannelShareInput.parse(args);
  return { bindingId, text: mgr.shareText(bindingId) };
}
