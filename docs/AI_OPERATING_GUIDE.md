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

1. `system_info` — 看操作系统、架构，决定命令写法（Windows 用 PowerShell）。
2. `health` — 确认服务正常。
3. `list_skills` — 看有什么技能包，动手前先查，别重复造轮子。

## 3. 内置工具

### 文件（`src/tools/files.ts`）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `list_files` | 列目录 | `path`，`recursive`（最多 5 层/500 条） |
| `read_file` | 读文本 | `path`，`offset`/`limit` 分页（单次 ≤2000 行） |
| `write_file` | 原子写 | `path`，`content`，`expected_sha256`（防覆盖） |
| `file_hash` | SHA-256 | `path` |

约定：

- 大文件必须分页读，先读前 50 行看结构。
- 改已有文件：先读后写；重要文件写时传 `expected_sha256`。
- 路径用相对路径（相对于服务端 root）或 `C:/...`，不用反斜杠。

### 命令（`src/tools/commands.ts`）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `exec` | 执行命令 | `command`，`timeout_ms`，`background` |
| `job_output` | 查后台输出 | `job_id`，`offset`/`limit` |
| `job_kill` | 杀后台任务 | `job_id` |

约定：

- 超过 1 分钟的任务用 `background=true`，再用 `job_output` 轮询。
- 先跑 `pwd` / `ls` 确认工作目录。

### 系统（`src/tools/system.ts`）

- `system_info`：OS、架构、主机名、CPU/内存。
- `health`：服务健康。

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

```
步骤1: MCP → 网关：发建信道请求 → 网关返回 { mcpUrl, pairingCode }
步骤2: 用户把 mcpUrl + pairingCode 给 AI → AI 向网关 join → 完整双向信道
```

- 配对码 12 位，一次性，15 分钟有效；每个 AI 用独立配对码、独立信道。
- 信道本身永久有效；MCP 断线 10 分钟信道关闭（MCP 侧自动重连）。
- 工具调用突然全部失败 → 告诉用户检查 MCP-Server 是否在线。

## 6. 安全红线

- 不碰用户没授权的敏感文件（密钥、凭证、浏览器数据）。
- 不执行破坏性命令（`rm -rf`、格式化、关机），除非用户明确要求。
- 写文件前确认路径；报错先看信息排查，不盲目重试。

## 7. 给开发者的备注

- 本仓库：https://github.com/bhh3349/MCP-Server
- 官方 SDK v2（`@modelcontextprotocol/server`）+ Zod。
- 本地开发：`npm install && npm run dev`（stdio）。
