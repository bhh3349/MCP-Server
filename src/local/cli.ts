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
import { ToolStats } from "../dashboard/stats.js";
import { logStore } from "../dashboard/logger.js";
import { startDashboard } from "../dashboard/api.js";

async function main() {
  const port = process.env["MCP_LOCAL_PORT"]
    ? parseInt(process.env["MCP_LOCAL_PORT"], 10)
    : 0;
  // 固定 token：MCP_LOCAL_TOKEN=32 位 hex。不设则每次随机生成（重启即换 URL）。
  // 轮换 = 换个 token 重启；撤销 = 直接关掉进程。
  const token = process.env["MCP_LOCAL_TOKEN"] || undefined;

  const bridge = new Bridge({ gatewayUrl: "local", autoReconnect: false });
  // dashboard 与信道内嵌 server 共享同一份工具调用统计
  const stats = new ToolStats();
  logStore.install();
  const mgr = new ChannelManager(
    bridge,
    async () => (await buildServer({ stats, withChannels: false })).server,
  );
  // 扩展注册表（dashboard 展示用）
  const { extensions } = await buildServer({ stats });

  const ch = await mgr.openLocalChannel("local", port, token);

  console.log("");
  console.log("  本地信道已开启");
  console.log("  ─────────────────────────────");
  console.log(`  URL: ${ch.url}`);
  console.log("  ─────────────────────────────");
  console.log("  把这个 URL 发给 AI 即可连接（需同一局域网）");

  if (process.argv.includes("--dashboard")) {
    const { url } = await startDashboard({ manager: mgr, stats, extensions });
    console.log(`  控制中心: ${url}`);
  }

  console.log("  按 Ctrl+C 关闭");
  console.log("");

  // 保活
  setInterval(() => {}, 10_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
