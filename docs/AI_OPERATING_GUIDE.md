# MCP-Server AI 操作指南

> 本文档面向通过信道接入 MCP-Server 的 AI（网页 AI、其他客户端）。
> 同一份内容也以内置技能形式提供：AI 连接后读 `skill://mcp-guide` 即可。

## 1. 你连到的是什么

MCP-Server 是用户 PC 上的完整本地系统。你通过
`MCP-Server → 网关 → 你` 的双向信道与它通信，可以：

- 读写用户 PC 上的文件
- 执行 shell 命令（前台/后台）
- 调用插件、技能、连接器提供的扩展能力

## 2. 上手三步

1. `server_info` — 版本、能力、限额、并发模型、沙箱边界，一次看清。
2. `system_info` — 看操作系统、架构，决定命令写法（Windows 用 PowerShell）。
3. `list_skills` — 看有什么技能包，动手前先查，别重复造轮子。

## 3. 内置工具

### 文件（`src/tools/files.ts`）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `list_files` | 列目录（条目带 size/mtime/type） | `path`，`recursive`（≤5 层），`glob`，`offset`/`limit` 分页 |
| `read_file` | 读文件：文本模式（行分页）或字节模式 | `offset`/`limit`（≤2000 行）；`startByte`/`maxBytes`（字节模式）；`encoding=utf8\|base64`；`stripBom` |
| `write_file` | 原子写（临时文件 + rename） | `content`，`expectedHash`（SHA-256 或 `"absent"`） |
| `file_hash` | SHA-256 | `path` |

约定：

- 大文件必须分页读，先读前 50 行看结构；二进制用 `encoding="base64"` 无损读取。
- 改已有文件：先 `file_hash` 取当前哈希，写时传 `expectedHash`；
  拒绝时报错 `stale-file`（带完整哈希，可直接重试），且文件分毫不动。
- 新建且要求"绝不能覆盖"：`expectedHash: "absent"`。
- 错误码前缀可直接分支：`file-not-found:` / `is-directory:` /
  `not-a-directory:` / `permission-denied:` / `path-escapes-root:` / `stale-file:`。
- 路径用相对路径（相对于服务端 root）或 `C:/...`，不用反斜杠。

### 命令（`src/tools/commands.ts`）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `exec` | 执行命令（编码安全：中文/引号直传） | `command`，`timeoutMs`（默认 30s，上限 300s），`background`，`maxOutputChars` |
| `job_output` | 查后台作业 | `jobId`，`maxOutputChars` |
| `job_kill` | 杀后台作业（等进程退出才返回） | `jobId` |

统一作业对象（四者回执形状一致）：

```json
{ "jobId": "...", "status": "running|done|killed", "done": true,
  "killed": false, "stdout": "...", "stderr": "...",
  "exitCode": 0, "durationMs": 123, "truncated": false }
```

- 前台 `exec`：直接返回完整结果（无 `jobId`，不可再查）。
- `background=true`：立刻返回 `jobId`（`status:"running"`），
  `job_output` 轮询，`job_kill` 终止；kill 后立即查即得 `done:true`，已产出输出保留。
- **要并行必须走后台**：服务端无并发上限（20 路实测并行因子 18），
  但某些客户端会把前台调用串行化。
- 超过 1 分钟的任务一律后台化；先跑 `pwd` / `ls` 确认工作目录。

### 系统（`src/tools/system.ts`）

- `server_info`：自描述——版本、能力、限额、并发模型、沙箱边界。**先读这个**。
- `system_info`：OS、架构、主机名、CPU/内存。
- `health`：服务健康（`{status, version, uptimeSec}`）。

## 4. 扩展系统

```
extensions/
  plugins/<name>/manifest.json + index.js      # 工具包
  skills/<name>/SKILL.md (+ scripts/)         # 能力说明包
  connectors/<name>/manifest.json + index.js + config.json  # 服务集成
```

| 类型 | 发现方式 | 调用方式 |
|---|---|---|
| 插件 | `tools/list` | `<插件名>.<工具名>` |
| 技能 | `list_skills` | 读 `skill://<name>` 按步骤执行 |
| 连接器 | `list_connectors`（看连接状态） | `<连接器名>.<工具名>` |

## 5. 信道模型

本地直连（当前主用）：

```
MCP 本机起 HTTP → http://<本机IP>:<端口>/mcp/<32 位 token>
用户把这一个 URL 给 AI → AI 直接 initialize 建会话 → tools/list → 开工
```

- token 即凭证：拿到 URL = 控制该主机（`exec` 可执行任意命令），当密钥保管。
- 会话是临时的：`DELETE` 只关当前会话，同一 URL 可随时重建；
  同一 URL 同时只容一个会话。
- 心跳：`GET /healthz` 免 token、免初始化（`{ok, sessions}`）。
- token 默认随机（重启即换）；服务端设 `MCP_LOCAL_TOKEN=32 位 hex`
  可固定。轮换 = 换 token 重启；撤销 = 关进程。

网关模式（已实现，`npm run gateway`）：

```
步骤1: MCP → 网关 channel.create → 网关返回 {channelId, pairingCode, aiUrl}
步骤2: 用户把 aiUrl + pairingCode 给 AI → AI 向网关 join → 完整双向信道
```

- 配对码 12 位，**一次性**，15 分钟未用失效；每个 AI 用独立配对码、独立信道。
- 信道本身永久有效；MCP 断线 10 分钟信道关闭、配对码作废（10 分钟内重连无缝恢复）。
- AI 断线后 MCP 可换发新配对码重配。
- 网关只做不透明转发，不解析你的 MCP 协议内容；一个网关带 N 条信道。
- 完整协议见 `docs/GATEWAY_PROTOCOL.md`。
- 工具调用突然全部失败 → 告诉用户检查 MCP-Server 是否在线。

## 6. 安全红线

- 不碰用户没授权的敏感文件（密钥、凭证、浏览器数据）。
- 不执行破坏性命令（`rm -rf`、格式化、关机），除非用户明确要求。
- 写文件前确认路径；报错先看信息排查，不盲目重试。

## 7. 给开发者的备注

- 本仓库：https://github.com/bhh3349/MCP-Server
- 官方 SDK v2（`@modelcontextprotocol/server`）+ Zod。
- 本地开发：`npm install && npm run dev`（stdio）。
