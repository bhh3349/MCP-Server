/**
 * 内嵌监控 agent：服务端执行 LLM 调用 + 工具循环，API key 不落地浏览器。
 */
import type { ModelProvider } from "./providers.js";

export interface ChatMsg { role: "user" | "assistant"; content: string }

const SYSTEM = `你是 MCP-Server 控制中心的内嵌运维助手。你监控本地 MCP 服务器的运行状态，可以查看错误、诊断问题、调整参数。

你可用的工具（一次一个，两种格式任选）：
JSON：{"tool":"health"} / {"tool":"errors","limit":20} / {"tool":"isolate","name":"工具名"}
或标签：<longcat_tool_call>health</longcat_tool_call>
- {"tool":"health"} 获取综合健康状态（工具数、调用统计、最近错误、桥接状态）
- {"tool":"tool_stats"} 获取各工具调用/错误明细
- {"tool":"errors","limit":20} 获取最近错误列表
- {"tool":"isolate","name":"工具名"} 隔离故障工具（暂停调用）
- {"tool":"restore","name":"工具名"} 恢复被隔离的工具
- {"tool":"extensions"} 获取扩展列表及状态
- {"tool":"ext_toggle","name":"扩展名","enabled":true} 启用/禁用扩展
- {"tool":"bridge","on":true} 开关 Bridge
- {"tool":"channels"} 获取信道列表
- {"tool":"loglevel","level":"debug|info|warn|error"} 调整日志级别

规则：
1. 需要数据时先调用工具，不要猜测。
2. 工具返回后，用简洁中文总结给用户，关键数字要准确。
3. 隔离工具、改配置等危险操作，先说明原因再执行。
4. 只输出纯文本回复，或单行工具调用，不要混在一起。`;

async function callLLM(p: ModelProvider, messages: ChatMsg[]): Promise<string> {
  if (p.type === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": p.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: p.model, max_tokens: 2000, system: SYSTEM,
        messages: messages.map((m) => ({ role: m.role, content: m.content })) }),
    });
    if (!r.ok) throw new Error(`LLM 错误 ${r.status}`);
    const d = await r.json() as { content: { text: string }[] };
    return d.content[0]?.text ?? "";
  }
  // openai-compatible
  const base = (p.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.model, max_tokens: 2000,
      messages: [{ role: "system", content: SYSTEM }, ...messages] }),
  });
  if (!r.ok) throw new Error(`LLM 错误 ${r.status}`);
  const d = await r.json() as { choices: { message: { content: string } }[] };
  return d.choices[0]?.message.content ?? "";
}

export type ToolExecutor = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const TOOL_RE = /\{\s*"tool"\s*:\s*"([^"]+)"[^}]*\}/;
// LongCat 等模型的原生工具调用格式：<longcat_tool_call>tool</longcat_tool_call>
// 或带参数 <longcat_tool_call>tool\n{"arg":"v"}</longcat_tool_call>
const LONGCAT_RE = /<longcat_tool_call>\s*([a-z_]+)\s*(?:\n([\s\S]*?))?<\/longcat_tool_call>/;

/** 从模型输出里提取工具调用，支持 JSON 和 LongCat 两种格式 */
function parseToolCall(out: string): { tool: string; args: Record<string, unknown>; strip: RegExp } | null {
  const jm = out.match(TOOL_RE);
  if (jm) {
    try {
      const parsed = JSON.parse(jm[0]) as { tool: string; [k: string]: unknown };
      const { tool, ...args } = parsed;
      if (tool) return { tool, args, strip: TOOL_RE };
    } catch { /* fall through */ }
  }
  const lm = out.match(LONGCAT_RE);
  if (lm && lm[1]) {
    let args: Record<string, unknown> = {};
    const argText = (lm[2] || "").trim();
    if (argText) {
      try { args = JSON.parse(argText) as Record<string, unknown>; } catch { /* ignore */ }
    }
    return { tool: lm[1], args, strip: LONGCAT_RE };
  }
  return null;
}

export async function agentChat(
  provider: ModelProvider,
  history: ChatMsg[],
  userMsg: string,
  exec: ToolExecutor,
  maxSteps = 6,
): Promise<{ reply: string; steps: number }> {
  const messages: ChatMsg[] = [...history.slice(-10), { role: "user", content: userMsg }];
  let steps = 0;
  for (;;) {
    const out = await callLLM(provider, messages);
    messages.push({ role: "assistant", content: out });
    const tc = parseToolCall(out);
    if (!tc || steps >= maxSteps) {
      // 去掉残留的工具调用标记，只保留文本
      const reply = out.replace(TOOL_RE, "").replace(LONGCAT_RE, "").trim() || out.trim();
      return { reply, steps };
    }
    steps++;
    const { tool, args } = tc;
    let result: unknown;
    try { result = await exec(tool, args); }
    catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
    messages.push({ role: "user", content: `[工具 ${tool} 返回]\n${JSON.stringify(result).slice(0, 3000)}` });
  }
  const last = messages[messages.length - 1];
  return { reply: last?.content ?? "", steps };
}
