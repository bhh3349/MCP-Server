/**
 * Dashboard HTTP API（只绑 127.0.0.1，本地控制中心用）。
 *
 *   GET  /api/overview            版本/uptime/工具数/bridge/统计/错误摘要
 *   GET  /api/channels            信道列表
 *   POST /api/channels            {kind:"local"|"gateway", name, gatewayUrl?, token?, port?} 新建
 *   DELETE /api/channels/:id     关闭信道
 *   POST /api/channels/:id/recode  换发配对码（网关信道）
 *   GET  /api/channels/:id/share 分享文本
 *   GET  /api/bridge              Bridge/网关管道状态
 *   POST /api/bridge              {on:boolean} 总开关
 *   GET  /api/stats/tools         工具调用统计
 *   GET  /api/logs                ?level=&limit=&since=
 *   GET  /api/errors              错误收集
 *   POST /api/errors/:id/ack      标记已处理
 *   GET  /api/extensions          扩展列表
 *   POST /api/extensions/:name/disable
 *   POST /api/tools/call          {name, args} playground 试调
 *   GET  /                        控制中心 UI（静态文件）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile as readFsFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { z } from "zod";
import { buildServer } from "../server.js";
import type { ExtensionRegistry } from "../extensions/registry.js";
import { ChannelManager } from "../channel/manager.js";
import { Bridge } from "../bridge/pipe.js";
import { VERSION } from "../version.js";
import { logStore } from "./logger.js";
import { ToolStats } from "./stats.js";

// ---- 工具 playground 分发表（直接调实现函数，绕开 MCP 协议） ----
import {
  ReadFileInput, readFile, WriteFileInput, writeFile, ListFilesInput, listFiles,
  FileHashInput, fileHash, DeleteFileInput, deleteFile, MoveFileInput, moveFile,
} from "../tools/files.js";
import { ExecInput, exec, JobOutputInput, jobOutput, JobKillInput, jobKill } from "../tools/commands.js";
import { systemInfo, health, HealthInput, serverInfo, ServerInfoInput, ProcessListInput, processList } from "../tools/system.js";
import { HttpRequestInput, httpRequest } from "../tools/http.js";
import { ClipboardReadInput, clipboardRead, ClipboardWriteInput, clipboardWrite } from "../tools/clipboard.js";
import { ScreenshotInput, screenshot } from "../tools/screenshot.js";
import {
  MouseMoveInput, mouseMove, MouseClickInput, mouseClick, MouseDragInput, mouseDrag,
  MouseScrollInput, mouseScroll, KeyTypeInput, keyType, KeyPressInput, keyPress,
  HotkeyInput, hotkey,
} from "../tools/computer.js";

interface ToolDef { schema: z.ZodTypeAny; fn: (args: never) => Promise<unknown>; danger?: boolean }

const TOOL_DISPATCH = new Map<string, ToolDef>([
  ["read_file", { schema: ReadFileInput, fn: (a) => readFile(a) }],
  ["write_file", { schema: WriteFileInput, fn: (a) => writeFile(a), danger: true }],
  ["list_files", { schema: ListFilesInput, fn: (a) => listFiles(a) }],
  ["file_hash", { schema: FileHashInput, fn: (a) => fileHash(a) }],
  ["delete_file", { schema: DeleteFileInput, fn: (a) => deleteFile(a), danger: true }],
  ["move_file", { schema: MoveFileInput, fn: (a) => moveFile(a), danger: true }],
  ["exec", { schema: ExecInput, fn: (a) => exec(a), danger: true }],
  ["job_output", { schema: JobOutputInput, fn: (a) => jobOutput(a) }],
  ["job_kill", { schema: JobKillInput, fn: (a) => jobKill(a) }],
  ["system_info", { schema: z.object({}), fn: () => systemInfo() }],
  ["health", { schema: HealthInput, fn: () => health() }],
  ["server_info", { schema: ServerInfoInput, fn: () => serverInfo() }],
  ["process_list", { schema: ProcessListInput, fn: (a) => processList(a) }],
  ["http_request", { schema: HttpRequestInput, fn: (a) => httpRequest(a) }],
  ["clipboard_read", { schema: ClipboardReadInput, fn: (a) => clipboardRead(a) }],
  ["clipboard_write", { schema: ClipboardWriteInput, fn: (a) => clipboardWrite(a) }],
  ["screenshot", { schema: ScreenshotInput, fn: (a) => screenshot(a) }],
  ["mouse_move", { schema: MouseMoveInput, fn: (a) => mouseMove(a), danger: true }],
  ["mouse_click", { schema: MouseClickInput, fn: (a) => mouseClick(a), danger: true }],
  ["mouse_drag", { schema: MouseDragInput, fn: (a) => mouseDrag(a), danger: true }],
  ["mouse_scroll", { schema: MouseScrollInput, fn: (a) => mouseScroll(a), danger: true }],
  ["key_type", { schema: KeyTypeInput, fn: (a) => keyType(a), danger: true }],
  ["key_press", { schema: KeyPressInput, fn: (a) => keyPress(a), danger: true }],
  ["hotkey", { schema: HotkeyInput, fn: (a) => hotkey(a), danger: true }],
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function uiDir(): string {
  // tsx: src/dashboard/ui；tsc: dist/dashboard/ui（构建时复制）
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "ui");
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export interface DashboardOptions {
  port?: number;
  /** 绑定地址，默认 127.0.0.1（只本机）。DASHBOARD_HOST 可覆盖。 */
  host?: string;
  extensionsDir?: string;
  /**
   * 集成模式：注入主进程的真实实例，dashboard 与 MCP 服务共享同一份状态。
   * 不传则 dashboard 自建实例（独立 `npm run dashboard` 模式，UI 开发用）。
   */
  manager?: ChannelManager;
  stats?: ToolStats;
  extensions?: ExtensionRegistry;
}

export async function startDashboard(opts: DashboardOptions = {}): Promise<{ port: number; url: string }> {
  const startedAt = Date.now();
  const stats = opts.stats ?? new ToolStats();
  logStore.install();

  // 集成模式用主进程的 manager/extensions；独立模式自建（影子实例）
  const mgr: ChannelManager = opts.manager ?? new ChannelManager(
    new Bridge({ gatewayUrl: "", autoReconnect: false }),
    () => buildServer({
      ...(opts.extensionsDir ? { extensionsDir: opts.extensionsDir } : {}),
      stats,
      withChannels: false,
    }).then((r) => r.server),
  );
  const extensions: ExtensionRegistry = opts.extensions ?? (await buildServer({
    ...(opts.extensionsDir ? { extensionsDir: opts.extensionsDir } : {}),
    stats,
  })).extensions;

  const ui = uiDir();

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      logStore.add({ level: "error", source: "dashboard", text: `API 错误: ${(e as Error).message}` });
      if (!res.headersSent) json(res, { error: (e as Error).message }, 500);
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ---- 静态 UI ----
    if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/")) {
      let file = path === "/" ? "/index.html" : path;
      // 防目录穿越
      const safe = normalize(file).replace(/^(\.\.[/\\])+/, "");
      const full = join(ui, safe);
      if (!full.startsWith(ui)) { res.writeHead(403).end(); return; }
      try {
        const st = await stat(full);
        if (st.isDirectory()) { res.writeHead(403).end(); return; }
        const data = await readFsFile(full);
        res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
    }

    if (!path.startsWith("/api/")) { res.writeHead(404).end(); return; }

    // ---- API ----
    if (method === "GET" && path === "/api/overview") {
      const s = stats.summary();
      return json(res, {
        version: VERSION,
        startedAt,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        tools: { count: stats.catalogList().length, list: stats.catalogList() },
        bridge: mgr.bridgeStatus(),
        calls: s,
        errors: logStore.errorStats(),
      });
    }

    if (method === "GET" && path === "/api/channels") {
      // 同步本地信道 AI 接入状态
      for (const c of mgr.listChannels()) {
        if (c.kind === "local") mgr.syncLocalAI(c.bindingId);
      }
      return json(res, mgr.listChannels());
    }

    if (method === "POST" && path === "/api/channels") {
      const body = z.object({
        kind: z.enum(["local", "gateway"]),
        name: z.string().min(1).max(64).default("channel"),
        gatewayUrl: z.string().optional(),
        token: z.string().optional(),
        port: z.number().int().min(0).max(65535).optional(),
      }).parse(await readJsonBody(req));
      if (body.kind === "local") {
        const r = await mgr.openLocalChannel(body.name, body.port ?? 0);
        logStore.add({ level: "info", source: "dashboard", text: `新建本地信道 ${r.bindingId} → ${r.url}` });
        return json(res, { bindingId: r.bindingId, kind: "local", url: r.url, port: r.port });
      }
      if (!body.gatewayUrl || !body.token) {
        return json(res, { error: "gatewayUrl 和 token 必填" }, 400);
      }
      const { channelCreate } = await import("../tools/channels.js");
      const r = await channelCreate(mgr, { gatewayUrl: body.gatewayUrl, token: body.token, name: body.name });
      logStore.add({ level: "info", source: "dashboard", text: `新建网关信道 ${r.bindingId}（配对码已生成）` });
      return json(res, r);
    }

    const chMatch = path.match(/^\/api\/channels\/([^/]+)(\/recode|\/share)?$/);
    if (chMatch?.[1]) {
      const id = decodeURIComponent(chMatch[1]);
      const sub = chMatch[2];
      if (method === "DELETE" && !sub) {
        const { channelClose } = await import("../tools/channels.js");
        return json(res, await channelClose(mgr, { bindingId: id }));
      }
      if (method === "POST" && sub === "/recode") {
        const { channelRecode } = await import("../tools/channels.js");
        return json(res, await channelRecode(mgr, { bindingId: id }));
      }
      if (method === "GET" && sub === "/share") {
        const { channelShare } = await import("../tools/channels.js");
        return json(res, await channelShare(mgr, { bindingId: id }));
      }
    }

    if (method === "GET" && path === "/api/bridge") {
      return json(res, mgr.bridgeStatus());
    }

    if (method === "POST" && path === "/api/bridge") {
      const body = z.object({ on: z.boolean() }).parse(await readJsonBody(req));
      const r = await mgr.setBridgeEnabled(body.on);
      logStore.add({ level: "info", source: "dashboard", text: `Bridge ${body.on ? "开启" : "关闭"}` });
      return json(res, r);
    }

    if (method === "GET" && path === "/api/stats/tools") {
      return json(res, { summary: stats.summary(), tools: stats.list() });
    }

    if (method === "GET" && path === "/api/logs") {
      const level = url.searchParams.get("level") as "info" | "warn" | "error" | "debug" | null;
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1000);
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      const source = url.searchParams.get("source") ?? undefined;
      return json(res, logStore.query({
        ...(level ? { level } : {}),
        limit,
        since,
        ...(source ? { source } : {}),
      }));
    }

    if (method === "GET" && path === "/api/errors") {
      const ackedParam = url.searchParams.get("acked");
      const errSource = url.searchParams.get("source") ?? undefined;
      return json(res, {
        stats: logStore.errorStats(),
        list: logStore.errorList({
          ...(ackedParam === null ? {} : { acked: ackedParam === "true" }),
          ...(errSource ? { source: errSource } : {}),
          limit: Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500),
        }),
      });
    }

    const ackMatch = path.match(/^\/api\/errors\/(\d+)\/ack$/);
    if (method === "POST" && ackMatch?.[1]) {
      const ok = logStore.ackError(parseInt(ackMatch[1], 10));
      return json(res, { ok });
    }

    if (method === "GET" && path === "/api/extensions") {
      return json(res, extensions.list().map((e) => ({
        name: e.manifest.name,
        kind: e.kind,
        version: e.manifest.version,
        description: e.manifest.description,
        enabled: e.enabled,
        toolNames: e.toolNames,
      })));
    }

    const disMatch = path.match(/^\/api\/extensions\/([^/]+)\/disable$/);
    if (method === "POST" && disMatch?.[1]) {
      const ok = await extensions.disable(decodeURIComponent(disMatch[1]));
      return json(res, { ok });
    }

    // 扩展配置写入（如 GitHub connector 的 token）：extensions/<kind>/<name>/config.json
    const cfgMatch = path.match(/^\/api\/extensions\/([^/]+)\/config$/);
    if (method === "POST" && cfgMatch?.[1]) {
      const ext = extensions.get(decodeURIComponent(cfgMatch[1]));
      if (!ext) return json(res, { error: "unknown extension" }, 404);
      const body = await readJsonBody(req);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json(res, { error: "config must be a JSON object" }, 400);
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ext.dir, "config.json"), JSON.stringify(body, null, 2), "utf-8");
      logStore.add({ level: "info", source: "dashboard", text: `扩展 ${ext.manifest.name} 配置已更新` });
      return json(res, { ok: true });
    }

    if (method === "POST" && path === "/api/tools/call") {
      const body = z.object({ name: z.string(), args: z.unknown().default({}) }).parse(await readJsonBody(req));
      const def = TOOL_DISPATCH.get(body.name);
      if (!def) return json(res, { error: `unknown tool: ${body.name}` }, 404);
      const t0 = Date.now();
      try {
        const args = def.schema.parse(body.args);
        const result = await def.fn(args as never);
        stats.record(body.name, Date.now() - t0, true);
        logStore.add({ level: "info", source: "dashboard", text: `playground 调用 ${body.name} 成功 (${Date.now() - t0}ms)` });
        return json(res, { ok: true, danger: !!def.danger, result, ms: Date.now() - t0 });
      } catch (e) {
        stats.record(body.name, Date.now() - t0, false, e);
        return json(res, { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }, 400);
      }
    }

    return json(res, { error: "not found" }, 404);
  }

  const port = opts.port ?? parseInt(process.env["DASHBOARD_PORT"] ?? "18789", 10);
  const host = opts.host ?? process.env["DASHBOARD_HOST"] ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });

  logStore.add({ level: "info", source: "dashboard", text: `dashboard API 已启动 http://${host}:${port}` });
  return { port, url: `http://${host}:${port}` };
}
