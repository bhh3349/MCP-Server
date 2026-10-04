# 网关协议 v1

MCP ↔ 网关 ↔ 网页 AI 的配对与消息管道。一个网关带 N 条信道。

## 接入

| 端点 | 谁连 | 认证 |
|---|---|---|
| `WS /v1/mcp` | MCP（Bridge） | 首帧 `{type:"auth", token}`，token 为 64 位 hex 长期凭证 |
| `WS /v1/ai` | 网页 AI（可选） | 首帧 `{type:"join", pairingCode}`，12 位配对码 |
| `POST /v1/ai/claim` | 网页 AI（HTTP） | Body `{pairingCode, ai?}` → 返回 `{channelId}` |
| `GET /v1/ai/poll?channelId=` | 网页 AI（HTTP） | 长轮询（25s），返回 `{messages: [...]}` |
| `POST /v1/ai/msg` | 网页 AI（HTTP） | Body `{channelId, data}` → 返回 `{ok:true}` |
| `GET /healthz` | 探活 | 无需认证 |
| `GET /metrics` | 指标 | 无需认证 |

> AI 侧推荐用 HTTP（三接口），对标老网关 w2-gw-paircode 的设计；
> WebSocket `/v1/ai` 保留兼容。

token 生成：`npm run gateway -- --gen-token`，配到网关的 `GATEWAY_TOKENS`（逗号分隔）。

## 建信道（两步走）

```
步骤1  MCP → 网关：{type:"channel.create", reqId, name?}
       网关 → MCP：{type:"channel.created", reqId, channelId, pairingCode, aiUrl, expiresAt}
       用户把 aiUrl + pairingCode 给网页 AI

步骤2a（WS） AI → 网关：{type:"join", pairingCode, ai:{name?, model?}}
       网关 → AI：{type:"joined", channelId}

步骤2b（HTTP） AI → 网关：POST /v1/ai/claim {pairingCode, ai:{name?}}
       网关 → AI：{channelId}
       AI → 网关：GET /v1/ai/poll?channelId=…（循环长轮询收消息）
       AI → 网关：POST /v1/ai/msg {channelId, data}（发消息）

       网关 → MCP：{type:"peer.join", channelId, ai:{name}}
       —— 双向打通
```

- 配对码 12 位（去易混淆字符），**一次性**，15 分钟未用失效。
- AI 断线后想重配：MCP 发 `{type:"channel.recode", reqId, channelId}` 换新码（旧码作废）。

## 数据面

四方向统一信封，网关**不透明转发**（只读外层 `type`/`ch` 做路由）：

```json
{ "type": "msg", "ch": "<channelId>", "data": "<MCP JSON-RPC 字符串>" }
```

- MCP → 网关 → AI，AI → 网关 → MCP，信封完全一致，网关转发原始字符串，零拷贝。
- AI 发的 `ch` 必须与 `joined` 的信道一致，否则丢弃（防串信道）。

MCP 侧每条信道跑一个独立 `McpServer`（`InMemoryTransport` 直连），
AI 的 MCP 请求在本机执行，响应原路返回。

## 存活

- MCP 每 30s 发 `{type:"ping", channels, ts}`；网关 90s 未收到判断线（TCP 半开兜底）。
- MCP 断线 → 信道进 `mcp_lost`，AI 收到 `{type:"peer.leave", reason:"mcp_lost", graceMs}`。
- 10 分钟内 MCP 重连（同 token 自动接管旧信道）→ 无缝恢复，AI 收到 `peer.join`。
- 宽限期满 → 信道关闭，配对码作废，AI 收到 `{type:"channel.closed", reason:"grace_expired"}`。
- MCP 主动 `{type:"channel.close"}` → 双向关闭。

## 性能设计

1. **零拷贝转发**：不解析 `data`，不重组 JSON。
2. **O(1) 路由**：全 Map 索引；单一定时器做存活扫描，无 per-channel 定时器。
3. **无压缩**：`perMessageDeflate` 关，延迟可预测（MCP 载荷多为小 JSON）。
4. **背压**：对端 `bufferedAmount` 超 8MB 视为慢消费者，断开并计数（`slowConsumerDrops`），不拖网关内存。
5. **载荷上限**：单帧 32MB（MCP 侧单次读上限 10MB，留余量）。

实测（loopback，单进程，2026-10-03）：

| 指标 | 数值 |
|---|---|
| 顺序往返 RTT p50 / p99 / max | 0ms / 2ms / 5ms |
| 100 信道突发转发吞吐 | ~20k msg/s |
| 慢消费者丢弃 | 0 |

## 错误码

| 场景 | 消息 |
|---|---|
| token 错误 | `{type:"auth.error", reason:"bad token"}` 后断开（4001，不重连） |
| 配对码格式错/未知/过期/已用 | `{type:"join.error", reason}` 后断开 |
| 信道不存在 | `channel.attached` 的 `missing` 列表 |

## 网关运维

```bash
GATEWAY_PORT=8080 GATEWAY_TOKENS=<64hex>,... npm run gateway
GATEWAY_PUBLIC_URL=https://gw.example.com npm run gateway  # aiUrl 用公网地址（http/https）
```

`/metrics` 返回：连接数、信道数、配对尝试/失败、路由消息/字节、慢消费者丢弃、认证失败。
