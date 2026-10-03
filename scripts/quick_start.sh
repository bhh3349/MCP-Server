#!/bin/bash
#
# MCP-Server 网关一键安装脚本（在目标服务器上直接运行）
#
#   bash -c "$(curl -sSL https://raw.githubusercontent.com/bhh3349/MCP-Server/main/scripts/quick_start.sh)"
#
# 可选环境变量：
#   GATEWAY_PORT   网关端口（默认 8080）
#   GATEWAY_TOKEN  固定 token（64 位 hex），不填则自动生成并打印
#   PUBLIC_URL     对外 AI 接入地址前缀，如 wss://gw.example.com
#   INSTALL_DIR    安装目录（默认 ~/MCP-Server）
#
# 重复执行 = 升级（git pull + 重启网关）。
# 全程无交互，适合 curl | bash。

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bhh3349/MCP-Server.git}"
NODE_DIST_VERSION="v22.17.0"

INSTALL_DIR="${INSTALL_DIR:-$HOME/MCP-Server}"
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
echo "== [1/7] 系统检查 =="
[ "$(uname -s)" = "Linux" ] || die "只支持 Linux 服务器"
case "$(uname -m)" in
  x86_64)      NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "不支持的 CPU 架构: $(uname -m)" ;;
esac
command -v tar >/dev/null || die "需要 tar，请先安装"
log "Linux $(uname -m) 就绪"

# ---------------- 2. Node.js ----------------
echo "== [2/7] Node.js =="
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
  log "下载 Node.js ${NODE_DIST_VERSION} (${NODE_ARCH}) → ${PREFIX}"
  curl -sSL --retry 3 \
    "https://nodejs.org/dist/${NODE_DIST_VERSION}/node-${NODE_DIST_VERSION}-linux-${NODE_ARCH}.tar.gz" \
    | tar -xz -C "$PREFIX" --strip-components=1
  export PATH="$PREFIX/bin:$PATH"
  # 非 root 时把 PATH 写进 shell 配置，保证重启后可用
  if ! is_root; then
    for rc in "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] && grep -q '.local/bin' "$rc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    done
  fi
  node --version >/dev/null || die "Node.js 安装失败"
  log "Node.js $(node --version) 安装完成"
fi

# ---------------- 3. git ----------------
echo "== [3/7] git =="
if ! command -v git >/dev/null 2>&1; then
  warn "未找到 git，尝试自动安装…"
  if command -v apt-get >/dev/null 2>&1; then
    (is_root && apt-get update -qq && apt-get install -y -qq git) || sudo apt-get install -y -qq git || true
  elif command -v dnf >/dev/null 2>&1; then
    (is_root && dnf install -y -q git) || sudo dnf install -y -q git || true
  elif command -v yum >/dev/null 2>&1; then
    (is_root && yum install -y -q git) || sudo yum install -y -q git || true
  elif command -v apk >/dev/null 2>&1; then
    (is_root && apk add --no-cache git) || sudo apk add --no-cache git || true
  fi
  command -v git >/dev/null 2>&1 || die "git 安装失败，请手动安装后重试"
fi
log "git $(git --version | awk '{print $3}') 就绪"

# ---------------- 4. 拉取网关程序 ----------------
echo "== [4/7] 拉取网关程序 =="
# 网关只依赖这几个文件，用 sparse checkout 只取它们（不拉整个仓库）：
#   src/gateway/ + src/channel/pairing.ts + package.json/lock + tsconfig.json
SPARSE_PATTERNS="src/gateway/ /src/channel/pairing.ts /package.json /package-lock.json /tsconfig.json"
if [ -d "$INSTALL_DIR/.git" ]; then
  log "更新已有安装：git pull"
  git -C "$INSTALL_DIR" pull --ff-only || warn "git pull 失败，继续用本地代码"
else
  log "克隆网关程序 → $INSTALL_DIR"
  if ! git clone --depth 1 --filter=blob:none --no-checkout "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    warn "partial clone 不可用，回退到普通克隆"
    git clone --depth 1 --no-checkout "$REPO_URL" "$INSTALL_DIR" || die "克隆失败，请检查网络 / 仓库地址"
  fi
fi
# 收敛到 sparse（老的全量安装也会被清理到只剩网关文件）
git -C "$INSTALL_DIR" sparse-checkout init --no-cone 2>/dev/null || true
# shellcheck disable=SC2086
git -C "$INSTALL_DIR" sparse-checkout set $SPARSE_PATTERNS 2>/dev/null || die "sparse checkout 失败"
git -C "$INSTALL_DIR" checkout -q 2>/dev/null || true
log "网关文件就绪：$(du -sh "$INSTALL_DIR" 2>/dev/null | awk '{print $1}')"

# ---------------- 5. 安装依赖并构建 ----------------
echo "== [5/7] 安装依赖并构建 =="
cd "$INSTALL_DIR"
# npm ci：删掉旧 node_modules 按锁文件干净重装，避免残留导致缺包
npm ci --no-audit --no-fund || die "npm ci 失败"
npm run build || die "构建失败"
log "构建完成"

# ---------------- 6. 写入配置 ----------------
echo "== [6/7] 写入配置并启动 =="
mkdir -p "$GW_HOME"
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
# 即使脚本正文里含有 gateway/cli.js 字样也不会自杀。
if [ -f "$GW_HOME/gateway.pid" ]; then
  kill "$(cat "$GW_HOME/gateway.pid")" 2>/dev/null || true
  sleep 2
fi
pkill -f '^node .*gateway/cli\.js' 2>/dev/null || true

# 双重 fork 启动 daemon：子 shell 后台启动后立刻退出，
# daemon 被 init 接管，当前 shell 不会等它（否则脚本挂起）
set -a; . "$GW_HOME/gateway.env"; set +a
(setsid node dist/gateway/cli.js --pidfile "$GW_HOME/gateway.pid" \
  >> "$GW_HOME/gateway.log" 2>&1 < /dev/null &)
sleep 3
[ -f "$GW_HOME/gateway.pid" ] || die "网关启动失败，看日志：tail -50 $GW_HOME/gateway.log"
log "网关进程 PID $(cat "$GW_HOME/gateway.pid")"

# ---------------- 7. 健康检查 ----------------
echo "== [7/7] 健康检查 =="
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
  base="$PUBLIC_URL"
else
  pub_ip=$(curl -s -m 5 ifconfig.me 2>/dev/null || echo '<服务器IP>')
  case "$pub_ip" in *:*) pub_ip="[$pub_ip]" ;; esac
  base="ws://${pub_ip}:${PORT}"
fi
echo "  MCP 接入: ${base}/v1/mcp   (token 认证)"
echo "  AI  接入: ${base}/v1/ai    (配对码加入)"
echo "  MCP token: $TOKEN"
[ "$TOKEN_GENERATED" = "1" ] && echo "  ↑ token 为本次自动生成，请妥善保存"
echo "  日志: tail -f $GW_HOME/gateway.log"
echo "  升级: 重新运行本脚本即可"
echo "  ─────────────────────────────"
