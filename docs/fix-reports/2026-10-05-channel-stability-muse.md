# 2026-10-05 稳定性修复：信道半开检测 + 会话 GC + 助手工具兜底 + 断线宽限期

## 背景

四路 AI 压测（2026-10-05）发现两个严重稳定性问题：
1. 网关信道闲置 30-40 分钟后永久挂死（0 字节响应，不自愈）
2. 客户端异常退出后本地信道会话永久锁死（`Server already initialized`）

Bo 明确断线宽限期策略：
- MCP 侧断线：15 分钟内重连信道不关闭
- AI 侧断线：5 分钟内重连信道不关闭
- 超时后信道关闭，配对码失效

## 修复 1：Bridge 半开连接检测

**文件**：`src/bridge/pipe.ts`

**问题**：心跳每 30s 发 ping，但不检查 pong。NAT/代理静默丢弃连接后，ping 发出去无回包，客户端却认为连接正常，导致请求永久挂起。

**修复**：
- 新增 `lastMsgAt` 时间戳，每次收到网关消息时更新
- 心跳定时器中检查：若 `Date.now() - lastMsgAt > 2 * heartbeatMs`（60s），判定为半开连接
- 主动 `ws.terminate()` 触发重连流程，并打 warn 日志

```ts
this.heartbeatTimer = setInterval(() => {
  if (Date.now() - this.lastMsgAt > hb * 2) {
    console.warn(`[bridge] 连接疑似半开（${...}s 无消息），主动重连`);
    this.emit("stale");
    try { this.ws?.terminate(); } catch { /* ignore */ }
    return;
  }
  // ... 正常发 ping
}, hb);
```

## 修复 2：本地信道会话 GC

**文件**：`src/local/channel-server.ts`

**问题**：`activeSessions` 是无超时 Set。客户端崩溃未发 DELETE 时，会话永久占用 transport，新客户端 initialize 报 `Server already initialized`，只能重启进程。

**修复**：
- `activeSessions` 改为 `Map<string, number>`（sessionId → 最后活跃时间）
- 每次带 sessionId 的请求更新时间戳
- 新增 5 分钟定时 GC：30 分钟无活动的会话自动删除并尝试关闭
- `stop()` 时清理定时器

## 修复 3：监控助手工具调用兜底

**文件**：`src/dashboard/agent.ts`

**问题**：LongCat 模型直接输出裸工具名（如 `channels`）而不按 JSON/标签格式，`parseToolCall` 识别失败，助手只回显工具名不执行。

**修复**：`parseToolCall` 增加兜底——若输出 trim 后恰好是已知工具名，直接视为无参工具调用。

## 修复 4：断线宽限期（Bo 明确策略）

**文件**：`src/gateway/protocol.ts`、`src/gateway/server.ts`

**策略**：
- MCP 侧断线：15 分钟内重连，信道不关闭（`DISCONNECT_GRACE_MS` 从 10 分钟改为 15 分钟）
- AI 侧断线：5 分钟内重连，信道不关闭（新增 `AI_DISCONNECT_GRACE_MS`）
- 超时后信道关闭，配对码失效

**实现**：
- `Channel` 新增 `aiLostAt` 时间戳，AI 断开时记录
- AI 重连（配对）成功时清除 `aiLostAt`
- 定时 GC：`waiting` 状态且 `aiLostAt` 超 5 分钟 → `closeChannel(ch, "ai_grace_expired")`
- 新增关闭原因 `"ai_grace_expired"`

## 验证

- `npx tsc --noEmit` 通过
- Windows 本地 `npm run build` 通过（退出码 0）
- 待：24h 长跑验证半开检测与会话 GC 实际生效
