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
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { sshRunJob, sshGetJob, sshShell, type SshConfig } from "./ssh.js";
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
import { logStore, setLogThreshold, getLogThreshold } from "./logger.js";
import { ToolStats } from "./stats.js";
import { listProviders, getProvider, getActiveProvider, upsertProvider, deleteProvider, setActiveProvider } from "./providers.js";
import type { ModelProvider, ProviderView } from "./providers.js";
import type { ToolExecutor } from "./agent.js";

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

/** WebSocket <-> ssh2 shell 双向桥接（内置 SSH 终端） */
function bridgeSshTerminal(ws: WebSocket, cfg: SshConfig): void {
  let stream: import("ssh2").ClientChannel | undefined;
  const conn = sshShell(
    cfg,
    { cols: 120, rows: 30 },
    (s) => {
      stream = s;
      // shell 就绪，前端收到后可自动下发命令
      try { ws.send(JSON.stringify({ t: "ready" })); } catch { /* ignore */ }
      s.on("data", (d: Buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(d); // 二进制帧，前端流式解码
      });
      s.on("close", () => { try { ws.close(); } catch { /* ignore */ } });
    },
    (msg) => {
      try { ws.send(JSON.stringify({ t: "err", m: msg })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    },
  );
  ws.on("message", (data) => {
    const raw = data.toString();
    let handled = false;
    if (raw.startsWith("{")) {
      try {
        const o = JSON.parse(raw) as { t?: string; d?: string; c?: number; r?: number };
        if (o?.t === "in" && typeof o.d === "string") { stream?.write(o.d); handled = true; }
        else if (o?.t === "rs" && (o.c ?? 0) > 0 && (o.r ?? 0) > 0 && stream) {
          stream.setWindow(o.r as number, o.c as number, 0, 0);
          handled = true;
        }
      } catch { /* 非 JSON，按原始输入处理 */ }
    }
    if (!handled) stream?.write(data as Buffer);
  });
  const cleanup = () => { try { conn.end(); } catch { /* ignore */ } };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

export async function startDashboard(opts: DashboardOptions = {}): Promise<{ port: number; url: string }> {
  const startedAt = Date.now();
  const stats = opts.stats ?? new ToolStats();
  logStore.install();
  // agent 控制状态
  const disabledTools = new Set<string>();
  // 审批模式：approval=危险工具需审批，direct=全部直行
  let approvalMode: "approval" | "direct" = "approval";
  interface Approval {
    id: string; ts: number; tool: string; args: unknown; source: string;
    status: "pending" | "approved" | "rejected"; result?: unknown; error?: string; ms?: number;
    run?: () => Promise<{ result: unknown; ms?: number }>;
  }
  const approvals: Approval[] = [];
  function createApproval(tool: string, args: unknown, source: string, run: () => Promise<{ result: unknown; ms?: number }>): Approval {
    const ap: Approval = { id: randomUUID(), ts: Date.now(), tool, args, source, status: "pending", run };
    approvals.unshift(ap);
    if (approvals.length > 100) approvals.length = 100;
    logStore.add({ level: "warn", source: "dashboard", text: `${tool} 等待审批` });
    return ap;
  }
  // SSH 终端一次性 token（60 秒有效，不进日志）
  const terminalSessions = new Map<string, SshConfig>();

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
      const toolList = stats.list();
      const called = toolList.filter((t) => t.calls > 0);
      const healthy = called.filter((t) => t.errors === 0).length;
      return json(res, {
        version: VERSION,
        startedAt,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        tools: { count: stats.catalogList().length, list: stats.catalogList() },
        bridge: mgr.bridgeStatus(),
        calls: s,
        errors: logStore.errorStats(),
        toolHealth: called.length > 0 ? healthy / called.length : 1,
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

    // ---- Agent 控制接口 ----
    if (method === "GET" && path === "/api/agent/health") {
      const toolList = stats.list();
      const called = toolList.filter((t) => t.calls > 0);
      const errs = logStore.errorList({ limit: 50 });
      return json(res, {
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        tools: { total: stats.catalogList().length, called: called.length,
                 unhealthy: called.filter((t) => t.errors > 0).map((t) => t.name) },
        calls: stats.summary(),
        toolHealth: called.length > 0 ? called.filter((t) => t.errors === 0).length / called.length : 1,
        recentErrors: errs.slice(0, 10).map((e) => ({ id: e.id, ts: e.ts, source: e.source, text: e.text.slice(0, 200) })),
        bridge: mgr.bridgeStatus(),
        disabledTools: [...disabledTools],
        logLevel: getLogThreshold(),
      });
    }

    if (method === "GET" && path === "/api/agent/tools") {
      return json(res, stats.list().map((t) => ({
        name: t.name, calls: t.calls, errors: t.errors,
        errRate: t.errRate, avgMs: Math.round(t.avgMs),
        disabled: disabledTools.has(t.name),
      })));
    }

    const toolToggleMatch = path.match(/^\/api\/agent\/tools\/([^/]+)\/(disable|enable)$/);
    if (method === "POST" && toolToggleMatch?.[1] && toolToggleMatch?.[2]) {
      const name = decodeURIComponent(toolToggleMatch[1]);
      const action = toolToggleMatch[2];
      if (!TOOL_DISPATCH.has(name)) return json(res, { error: `unknown tool: ${name}` }, 404);
      if (action === "disable") disabledTools.add(name); else disabledTools.delete(name);
      logStore.add({ level: "info", source: "agent", text: `工具 ${name} 已${action === "disable" ? "隔离" : "恢复"}` });
      return json(res, { ok: true, disabled: disabledTools.has(name) });
    }

    if (method === "POST" && path === "/api/agent/loglevel") {
      const body = z.object({ level: z.enum(["debug", "info", "warn", "error"]) }).parse(await readJsonBody(req));
      setLogThreshold(body.level);
      logStore.add({ level: "info", source: "agent", text: `日志级别调整为 ${body.level}` });
      return json(res, { ok: true, level: getLogThreshold() });
    }

    // ---- 审批模式 ----
    if (method === "GET" && path === "/api/approval-mode") {
      return json(res, { mode: approvalMode });
    }
    if (method === "POST" && path === "/api/approval-mode") {
      const body = z.object({ mode: z.enum(["approval", "direct"]) }).parse(await readJsonBody(req));
      approvalMode = body.mode;
      logStore.add({ level: "info", source: "dashboard", text: `审批模式切换为${body.mode === "approval" ? "需要审批" : "无需审批"}` });
      return json(res, { ok: true, mode: approvalMode });
    }
    if (method === "GET" && path === "/api/approvals") {
      return json(res, approvals.slice(0, 50));
    }
    const apMatch = path.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
    if (method === "POST" && apMatch?.[1] && apMatch?.[2]) {
      const ap = approvals.find((a) => a.id === apMatch[1]);
      if (!ap) return json(res, { error: "approval not found" }, 404);
      if (ap.status !== "pending") return json(res, { error: `already ${ap.status}` }, 400);
      if (apMatch[2] === "reject") {
        ap.status = "rejected";
        logStore.add({ level: "warn", source: "dashboard", text: `审批已拒绝: ${ap.tool}` });
        return json(res, { ok: true, status: ap.status });
      }
      if (!ap.run) {
        ap.status = "rejected"; ap.error = "no executor";
        return json(res, { ok: true, status: ap.status, error: ap.error });
      }
      try {
        const r = await ap.run();
        ap.status = "approved"; ap.result = r.result;
        if (typeof r.ms === "number") ap.ms = r.ms;
        logStore.add({ level: "info", source: "dashboard", text: `审批通过并执行 ${ap.tool}` });
        return json(res, { ok: true, status: ap.status, result: ap.result, ms: ap.ms });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ap.status = "approved"; ap.error = msg;
        return json(res, { ok: true, status: ap.status, error: msg });
      }
    }

    // ---- 模型供应商 ----
    if (method === "GET" && path === "/api/agent/providers") {
      return json(res, await listProviders());
    }
    if (method === "POST" && path === "/api/agent/providers") {
      const body = z.object({
        id: z.string().optional(),
        name: z.string().min(1),
        type: z.enum(["openai", "anthropic"]),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        model: z.string().min(1),
        enabled: z.boolean().default(true),
      }).parse(await readJsonBody(req));
      try {
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v;
        return json(res, { ok: true, provider: await upsertProvider(clean as Omit<ModelProvider, "id"> & { id?: string }) });
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    const delProvMatch = path.match(/^\/api\/agent\/providers\/([^/]+)$/);
    if (method === "DELETE" && delProvMatch?.[1]) {
      const ok = await deleteProvider(decodeURIComponent(delProvMatch[1]));
      return json(res, { ok });
    }
    // 获取某供应商的可用模型列表（OpenAI 兼容接口走 /models）
    if (method === "POST" && path === "/api/agent/providers/models") {
      const body = z.object({
        id: z.string().optional(),
        type: z.enum(["openai", "anthropic"]).optional(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
      }).parse(await readJsonBody(req));
      let { type, baseUrl, apiKey } = body;
      if ((!apiKey || !type) && body.id) {
        const saved = await getProvider(body.id);
        if (saved) {
          apiKey = apiKey || saved.apiKey || undefined;
          type = type || saved.type;
          baseUrl = baseUrl || saved.baseUrl;
        }
      }
      if (type === "anthropic") {
        return json(res, { error: "Anthropic 官方接口不提供模型列表，请手动填写" }, 400);
      }
      if (!apiKey) return json(res, { error: "请先填写 API Key" }, 400);
      try {
        const url = `${(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/models`;
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return json(res, { error: `模型接口返回 ${r.status}` }, 502);
        const j = (await r.json()) as { data?: Array<{ id?: string }> };
        const models = [...new Set((j.data || []).map((m) => m.id).filter(Boolean) as string[])].sort();
        return json(res, { models });
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : "获取失败" }, 502);
      }
    }
    const activeProvMatch = path.match(/^\/api\/agent\/providers\/([^/]+)\/active$/);
    if (method === "POST" && activeProvMatch?.[1]) {
      const ok = await setActiveProvider(decodeURIComponent(activeProvMatch[1]));
      return json(res, { ok });
    }

    // ---- agent 对话 ----
    if (method === "POST" && path === "/api/agent/chat") {
      const body = z.object({
        message: z.string().min(1).max(2000),
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).default([]),
      }).parse(await readJsonBody(req));
      const provider = await getActiveProvider();
      if (!provider) return json(res, { error: "未配置模型供应商，请先在设置中添加" }, 400);
      const exec: ToolExecutor = async (tool, args) => {
        switch (tool) {
          case "health": {
            const toolList = stats.list();
            const called = toolList.filter((t) => t.calls > 0);
            return { tools: stats.catalogList().length, called: called.length,
              unhealthy: called.filter((t) => t.errors > 0).map((t) => t.name),
              summary: stats.summary(), disabled: [...disabledTools], logLevel: getLogThreshold() };
          }
          case "tool_stats":
            return stats.list().map((t) => ({ name: t.name, calls: t.calls, errors: t.errors,
              errRate: Math.round(t.errRate * 1000) / 1000, avgMs: Math.round(t.avgMs),
              disabled: disabledTools.has(t.name) }));
          case "errors":
            return logStore.errorList({ limit: Math.min(Number(args.limit) || 20, 50) })
              .map((e) => ({ ts: e.ts, source: e.source, text: e.text.slice(0, 300) }));
          case "isolate": case "restore": {
            const name = String(args.name ?? "");
            if (!TOOL_DISPATCH.has(name)) throw new Error(`unknown tool: ${name}`);
            if (tool === "isolate") disabledTools.add(name); else disabledTools.delete(name);
            logStore.add({ level: "info", source: "agent", text: `工具 ${name} 已${tool === "isolate" ? "隔离" : "恢复"}` });
            return { ok: true, disabled: disabledTools.has(name) };
          }
          case "extensions":
            return extensions.list().map((e) => ({ name: e.manifest.name, kind: e.kind, enabled: e.enabled }));
          case "ext_toggle": {
            const ok = await extensions.disable(String(args.name ?? ""));
            return { ok };
          }
          case "bridge": {
            const on = !!args.on;
            await mgr.setBridgeEnabled(on);
            return { ok: true, enabled: on };
          }
          case "channels":
            return mgr.listChannels().map((c) => ({ id: c.bindingId, name: c.name, paired: c.paired, liveness: c.liveness }));
          case "loglevel": {
            const lv = String(args.level ?? "");
            if (!["debug", "info", "warn", "error"].includes(lv)) throw new Error("invalid level");
            setLogThreshold(lv as "debug" | "info" | "warn" | "error");
            return { ok: true, level: getLogThreshold() };
          }
          default: throw new Error(`unknown tool: ${tool}`);
        }
      };
      try {
        const { agentChat } = await import("./agent.js");
        const r = await agentChat(provider, body.history, body.message, exec);
        return json(res, { ok: true, ...r });
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
      }
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
      if (disabledTools.has(body.name)) return json(res, { error: `工具已被隔离: ${body.name}` }, 403);
      const def = TOOL_DISPATCH.get(body.name);
      if (!def) return json(res, { error: `unknown tool: ${body.name}` }, 404);
      if (approvalMode === "approval" && def.danger) {
        const ap = createApproval(body.name, body.args, "playground", async () => {
          if (disabledTools.has(body.name)) throw new Error(`工具已被隔离: ${body.name}`);
          const t0 = Date.now();
          try {
            const args = def.schema.parse(body.args);
            const result = await def.fn(args as never);
            stats.record(body.name, Date.now() - t0, true);
            return { result, ms: Date.now() - t0 };
          } catch (e) {
            stats.record(body.name, Date.now() - t0, false, e);
            throw e;
          }
        });
        return json(res, { approvalRequired: true, approvalId: ap.id });
      }
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

    // ---- SSH（部署走 SSH，不走本机 PowerShell；密码不落盘不进日志） ----
    const SshCfgSchema = z.object({
      host: z.string().min(1),
      sshPort: z.number().int().min(1).max(65535).default(22),
      username: z.string().min(1).default("root"),
      password: z.string().min(1),
    });
    if (method === "POST" && path === "/api/ssh/run") {
      const body = SshCfgSchema.extend({ command: z.string().min(1).max(8000) }).parse(await readJsonBody(req));
      const cfg: SshConfig = { host: body.host, port: body.sshPort, username: body.username, password: body.password };
      const start = () => {
        const jobId = sshRunJob(cfg, body.command);
        logStore.add({ level: "info", source: "dashboard", text: `SSH 任务已启动 ${body.username}@${body.host}` });
        return { result: { jobId } };
      };
      if (approvalMode === "approval") {
        // 审批记录/弹窗里不放密码
        const ap = createApproval(
          "ssh 部署",
          { host: `${body.username}@${body.host}:${body.sshPort}`, command: body.command },
          "gateway-deploy",
          async () => start(),
        );
        return json(res, { approvalRequired: true, approvalId: ap.id });
      }
      const r = start();
      return json(res, { jobId: (r.result as { jobId: string }).jobId });
    }
    const sshJobMatch = path.match(/^\/api\/ssh\/jobs\/([^/]+)$/);
    if (method === "GET" && sshJobMatch?.[1]) {
      const job = sshGetJob(sshJobMatch[1]);
      if (!job) return json(res, { error: "job not found" }, 404);
      return json(res, job);
    }
    if (method === "POST" && path === "/api/ssh/terminal") {
      const body = SshCfgSchema.parse(await readJsonBody(req));
      const token = randomUUID();
      terminalSessions.set(token, { host: body.host, port: body.sshPort, username: body.username, password: body.password });
      setTimeout(() => terminalSessions.delete(token), 60_000).unref();
      return json(res, { token });
    }

    return json(res, { error: "not found" }, 404);
  }

  // SSH 终端 WebSocket（一次性 token，避免密码进 URL 日志）
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    let token = "";
    try {
      const u = new URL(req.url ?? "", "http://localhost");
      pathname = u.pathname;
      token = u.searchParams.get("token") ?? "";
    } catch { /* ignore */ }
    if (pathname !== "/api/ssh/terminal/ws") { socket.destroy(); return; }
    const cfg = terminalSessions.get(token);
    if (!cfg) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    terminalSessions.delete(token);
    wss.handleUpgrade(req, socket, head, (ws) => bridgeSshTerminal(ws, cfg));
  });

  const port = opts.port ?? parseInt(process.env["DASHBOARD_PORT"] ?? "18789", 10);
  const host = opts.host ?? process.env["DASHBOARD_HOST"] ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });

  logStore.add({ level: "info", source: "dashboard", text: `dashboard API 已启动 http://${host}:${port}` });
  return { port, url: `http://${host}:${port}` };
}
