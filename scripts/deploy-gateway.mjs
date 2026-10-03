#!/usr/bin/env node
/**
 * 一键部署网关到远程服务器
 *
 * 原理：SSH 登录目标机器，从 GitHub 拉取代码，安装、构建、以后台
 * 守护进程方式启动网关。升级时重复运行即可（git pull + 重启）。
 *
 * 用法：
 *   node scripts/deploy-gateway.mjs --host root@1.2.3.4
 *   node scripts/deploy-gateway.mjs --host root@1.2.3.4 --port 8080 \
 *     --public-url wss://gw.example.com --token <64位hex>
 *
 * 参数：
 *   --host         SSH 目标（必填），如 root@1.2.3.4
 *   --port         网关端口（默认 8080）
 *   --token        MCP 接入 token（64 位 hex）；不给则自动生成并打印
 *   --public-url   对外 AI 接入地址前缀，如 wss://gw.example.com
 *   --dir          服务器上的部署目录（默认 ~/MCP-Server）
 *   --repo         Git 仓库地址（默认本项目 GitHub）
 *   --skip-build   跳过 npm install/build（目录已就绪时用）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) {
      const k = cur.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true";
      acc.push([k, v]);
      if (v !== "true") arr[i + 1] = "__consumed__";
    }
    return acc;
  }, []).filter(([, v]) => v !== "__consumed__"),
);

const HOST = args.host;
const PORT = args["port"] || "8080";
const DIR = args.dir || "~/MCP-Server";
const REPO = args.repo || "https://github.com/bhh3349/MCP-Server.git";
const PUBLIC_URL = args["public-url"] || "";
const SKIP_BUILD = args["skip-build"] === "true";
let TOKEN = args.token || "";

if (!HOST) {
  console.error("缺少 --host，例如：node scripts/deploy-gateway.mjs --host root@1.2.3.4");
  process.exit(1);
}
if (!TOKEN) {
  TOKEN = randomBytes(32).toString("hex");
  console.log(`  未指定 --token，已自动生成：${TOKEN}`);
  console.log(`  请妥善保存，MCP 接入网关需要它。`);
}

// 在远端执行命令，返回 stdout
async function ssh(cmd, { verbose = true } = {}) {
  if (verbose) console.log(`  $ ${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`);
  const { stdout } = await execFileAsync("ssh", ["-o", "ConnectTimeout=15", HOST, cmd], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`; // shell 单引号转义

async function main() {
  console.log(`\n[1/6] 检查 SSH 与远端环境`);
  const nodeVer = await ssh("node --version");
  const gitVer = await ssh("git --version");
  console.log(`  远端 node ${nodeVer}，${gitVer}`);

  console.log(`\n[2/6] 拉取代码 ${REPO}`);
  await ssh(
    `if [ -d ${DIR}/.git ]; then ` +
      `git -C ${DIR} pull --ff-only; ` +
      `else git clone ${REPO} ${DIR}; fi`,
  );

  if (!SKIP_BUILD) {
    console.log(`\n[3/6] 安装依赖并构建`);
    await ssh(`cd ${DIR} && npm install --no-audit --no-fund && npm run build`);
  } else {
    console.log(`\n[3/6] 跳过构建（--skip-build）`);
  }

  console.log(`\n[4/6] 写入网关配置`);
  const envContent = [
    `GATEWAY_TOKENS=${TOKEN}`,
    `GATEWAY_PORT=${PORT}`,
    `GATEWAY_HOST=0.0.0.0`,
    ...(PUBLIC_URL ? [`GATEWAY_PUBLIC_URL=${PUBLIC_URL}`] : []),
    "",
  ].join("\n");
  await ssh(
    `mkdir -p ~/mcp-gateway && printf %s ${sh(envContent)} > ~/mcp-gateway/gateway.env && ` +
      `echo "env ok"`,
    { verbose: false },
  );
  console.log(`  配置已写入 ~/mcp-gateway/gateway.env`);

  console.log(`\n[5/6] 重启网关守护进程`);
  // 先停旧的：pidfile 优先，pkill 兜底（中括号写法避免 pkill 自匹配）
  await ssh(
    `if [ -f ~/mcp-gateway/gateway.pid ]; then ` +
      `kill "$(cat ~/mcp-gateway/gateway.pid)" 2>/dev/null; sleep 2; fi; ` +
      `pkill -f '[g]ateway/cli\\.js' 2>/dev/null; true`,
    { verbose: false },
  );
  // 双重 fork 启动 daemon：子 shell 里后台启动后立刻退出，daemon 被 init
  // 接管、不再是 SSH 远端 shell 的子进程。否则远端 bash 会等 daemon 退出
  // 才返回，SSH 通道一直挂起直到超时。网关自己写 pidfile，保证 PID 准确。
  await ssh(
    `cd ${DIR} && set -a && . ~/mcp-gateway/gateway.env && set +a && ` +
      `(setsid node dist/gateway/cli.js --pidfile ~/mcp-gateway/gateway.pid ` +
      `>> ~/mcp-gateway/gateway.log 2>&1 < /dev/null &) && sleep 2 && ` +
      `ps -p "$(cat ~/mcp-gateway/gateway.pid)" -o pid,comm= | tail -1`,
  );

  console.log(`\n[6/6] 健康检查`);
  const health = await ssh(
    `curl -s -m 10 http://127.0.0.1:${PORT}/healthz || echo CURL_FAIL`,
    { verbose: false },
  );
  if (!health.includes('"ok":true')) {
    console.error(`  健康检查失败：${health}`);
    console.error(`  看日志：ssh ${HOST} "tail -50 ~/mcp-gateway/gateway.log"`);
    process.exit(1);
  }
  console.log(`  ${health}`);

  console.log(`\n  部署成功`);
  console.log(`  ─────────────────────────────`);
  console.log(`  网关主机: ${HOST}`);
  const base = PUBLIC_URL || `ws://${HOST.split("@").pop()}:${PORT}`;
  console.log(`  MCP 接入: ${base}/v1/mcp   (token 认证)`);
  console.log(`  AI  接入: ${base}/v1/ai    (配对码加入)`);
  console.log(`  MCP token: ${TOKEN}`);
  console.log(`  日志: ssh ${HOST} "tail -f ~/mcp-gateway/gateway.log"`);
  console.log(`  ─────────────────────────────`);
  console.log(`  下次升级：重新运行本脚本即可（git pull + 重启）\n`);
}

main().catch((err) => {
  console.error(`\n  部署失败：${err.message}`);
  process.exit(1);
});
