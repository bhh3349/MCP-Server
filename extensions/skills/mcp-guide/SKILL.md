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

先调用 `system_info` 看操作系统、架构、主机名；
调用 `health` 确认服务正常。

## 文件操作

- `list_files`：列目录。`recursive=true` 递归（最多 5 层，500 条）。
- `read_file`：读文本文件。**大文件必须分页**：`offset` + `limit`
  （单次最多 2000 行）。先读前 50 行看结构，再决定读哪里。
- `write_file`：原子写入（临时文件 + rename，不会写坏原文件）。
  **改已有文件时先 `read_file` 再写**；重要文件先用 `file_hash`
  取 SHA-256，写入时传 `expected_sha256`，防止覆盖了别人刚改的内容。
- `file_hash`：取文件 SHA-256，用于写入前校验和确认文件一致性。
- 所有路径都是相对于服务端 root 的相对路径；Windows 上用 `C:/...`
  或相对路径，不要混用反斜杠。

## 命令执行

- `exec`：执行 shell 命令（Windows 上是 PowerShell，POSIX 是 sh）。
  - `timeout_ms`：超时时间，默认 30 秒；长时间任务调大或走后台。
  - `background=true`：后台运行，立刻返回 `job_id`；
    再用 `job_output` 轮询输出，`job_kill` 终止。
  - **超过 1 分钟的任务一律用后台模式**，不要让前台调用超时。
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
- 如果用户说"让另一个 AI 也加入"，告诉用户把 MCP 地址和新的配对码
  发给那个 AI（每个 AI 用独立配对码、独立信道）。
- 长时间无操作信道保持；如果工具调用突然全部失败，可能是信道断了，
  告诉用户检查 MCP-Server 是否在线。

## 安全红线

- 不要读/写用户没让你碰的敏感文件（密钥、凭证、浏览器数据）。
- `exec` 不要执行破坏性命令（`rm -rf`、格式化、关机），除非用户明确要求。
- 写文件前确认路径正确；不确定的先 `list_files` 确认。
- 报错先看错误信息自己排查，不要反复重试同一个失败调用。
