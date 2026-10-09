/**
 * MCP-Server entry point.
 *
 *   node dist/index.js        → stdio (default, for local MCP clients)
 *
 * Env:
 *   MCP_SERVER_ROOT  filesystem root for file tools (default: cwd)
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";
import { installCrashHandler } from "./dashboard/crashlog.js";

// 崩溃留痕：stdio 模式由 MCP 客户端拉起，崩溃后客户端只看到管道断开，
// 落盘快照是唯一能还原现场的手段
installCrashHandler("stdio");

async function main() {
  const { server } = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { console.error(e); process.exit(1); });
