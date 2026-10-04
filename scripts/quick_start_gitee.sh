#!/bin/bash
#
# MCP-Server 网关一键安装脚本（在目标服务器上直接运行）
#
#   bash -c "$(curl -sSL https://gitee.com/bhh3349/MCP-Server/raw/main/scripts/quick_start_gitee.sh)"
#
# 原理：下载预构建的单文件网关（含全部依赖），无需 git / npm / 构建。
#
# 可选环境变量：
#   GATEWAY_PORT   网关端口（默认 8080）
#   GATEWAY_TOKEN  固定 token（64 位 hex），不填则自动生成并打印
#   PUBLIC_URL     对外 AI 接入地址前缀，如 wss://gw.example.com
#
# 重复执行 = 升级（重新下载 + 重启网关）。
# 全程无交互，适合 curl | bash。

set -euo pipefail

BUNDLE_URL="${BUNDLE_URL:-https://gitee.com/bhh3349/MCP-Server/raw/main/release/gateway.cjs}"
NODE_DIST_VERSION="v22.17.0"

GW_HOME="$HOME/mcp-gateway"
PORT="${GATEWAY_PORT:-8080}"
TOKEN="${GATEWAY_TOKEN:-}"
PUBLIC_URL="${PUBLIC_URL:-}"

# ---------------- 工具 ----------------
c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'; c_reset='\033[0m'
log()  { echo -e "${c_green}[✔]${c_reset} $*"; }
warn() { echo -e "${c_yellow}[!]${c_reset} $*"; }
die()  { echo -e "${c_red}[✘]${c_reset} $*" >&2; exit 1; }
is_root() { [ "$(id -u)" = "0" ]; }

# ---------------- 1. 系统检查 ----------------
echo "== [1/5] 系统检查 =="
[ "$(uname -s)" = "Linux" ] || die "只支持 Linux 服务器"
case "$(uname -m)" in
  x86_64)      NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "不支持的 CPU 架构: $(uname -m)" ;;
esac
log "Linux $(uname -m) 就绪"

# ---------------- 2. Node.js ----------------
echo "== [2/5] Node.js =="
need_node_install=0
if command -v node >/dev/null 2>&1; then
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  if [ "${major:-0}" -ge 20 ] 2>/dev/null; then
    log "Node.js $(node --version) 已就绪，跳过安装"
  else
    warn "Node.js 版本过低 ($(node --version 2>/dev/null || echo 未知))，将安装新版"
    need_node_install=1
  fi
else
  need_node_install=1
fi
if [ "$need_node_install" = "1" ]; then
  if is_root; then PREFIX="/usr/local"; else PREFIX="$HOME/.local"; fi
  mkdir -p "$PREFIX"
  command -v tar >/dev/null || die "需要 tar，请先安装"
  log "下载 Node.js ${NODE_DIST_VERSION} (${NODE_ARCH}) → ${PREFIX}"
  curl -sSL --retry 3 \
    "https://nodejs.org/dist/${NODE_DIST_VERSION}/node-${NODE_DIST_VERSION}-linux-${NODE_ARCH}.tar.gz" \
    | tar -xz -C "$PREFIX" --strip-components=1
  export PATH="$PREFIX/bin:$PATH"
  if ! is_root; then
    for rc in "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] && grep -q '.local/bin' "$rc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    done
  fi
  node --version >/dev/null || die "Node.js 安装失败"
  log "Node.js $(node --version) 安装完成"
fi

# ---------------- 3. 下载网关 ----------------
echo "== [3/5] 下载网关 =="
mkdir -p "$GW_HOME"
curl -sSL --retry 3 --fail "$BUNDLE_URL" -o "$GW_HOME/gateway.cjs" \
  || die "网关下载失败：$BUNDLE_URL"
[ -s "$GW_HOME/gateway.cjs" ] || die "下载的网关文件为空"
# 简单校验：必须是 Node 可执行的 JS（含网关标识）
grep -q "v1/mcp" "$GW_HOME/gateway.cjs" || die "下载的文件不是有效的网关程序"
log "网关已下载：$(du -h "$GW_HOME/gateway.cjs" | awk '{print $1}')"

# ---------------- 4. 写入配置并启动 ----------------
echo "== [4/5] 写入配置并启动 =="
if [ -z "$TOKEN" ]; then
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  TOKEN_GENERATED=1
else
  TOKEN_GENERATED=0
fi
{
  echo "GATEWAY_TOKENS=$TOKEN"
  echo "GATEWAY_PORT=$PORT"
  echo "GATEWAY_HOST=0.0.0.0"
  [ -n "$PUBLIC_URL" ] && echo "GATEWAY_PUBLIC_URL=$PUBLIC_URL"
} > "$GW_HOME/gateway.env"
log "配置已写入 $GW_HOME/gateway.env"

# 停旧网关：pidfile 优先（精确 PID），pkill 兜底。
# pkill 用 ^node 锚定：daemon 命令行以 node 开头，而本脚本自身是 bash，
# 即使脚本正文里含有 gateway 字样也不会自杀。
if [ -f "$GW_HOME/gateway.pid" ]; then
  kill "$(cat "$GW_HOME/gateway.pid")" 2>/dev/null || true
  sleep 2
fi
pkill -f '^node .*mcp-gateway/gateway\.cjs' 2>/dev/null || true

# 双重 fork 启动 daemon：子 shell 后台启动后立刻退出，daemon 被 init 接管，
# 不再是当前 shell 的子进程（否则 shell 会等 daemon 退出才返回，脚本挂起）。
set -a; . "$GW_HOME/gateway.env"; set +a
(setsid node "$GW_HOME/gateway.cjs" --pidfile "$GW_HOME/gateway.pid" \
  >> "$GW_HOME/gateway.log" 2>&1 < /dev/null &)
sleep 3
[ -f "$GW_HOME/gateway.pid" ] || die "网关启动失败，看日志：tail -50 $GW_HOME/gateway.log"
daemon_pid=$(cat "$GW_HOME/gateway.pid")
ps -p "$daemon_pid" >/dev/null 2>&1 || die "网关进程未存活，看日志：tail -50 $GW_HOME/gateway.log"
log "网关进程 PID $daemon_pid"

# ---------------- 5. 健康检查 ----------------
echo "== [5/5] 健康检查 =="
health=$(curl -s -m 10 "http://127.0.0.1:${PORT}/healthz" || true)
case "$health" in
  *'"ok":true'*)
    log "健康检查通过：$health" ;;
  *)
    die "健康检查失败：${health:-无响应}，看日志：tail -50 $GW_HOME/gateway.log" ;;
esac

# ---------------- 完成 ----------------
echo ""
echo "  网关部署成功"
echo "  ─────────────────────────────"
if [ -n "$PUBLIC_URL" ]; then
  # PUBLIC_URL 可能是 ws(s)://，AI 用 http(s)://
  ws_base="$PUBLIC_URL"
  http_base=$(echo "$PUBLIC_URL" | sed 's|^ws://|http://|; s|^wss://|https://|')
else
  pub_ip=$(curl -s -m 5 ifconfig.me 2>/dev/null || echo '<服务器IP>')
  case "$pub_ip" in *:*) pub_ip="[$pub_ip]" ;; esac
fi
echo "  网关地址: ws://${pub_ip}:${PORT}"
echo "  MCP token: $TOKEN"
[ "$TOKEN_GENERATED" = "1" ] && echo "  ↑ token 为本次自动生成，请妥善保存"
echo ""
echo "  一键连接串（复制到本地 npm run channel 粘贴即可）:"
echo "  mcp-gw://${TOKEN}@${pub_ip}:${PORT}"
echo ""
echo "  日志: tail -f $GW_HOME/gateway.log"
echo "  升级: 重新运行本脚本即可"
echo "  ─────────────────────────────"
