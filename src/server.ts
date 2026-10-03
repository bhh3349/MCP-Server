/**
 * MCP-Server: build the MCP server with all tools registered.
 * Transport-agnostic: use with stdio or Streamable HTTP.
 */
import { McpServer } from "@modelcontextprotocol/server";
import {
  ReadFileInput, readFile,
  WriteFileInput, writeFile,
  ListFilesInput, listFiles,
  FileHashInput, fileHash,
} from "./tools/files.js";
import { ExecInput, exec, JobOutputInput, jobOutput, JobKillInput, jobKill } from "./tools/commands.js";
import { systemInfo, health } from "./tools/system.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "mcp-server", version: "0.1.0" });

  // ---- files ----
  server.registerTool("read_file", {
    description: "Read a text file (bounded, line-paged). Path relative to server root.",
    inputSchema: ReadFileInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await readFile(args), null, 2) }] }));

  server.registerTool("write_file", {
    description: "Atomically write a text file (temp + rename). Optional SHA-256 precondition.",
    inputSchema: WriteFileInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await writeFile(args), null, 2) }] }));

  server.registerTool("list_files", {
    description: "List directory entries relative to server root.",
    inputSchema: ListFilesInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listFiles(args), null, 2) }] }));

  server.registerTool("file_hash", {
    description: "SHA-256 hash of a file.",
    inputSchema: FileHashInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await fileHash(args), null, 2) }] }));

  // ---- commands ----
  server.registerTool("exec", {
    description: "Run a shell command with timeout. Use background:true for long tasks, then job_output.",
    inputSchema: ExecInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await exec(args), null, 2) }] }));

  server.registerTool("job_output", {
    description: "Poll a background job's output.",
    inputSchema: JobOutputInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await jobOutput(args), null, 2) }] }));

  server.registerTool("job_kill", {
    description: "Kill a background job.",
    inputSchema: JobKillInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await jobKill(args), null, 2) }] }));

  // ---- system ----
  server.registerTool("system_info", {
    description: "Host system information.",
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await systemInfo(), null, 2) }] }));

  server.registerTool("health", {
    description: "Server health check.",
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await health(), null, 2) }] }));

  return server;
}
