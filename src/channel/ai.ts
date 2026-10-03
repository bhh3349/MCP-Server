/**
 * 信道对端的 AI 信息。
 *
 * 网页 AI 用配对码 join 信道时上报自己的身份，网关转发给 MCP。
 * MCP 作为所有信道的枢纽，持有每条信道对端 AI 的信息，
 * 为将来的多 AI 协作任务打基础（任务路由、AI 间消息都经 MCP 中转）。
 */
import { z } from "zod";

export const AIInfo = z.object({
  /** AI 身份 ID（网页 AI 生成，join 时上报） */
  id: z.string(),
  /** 显示名，如 "Claude Web"、"ChatGPT" */
  name: z.string(),
  /** 模型名（如果上报了），如 "claude-opus-4-6" */
  model: z.string().optional(),
  /** 能力标签（将来做任务路由用），如 ["code", "search"] */
  capabilities: z.array(z.string()).default([]),
});

export type AIInfo = z.infer<typeof AIInfo>;

/** AI 在信道上的会话状态 */
export interface AISession extends AIInfo {
  bindingId: string;
  joinedAt: number;
  lastActiveAt: number;
  /** AI 侧是否在线（网关通知 join/leave） */
  online: boolean;
}

/** 网关 → MCP：AI 接入通知 */
export const AIJoinedMsg = z.object({
  type: z.literal("ai_joined"),
  bindingId: z.string(),
  ai: AIInfo,
  ts: z.number(),
});

/** 网关 → MCP：AI 离开通知 */
export const AILeftMsg = z.object({
  type: z.literal("ai_left"),
  bindingId: z.string(),
  ts: z.number(),
});
