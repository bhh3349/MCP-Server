/**
 * MCP-Server: build the MCP server with all tools registered.
 * Transport-agnostic: use with stdio or Streamable HTTP.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { VERSION } from "./version.js";
import {
  ReadFileInput, readFile,
  WriteFileInput, writeFile,
  ListFilesInput, listFiles,
  FileHashInput, fileHash,
  DeleteFileInput, deleteFile,
  MoveFileInput, moveFile,
} from "./tools/files.js";
import { ExecInput, exec, JobOutputInput, jobOutput, JobKillInput, jobKill } from "./tools/commands.js";import { systemInfo, health, HealthInput, ServerInfoInput, serverInfo, ProcessListInput, processList } from "./tools/system.js";
import { HttpRequestInput, httpRequest } from "./tools/http.js";
import { ClipboardReadInput, clipboardRead, ClipboardWriteInput, clipboardWrite } from "./tools/clipboard.js";
import { ScreenshotInput, screenshot } from "./tools/screenshot.js";
import {
  MouseMoveInput, mouseMove, MouseClickInput, mouseClick,
  MouseDragInput, mouseDrag, MouseScrollInput, mouseScroll,
  KeyTypeInput, keyType, KeyPressInput, keyPress, HotkeyInput, hotkey,
} from "./tools/computer.js";
import { ExtensionRegistry } from "./extensions/registry.js";
import { ChannelManager } from "./channel/manager.js";
import { Bridge } from "./bridge/pipe.js";
import { ToolStats } from "./dashboard/stats.js";
import {
  ChannelCreateInput, channelCreate,
  channelList,
  ChannelCloseInput, channelClose,
  ChannelRecodeInput, channelRecode,
  ChannelShareInput, channelShare,
} from "./tools/channels.js";

export interface ServerOptions {
  /** 扩展目录，默认 ./extensions */
  extensionsDir?: string;
  /** 是否注册信道管理工具（信道数据面的嵌套 server 设为 false，避免递归） */
  withChannels?: boolean;
  /** 工具调用统计（dashboard 模式注入；嵌套 server 透传即可一并统计） */
  stats?: ToolStats;
}

export async function buildServer(opts: ServerOptions = {}): Promise<{
  server: McpServer;
  extensions: ExtensionRegistry;
}> {
  const server = new McpServer({ name: "mcp-server", version: VERSION });

  // 工具调用统计：包裹 registerTool，所有工具（含扩展注册的）自动采集调用次数/错误/耗时。
  // 注意：必须在扩展加载和工具注册之前包裹。
  const stats = opts.stats;
  if (stats) {
    const origRegister = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
      ...args: unknown[]
    ) => {
      const [name, config, handler] = args as [
        string,
        { description?: string },
        (a: never) => Promise<unknown>,
      ];
      // 采集工具目录（description 供 dashboard 展示）
      if (config?.description) stats.describe(name, config.description);
      const wrapped = async (a: unknown) => {
        const t0 = Date.now();
        try {
          const r = await handler(a as never);
          stats.record(name, Date.now() - t0, true);
          return r;
        } catch (e) {
          stats.record(name, Date.now() - t0, false, e);
          throw e;
        }
      };
      return origRegister(name, config, wrapped);
    };
  }

  // ---- files ----
  server.registerTool("read_file", {
    description: "Read a file: text mode (line-paged) or byte mode (startByte/maxBytes). encoding=utf8|base64.",
    inputSchema: ReadFileInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await readFile(args), null, 2) }] }));

  server.registerTool("write_file", {
    description: "Atomically write a file (temp + rename). expectedHash = SHA-256 precondition or 'absent'.",
    inputSchema: WriteFileInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await writeFile(args), null, 2) }] }));

  server.registerTool("list_files", {
    description: "List directory entries with size/mtime/type. Supports glob filter and pagination.",
    inputSchema: ListFilesInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listFiles(args), null, 2) }] }));

  server.registerTool("file_hash", {
    description: "SHA-256 hash of a file.",
    inputSchema: FileHashInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await fileHash(args), null, 2) }] }));

  server.registerTool("delete_file", {
    description: "Delete a file or directory (recursive:true for non-empty dirs).",
    inputSchema: DeleteFileInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await deleteFile(args), null, 2) }] }));

  server.registerTool("move_file", {
    description: "Move/rename a file or directory. overwrite:true to replace existing dest.",
    inputSchema: MoveFileInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await moveFile(args), null, 2) }] }));

  // ---- commands ----
  server.registerTool("exec", {
    description: "Run a shell command. Foreground returns full result; background:true returns a job object, then job_output.",
    inputSchema: ExecInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await exec(args), null, 2) }] }));

  server.registerTool("job_output", {
    description: "Poll a background job. Same job-object shape as exec/job_kill.",
    inputSchema: JobOutputInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await jobOutput(args), null, 2) }] }));

  server.registerTool("job_kill", {
    description: "Kill a background job. Same job-object shape; output so far is kept.",
    inputSchema: JobKillInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await jobKill(args), null, 2) }] }));

  // ---- system ----
  server.registerTool("system_info", {
    description: "Host system information.",
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await systemInfo(), null, 2) }] }));

  server.registerTool("health", {
    description: "Server health check.",
    inputSchema: HealthInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await health(), null, 2) }] }));

  server.registerTool("server_info", {
    description: "Self-description: version, capabilities, limits, concurrency model, sandbox boundary. Read first.",
    inputSchema: ServerInfoInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await serverInfo(), null, 2) }] }));

  server.registerTool("process_list", {
    description: "List running processes (pid, name, cpu, mem). Optional name filter.",
    inputSchema: ProcessListInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await processList(args), null, 2) }] }));

  // ---- http ----
  server.registerTool("http_request", {
    description: "Fetch a URL (GET/POST/PUT/PATCH/DELETE/HEAD). Returns status/headers/body. Body cap 5MB.",
    inputSchema: HttpRequestInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await httpRequest(args), null, 2) }] }));

  // ---- clipboard ----
  server.registerTool("clipboard_read", {
    description: "Read text from system clipboard.",
    inputSchema: ClipboardReadInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await clipboardRead(args), null, 2) }] }));

  server.registerTool("clipboard_write", {
    description: "Write text to system clipboard.",
    inputSchema: ClipboardWriteInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await clipboardWrite(args), null, 2) }] }));

  // ---- screenshot ----
  server.registerTool("screenshot", {
    description: "Capture the primary screen as PNG (base64).",
    inputSchema: ScreenshotInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await screenshot(args), null, 2) }] }));

  // ---- computer use ----
  server.registerTool("mouse_move", {
    description: "Move mouse cursor to screen coordinates.",
    inputSchema: MouseMoveInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await mouseMove(args), null, 2) }] }));

  server.registerTool("mouse_click", {
    description: "Click mouse (left/right/middle, 1-3 clicks for double-click). Optional x/y, else current position.",
    inputSchema: MouseClickInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await mouseClick(args), null, 2) }] }));

  server.registerTool("mouse_drag", {
    description: "Drag mouse from (fromX,fromY) to (toX,toY).",
    inputSchema: MouseDragInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await mouseDrag(args), null, 2) }] }));

  server.registerTool("mouse_scroll", {
    description: "Scroll wheel. Positive delta = up, negative = down.",
    inputSchema: MouseScrollInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await mouseScroll(args), null, 2) }] }));

  server.registerTool("key_type", {
    description: "Type text as keystrokes.",
    inputSchema: KeyTypeInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await keyType(args), null, 2) }] }));

  server.registerTool("key_press", {
    description: "Press a single key: enter/tab/esc/space/arrows/delete/backspace/f1..f12 or a character.",
    inputSchema: KeyPressInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await keyPress(args), null, 2) }] }));

  server.registerTool("hotkey", {
    description: "Press a key combo, e.g. ctrl+c, ctrl+shift+s, alt+f4 (join with +).",
    inputSchema: HotkeyInput,
  }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await hotkey(args), null, 2) }] }));

  // ---- extensions: plugins / skills / connectors ----
  const extensions = new ExtensionRegistry(
    server,
    opts.extensionsDir ?? process.env["MCP_EXTENSIONS_DIR"] ?? "./extensions",
  );
  await extensions.loadAll();

  // ---- channels: Bridge + 网关信道管理 ----
  // ChannelManager 是进程级单例：N 条信道共享，Bridge 按网关复用。
  // makeServer 懒加载：只有建立信道时才建数据面的嵌套 McpServer。
  if (opts.withChannels !== false) {
    const mgr = new ChannelManager(
      new Bridge({ gatewayUrl: "", autoReconnect: false }),
      () => buildServer({ ...opts, withChannels: false }).then((r) => r.server),
    );
    const mgrRef = { current: mgr };

    server.registerTool("channel_create", {
      description: "经网关建立信道（步骤1）：MCP→网关，返回 pairingCode + mcpUrl，把它们发给网页 AI join（步骤2）。",
      inputSchema: ChannelCreateInput,
    }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await channelCreate(mgrRef.current, args), null, 2) }] }));

    server.registerTool("channel_list", {
      description: "列出全部信道及其状态（是否已配对、存活、延迟、统计）。",
    }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await channelList(mgrRef.current), null, 2) }] }));

    server.registerTool("channel_close", {
      description: "关闭一条信道（通知网关，清理本地状态）。",
      inputSchema: ChannelCloseInput,
    }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await channelClose(mgrRef.current, args), null, 2) }] }));

    server.registerTool("channel_recode", {
      description: "给网关信道换发配对码（AI 断线重配对用，旧码作废）。",
      inputSchema: ChannelRecodeInput,
    }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await channelRecode(mgrRef.current, args), null, 2) }] }));

    server.registerTool("channel_share", {
      description: "获取分享文本：mcpUrl + 配对码（发给 AI 即可 join）。",
      inputSchema: ChannelShareInput,
    }, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await channelShare(mgrRef.current, args), null, 2) }] }));
  }

  return { server, extensions };
}
