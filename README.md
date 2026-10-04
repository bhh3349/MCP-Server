# MCP-Server

完整的本地 MCP 系统——完全控制 PC，基础工具开箱即用，可扩展插件 / 技能 / 连接器。

> **概念**：MCP Server 是本地完整系统。Bridge 只是它的一条通道（平时关闭，启动时打开），用于连接网关。一个网关可挂多条信道。

## 架构

```
┌─────────────────────────────────┐
│ MCP Server（本地完整系统）        │
│ - 基础工具：文件 / 命令 / 系统    │
│ - 可扩展：插件 / 技能 / 连接器    │
│ - Bridge 通道：连网关（按需打开） │
│ - 一键部署网关（附带功能）        │
└──────────────┬──────────────────┘
               │ 信道（两步建立）
┌──────────────▼──────────────────┐
│ 网关（一对多条信道）              │
└──────────────┬──────────────────┘
               │ 配对码 join
┌──────────────▼──────────────────┐
│ 网页 AI                          │
└─────────────────────────────────┘
```

## 快速开始

```bash
git clone https://github.com/bhh3349/MCP-Server.git
cd MCP-Server
npm install
npm run dev          # stdio 模式（给本地 MCP 客户端用）
npm test             # 网关测试（17 项：单元 + 集成 + 性能）
```

## 网关部署（公网服务器）

网关是无状态的 WebSocket 服务。部署时**不用本地上传文件**，
在服务器上跑一行命令即可（自动装 Node.js → 拉代码 → 构建 → 启动）：

```bash
bash -c "$(curl -sSL https://raw.githubusercontent.com/bhh3349/MCP-Server/main/scripts/quick_start.sh)"
```

可选环境变量：`GATEWAY_PORT`（默认 8080）、`GATEWAY_TOKEN`（不填自动生成）、
`PUBLIC_URL`（如 `wss://gw.example.com`）、`INSTALL_DIR`。

```bash
GATEWAY_PORT=8080 PUBLIC_URL=wss://gw.example.com \
  bash -c "$(curl -sSL https://raw.githubusercontent.com/bhh3349/MCP-Server/main/scripts/quick_start.sh)"
```

看到 `网关部署成功` 即完成。健康检查：`curl http://IP:8080/healthz`。
重复运行本命令即升级。注意：仓库需为公开，curl 才能拉到脚本。

### 手动部署

```bash
git clone https://github.com/bhh3349/MCP-Server.git
cd MCP-Server
npm install
npm run gateway -- --gen-token   # 生成一个 MCP token，记下来
```

```bash
# 启动（token 配到环境变量）
GATEWAY_TOKENS=<刚才生成的64位token> \
GATEWAY_PORT=8080 \
GATEWAY_PUBLIC_URL=wss://gw.example.com \
  npm run gateway
```

看到 `MCP 接入` / `AI 接入` 地址即成功。健康检查：`curl http://IP:8080/healthz`。

以后升级只用 `git pull` 再重启，不用重新传文件。

### 一键部署脚本

有 SSH 权限的服务器可以直接一键部署（拉代码 → 安装构建 → 写配置 → 起守护进程 → 健康检查）：

```bash
node scripts/deploy-gateway.mjs --host root@1.2.3.4
node scripts/deploy-gateway.mjs --host root@1.2.3.4 --port 8080 \
  --public-url wss://gw.example.com --token <64位hex>
```

不给 `--token` 会自动生成。重复运行即升级（git pull + 重启旧网关）。
日志：`ssh root@1.2.3.4 "tail -f ~/mcp-gateway/gateway.log"`。

### MCP 侧建信道

MCP 连上网关后建信道（两步走）：

1. MCP → 网关 `channel.create` → 返回 `{channelId, pairingCode, aiUrl}`
2. 把 `aiUrl` + 配对码（12 位，一次性，15 分钟有效）给网页 AI → AI join → 双向打通

完整协议见 `docs/GATEWAY_PROTOCOL.md`。

## 工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读文件：文本分页 / 字节模式 / base64 无损二进制 |
| `write_file` | 原子写文件（SHA-256 前置校验 / `absent` 新建语义） |
| `list_files` | 列目录（size/mtime/type，glob 过滤，分页） |
| `file_hash` | 文件 SHA-256 |
| `exec` | 执行 shell 命令（编码安全，支持后台任务） |
| `job_output` / `job_kill` | 后台任务管理（统一作业对象） |
| `system_info` / `health` | 主机信息 / 健康检查 |
| `server_info` | 自描述：版本、能力、限额、并发模型 |

## 本地信道（同一局域网，不经过网关）

```bash
npm run local-channel   # 打印一个 URL（含 token），发给 AI 直连
```

可用 `MCP_LOCAL_TOKEN=32位hex` 固定 token。

## 环境变量

| 变量 | 用途 |
|------|------|
| `MCP_SERVER_ROOT` | 文件工具的根目录（默认 cwd） |
| `MCP_LOCAL_PORT` | 本地信道端口（默认随机） |
| `MCP_LOCAL_TOKEN` | 本地信道固定 token（32 位 hex） |
| `GATEWAY_PORT` | 网关监听端口 |
| `GATEWAY_HOST` | 网关监听地址（默认 0.0.0.0） |
| `GATEWAY_TOKENS` | 网关允许的 MCP token（逗号分隔） |
| `GATEWAY_PUBLIC_URL` | 对外 AI 接入地址前缀（如 wss://gw.example.com） |

## 技术栈

- TypeScript + Node.js 20+
- `@modelcontextprotocol/server` v2（官方 SDK）
- `ws`（网关 WebSocket）
- Zod 参数校验
