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

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { console.error(e); process.exit(1); });
