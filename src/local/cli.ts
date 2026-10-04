/**
 * 本地信道 CLI。
 *
 *   npm run local-channel
 *
 * 在本机 IP 上开一条本地信道，打印一个 URL。
 * 把这个 URL 发给 AI（同一局域网），AI 直接连，不用配对码。
 * Ctrl+C 关闭。
 */
import { Bridge } from "../bridge/pipe.js";
import { ChannelManager } from "../channel/manager.js";
import { buildServer } from "../server.js";

async function main() {
  const port = process.env["MCP_LOCAL_PORT"]
    ? parseInt(process.env["MCP_LOCAL_PORT"], 10)
    : 0;
  // 固定 token：MCP_LOCAL_TOKEN=32 位 hex。不设则每次随机生成（重启即换 URL）。
  // 轮换 = 换个 token 重启；撤销 = 直接关掉进程。
  const token = process.env["MCP_LOCAL_TOKEN"] || undefined;

  const bridge = new Bridge({ gatewayUrl: "local", autoReconnect: false });
  const mgr = new ChannelManager(
    bridge,
    async () => (await buildServer()).server,
  );

  const ch = await mgr.openLocalChannel("local", port, token);

  console.log("");
  console.log("  本地信道已开启");
  console.log("  ─────────────────────────────");
  console.log(`  URL: ${ch.url}`);
  console.log("  ─────────────────────────────");
  console.log("  把这个 URL 发给 AI 即可连接（需同一局域网）");
  console.log("  按 Ctrl+C 关闭");
  console.log("");

  // 保活
  setInterval(() => {}, 10_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
