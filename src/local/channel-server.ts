/**
 * 本地信道：不经过网关，AI 直连 MCP。
 *
 * MCP 在本机 IP 上起 HTTP 服务（Streamable HTTP）：
 *   POST /mcp/<token>   MCP 协议（initialize / tools/list / tools/call …）
 *   GET  /mcp/<token>   SSE 流（长连接）
 *   DELETE /mcp/<token> 关闭会话（只关会话，不烧 token）
 *   GET  /healthz       免初始化心跳
 *
 * 语义（测试报告 P0 修复，v1.1 §10.4 优化）：
 * - token 是信道凭证，长期有效；会话是临时的，可建可关。
 * - DELETE 只关闭当前会话，token 不受影响，随时可重新 initialize。
 * - 只有旧 transport 曾经开过会话、现在又无活跃会话时（= 已"用废"，
 *   SDK 不再接受新会话），新 initialize 到来才重建 transport。
 *   transport 全新（从未开过会话）时直接复用：start() 的预建不再被浪费，
 *   无 session 的裸 POST（心跳探活用）也不再触发重建 + 扩展重载。
 *
 * 本地信道不用配对码：URL 里自带 token，
 *   http://<本机IP>:<port>/mcp/<token>
 * 用户复制这一个 URL 给 AI 就能连。token 不可猜，
 * 局域网邻居扫到端口也连不上（路径不对直接 404）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

export interface LocalChannelInfo {
  /** http://<本机IP>:<port>/mcp/<token> —— 复制这一个 URL 就能连 */
  url: string;
  port: number;
  localIp: string;
}

/** 取本机局域网 IPv4，取不到回落 127.0.0.1 */
export function getLocalIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export class LocalChannelServer {
  private http: Server | null = null;
  private transport: WebStandardStreamableHTTPServerTransport | null = null;
  /** transport 重建中的并发 guard */
  private building: Promise<void> | null = null;
  /** URL token：不可猜， unknown 路径直接 404。可用 MCP_LOCAL_TOKEN 固定（32 位 hex） */
  private readonly urlToken: string;
  /** 活跃会话：sessionId → 最后活跃时间戳。30 分钟无活动自动回收（防客户端崩溃锁死） */
  private activeSessions = new Map<string, number>();
  private sessionGcTimer: ReturnType<typeof setInterval> | null = null;
  private aiName: string | null = null;
  /**
   * 当前 transport 是否曾经开过会话。
   * 曾经开过、现在又无活跃会话 = transport 已"用废"（SDK 不再接受新会话），
   * 下一个无 session 的 POST 到来时才需要重建。全新 transport 直接复用。
   */
  private transportHadSession = false;

  /**
   * @param makeServer 建一个独立的 McpServer（每个本地信道独立实例）
   * @param port 0 = 自动分配
   * @param token 可选：固定 token（32 位 hex，如 MCP_LOCAL_TOKEN）；不传则随机生成
   */
  constructor(
    private makeServer: () => Promise<McpServer>,
    private port = 0,
    token?: string,
  ) {
    if (token !== undefined) {
      if (!/^[0-9a-f]{32}$/i.test(token)) {
        throw new Error("channel token must be 32 hex chars");
      }
      this.urlToken = token.toLowerCase();
    } else {
      this.urlToken = randomBytes(16).toString("hex");
    }
  }

  get sessionCount(): number {
    return this.activeSessions.size;
  }

  get connectedAI(): string | null {
    return this.aiName;
  }

  /** 建（或重建）transport + server */
  private async buildTransport(): Promise<void> {
    if (this.building) {
      await this.building;
      return;
    }
    this.building = (async () => {
      try {
        await this.transport?.close().catch(() => {});
      } catch { /* ignore */ }
      const server = await this.makeServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.activeSessions.set(id, Date.now());
          this.transportHadSession = true;
        },
        onsessionclosed: (id) => {
          this.activeSessions.delete(id);
          if (this.activeSessions.size === 0) this.aiName = null;
        },
      });
      await server.connect(transport);
      this.transport = transport;
      this.transportHadSession = false;
    })();
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  async start(): Promise<LocalChannelInfo> {
    await this.buildTransport();

    // 会话 GC：每 5 分钟检查，30 分钟无活动的会话自动回收
    // （防客户端崩溃未发 DELETE 导致信道永久锁死）
    this.sessionGcTimer = setInterval(() => {
      const now = Date.now();
      const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
      for (const [id, lastAt] of this.activeSessions) {
        if (now - lastAt > IDLE_TIMEOUT_MS) {
          console.warn(`[local-channel] 会话 ${id.slice(0, 8)}… 空闲超 30 分钟，自动回收`);
          this.activeSessions.delete(id);
          // 通知 transport 关闭该会话（如果 SDK 支持）
          try {
            (this.transport as any)?.closeSession?.(id);
          } catch { /* ignore */ }
        }
      }
    }, 5 * 60 * 1000);
    if (this.sessionGcTimer.unref) this.sessionGcTimer.unref();

    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error("[local-channel]", (e as Error).message);
        if (!res.headersSent) {
          res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
        }
      });
    });

    const port = await new Promise<number>((resolve, reject) => {
      this.http!.listen(this.port, "0.0.0.0", () => {
        const addr = this.http!.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("listen failed"));
      });
      this.http!.on("error", reject);
    });

    const localIp = getLocalIp();
    return {
      url: `http://${localIp}:${port}/mcp/${this.urlToken}`,
      port,
      localIp,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: this.activeSessions.size }));
      return;
    }

    // 路径必须带正确的 token，否则 404（不暴露服务存在）
    if (url.pathname !== `/mcp/${this.urlToken}`) {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }

    // 无会话 ID 的 POST：只有旧 transport 已"用废"（开过会话、现无活跃）
    // 或 transport 不存在时才重建。全新 transport 直接复用，不浪费预建。
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && this.activeSessions.has(sessionId)) {
      // 更新会话活跃时间
      this.activeSessions.set(sessionId, Date.now());
    }
    if (!sessionId && req.method === "POST" && (!this.transport || (this.transportHadSession && this.activeSessions.size === 0))) {
      await this.buildTransport();
    }

    // Node req → Web Request
    const body = await readBody(req);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const webReq = new Request(url.toString(), {
      method: req.method ?? "GET",
      headers,
      ...(body.length > 0 && req.method !== "GET" && req.method !== "HEAD"
        ? { body: body as unknown as BodyInit }
        : {}),
    });

    const webRes = await this.transport!.handleRequest(webReq);

    // 尝试从 initialize 拿到客户端名字（AI 身份）
    if (!this.aiName && req.method === "POST" && body.length > 0) {
      try {
        const rpc = JSON.parse(body.toString("utf-8"));
        const clientName = rpc?.params?.clientInfo?.name;
        if (typeof clientName === "string") this.aiName = clientName;
      } catch { /* ignore */ }
    }

    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    res.end(Buffer.from(await webRes.arrayBuffer()));
  }

  async stop(): Promise<void> {
    if (this.sessionGcTimer) {
      clearInterval(this.sessionGcTimer);
      this.sessionGcTimer = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    this.http = null;
    this.transport = null;
    this.transportHadSession = false;
    this.activeSessions.clear();
    this.aiName = null;
  }
}
