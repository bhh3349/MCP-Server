/**
 * 网关 CLI。
 *
 *   npm run gateway                 # 启动网关
 *   npm run gateway -- --gen-token   # 生成一个 MCP token
 *   npm run gateway -- --show        # 显示一键连接串（从环境变量读取）
 *   node dist/gateway/cli.js --pidfile ~/mcp-gateway/gateway.pid
 *
 * 环境变量：
 *   GATEWAY_PORT=8080            监听端口（默认随机）
 *   GATEWAY_HOST=0.0.0.0          监听地址
 *   GATEWAY_TOKENS=<64hex>,...   允许的 MCP token（逗号分隔）
 *   GATEWAY_PUBLIC_URL=wss://gw.example.com   对外 AI 接入地址前缀
 */
import { writeFileSync } from "node:fs";
import { GatewayServer, generateGatewayToken } from "./server.js";
import { installCrashHandler } from "../dashboard/crashlog.js";

// 崩溃留痕：网关是常驻公网进程，崩溃快照对定位最关键
installCrashHandler("gateway");

async function main() {
  if (process.argv.includes("--gen-token")) {
    console.log(generateGatewayToken());
    return;
  }
  if (process.argv.includes("--show")) {
    // 重新导出连接信息：一键连接串（复制到 npm run channel 粘贴）
    const tokens = (process.env["GATEWAY_TOKENS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const port = process.env["GATEWAY_PORT"] || "8080";
    const host = process.env["GATEWAY_HOST"] || "0.0.0.0";
    const pub = process.env["GATEWAY_PUBLIC_URL"] || "";
    // 取公网 IP 或用配置的主机名
    let displayHost = host === "0.0.0.0" ? "<服务器IP>" : host;
    if (pub) {
      const m = pub.match(/^wss?:\/\/([^/:]+)(?::(\d+))?/);
      if (m && m[1]) displayHost = m[1];
    }
    if (!tokens.length) {
      console.log("未配置 GATEWAY_TOKENS");
      return;
    }
    console.log("一键连接串（复制到本地 npm run channel 粘贴）:");
    for (const t of tokens) console.log(`  mcp-gw://${t}@${displayHost}:${port}`);
    return;
  }
  const pidfileIdx = process.argv.indexOf("--pidfile");
  const pidfile = pidfileIdx >= 0 ? process.argv[pidfileIdx + 1] : undefined;
  if (pidfile) {
    writeFileSync(pidfile, String(process.pid));
  }

  const tokens = (process.env["GATEWAY_TOKENS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const gw = new GatewayServer({
    port: process.env["GATEWAY_PORT"] ? parseInt(process.env["GATEWAY_PORT"], 10) : 0,
    host: process.env["GATEWAY_HOST"] ?? "0.0.0.0",
    tokens,
    ...(process.env["GATEWAY_PUBLIC_URL"]
      ? { publicUrl: process.env["GATEWAY_PUBLIC_URL"] }
      : {}),
  });

  const { port, url } = await gw.start();
  console.log("");
  console.log(`  网关已启动  (端口 ${port}, 已载入 token: ${tokens.length} 个)`);
  if (tokens.length === 1) console.log(`  MCP token: ${tokens[0]}`);
  else if (tokens.length > 1) console.log(`  MCP token: ${tokens.length} 个 (见 GATEWAY_TOKENS)`);
  console.log(`  健康检查: http://127.0.0.1:${port}/healthz`);
  console.log("  按 Ctrl+C 关闭");
  console.log("");

  // 优雅关闭：SIGTERM/SIGINT → 关网关（通知对端）再退出
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  收到 ${sig}，正在关闭网关…`);
    try {
      await gw.stop();
    } catch { /* noop */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  setInterval(() => {}, 10_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
