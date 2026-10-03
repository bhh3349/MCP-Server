/**
 * 网关 CLI。
 *
 *   npm run gateway                 # 启动网关
 *   npm run gateway -- --gen-token   # 生成一个 MCP token
 *
 * 环境变量：
 *   GATEWAY_PORT=8080            监听端口（默认随机）
 *   GATEWAY_HOST=0.0.0.0          监听地址
 *   GATEWAY_TOKENS=<64hex>,...   允许的 MCP token（逗号分隔）
 *   GATEWAY_PUBLIC_URL=wss://gw.example.com   对外 AI 接入地址前缀
 */
import { GatewayServer, generateGatewayToken } from "./server.js";

async function main() {
  if (process.argv.includes("--gen-token")) {
    console.log(generateGatewayToken());
    return;
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
  console.log("  网关已启动");
  console.log("  ─────────────────────────────");
  console.log(`  MCP 接入: ${url}/v1/mcp   (token 认证)`);
  console.log(`  AI  接入: ${url}/v1/ai    (配对码加入)`);
  console.log(`  健康检查: http://127.0.0.1:${port}/healthz`);
  console.log(`  指标:     http://127.0.0.1:${port}/metrics`);
  console.log(`  已载入 token: ${tokens.length} 个`);
  console.log("  ─────────────────────────────");
  console.log("  按 Ctrl+C 关闭");
  console.log("");

  setInterval(() => {}, 10_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
