---
name: mcp-guide
description: MCP-Server 操作指南。每次新会话开始时先读本指南。
when: 你通过信道连接到用户的 MCP-Server，需要操作用户 PC 时
---

# MCP-Server 操作指南

你是用户的 AI 助手，通过信道连接到用户 PC 上的 MCP-Server。
MCP-Server 是用户 PC 上的完整本地系统：你可以读写文件、执行命令、
使用插件/技能/连接器扩展能力。

## 第一步：了解环境

先调用 `server_info`：版本、能力、限额、并发模型、沙箱边界一次看清。
再 `system_info` 看操作系统、`health` 确认服务正常。

## 文件操作

- `list_files`：列目录，条目带 `path/name/type/size/mtimeMs`。
  `recursive=true` 递归（最多 5 层）；`glob="*.ts"` 按名过滤；
  `offset`/`limit` 分页（默认 200，上限 1000）。
- `read_file`：两种模式。
  - 文本模式（默认）：按行分页，`offset`（0 基）+ `limit`（上限 2000 行）。
    大文件必须分页。BOM 默认剥离（`stripBom:false` 可保留）。
  - 字节模式：传 `startByte` / `maxBytes` 即启用，按字节切片，
    返回 `totalBytes`/`startByte`/`truncated`，适合大文件定位和二进制。
  - `encoding="base64"`：内容按 base64 返回，**二进制无损**
    （默认 utf8 读二进制有损）。`bytes` = 内容实际字节数。
- `write_file`：原子写入（临时文件 + rename）。
  - `expectedHash`：传文件当前 SHA-256， mismatch 即拒写且文件分毫不动
    （报错 `stale-file` 带**完整**哈希，可直接重试）；
    传 `"absent"` = 要求文件必须不存在（新建专用，取代 sha256("") 偏方）。
  - 回执带 `previousBytes`（覆盖前大小，不存在为 null）和 `overwrote`。
  - **改已有文件时先 `file_hash` 再写**。
- `file_hash`：取文件 SHA-256。
- 错误码前缀（可直接分支）：`file-not-found:` / `is-directory:` /
  `not-a-directory:` / `permission-denied:` / `path-escapes-root:` /
  `stale-file:`。不再有裸 `ENOENT` / `EISDIR`。
- 所有路径都是相对于服务端 root 的相对路径；Windows 上用 `C:/...`
  或相对路径，不要混用反斜杠。

## 命令执行

- `exec`：执行 shell 命令（Windows 上是 PowerShell，POSIX 是 sh）。
  编码安全：中文/引号/特殊字符直传，不会踩 PowerShell 5.1 的引号坑。
  - `timeoutMs`：默认 30000，上限 300000。**超过 1 分钟的任务一律后台化**。
  - 统一作业对象：前台/后台/`job_output`/`job_kill` 回执形状一致——
    `{jobId?, status, done, killed, stdout, stderr, exitCode, durationMs, truncated}`，
    `status` 为 `running` / `done` / `killed`。
  - `background=true`：立刻返回 `jobId`（`status:"running"`），
    用 `job_output` 轮询，`job_kill` 终止（kill 等进程真正退出才返回，
    之后立刻 `job_output` 即得 `done:true`，已产出输出保留）。
  - **要并行必须走后台**：服务端无并发上限（20 路实测并行因子 18），
    但某些客户端会把前台调用串行化。
- 先 `exec` 跑 `pwd` / `ls` 确认工作目录，再做文件操作。

## 扩展能力

- `list_skills`：列出可用技能。每个技能有 `name`/`description`/`when`
  （触发条件）。需要时读资源 `skill://<name>` 看完整步骤。
  **动手前先查技能**，别重复造轮子。
- `list_connectors`：列出连接器（GitHub、邮件等）及其连接状态。
  已连接的连接器工具以 `<连接器名>.<工具名>` 命名，直接调用。
- 插件工具以 `<插件名>.<工具名>` 命名，`tools/list` 里能看到。

## 信道与多 AI

- 你通过一条信道连接 MCP-Server；MCP 侧管理所有信道。
- **心跳探活**：`GET /healthz`（本地信道）免初始化，返回 `{ok, sessions}`。
  不要用 `DELETE` 探活——它只关闭当前会话（token 不受影响，可重建）。
- 如果用户说"让另一个 AI 也加入"，告诉用户把 MCP 地址和新的配对码
  发给那个 AI（每个 AI 用独立配对码、独立信道）。
- 网关信道：用户在 MCP 侧建信道后会拿到配对码+AI 接入地址，
  转交 AI 即可加入；配对码一次性、15 分钟有效，AI 断线可找用户重配。
- 长时间无操作信道保持；如果工具调用突然全部失败，可能是信道断了，
  告诉用户检查 MCP-Server 是否在线。

## 安全红线

- 不要读/写用户没让你碰的敏感文件（密钥、凭证、浏览器数据）。
- `exec` 不要执行破坏性命令（`rm -rf`、格式化、关机），除非用户明确要求。
- 写文件前确认路径正确；不确定的先 `list_files` 确认。
- 报错先看错误信息自己排查，不要反复重试同一个失败调用。
