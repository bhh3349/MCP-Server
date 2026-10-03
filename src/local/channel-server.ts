/**
 * 本地信道：不经过网关，AI 直连 MCP。
 *
 * MCP 在本机 IP 上起 HTTP 服务（Streamable HTTP）：
 *   POST /mcp   MCP 协议（initialize / tools/list / tools/call …）
 *   GET  /mcp   SSE 流（长连接）
 *   DELETE /mcp 关闭会话
 *
 * 鉴权：新建会话（无 Mcp-Session-Id）的请求必须带
 *   X-Pairing-Code: <12位配对码>
 * 配对码由 MCP 本地生成，用户复制 URL + 配对码给 AI。
 * 会话建立后走标准的 Mcp-Session-Id。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { generatePairingCode } from "../channel/pairing.js";

export interface LocalChannelInfo {
  /** http://<本机IP>:<port>/mcp */
  url: string;
  pairingCode: string;
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
  private readonly pairingCode = generatePairingCode();
  private activeSessions = new Set<string>();
  private aiName: string | null = null;

  /**
   * @param makeServer 建一个独立的 McpServer（每个本地信道独立实例）
   * @param port 0 = 自动分配
   */
  constructor(
    private makeServer: () => Promise<McpServer>,
    private port = 0,
  ) {}

  getPairingCode(): string {
    return this.pairingCode;
  }

  get sessionCount(): number {
    return this.activeSessions.size;
  }

  get connectedAI(): string | null {
    return this.aiName;
  }

  async start(): Promise<LocalChannelInfo> {
    const server = await this.makeServer();
    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.activeSessions.add(id);
      },
      onsessionclosed: (id) => {
        this.activeSessions.delete(id);
        if (this.activeSessions.size === 0) this.aiName = null;
      },
    });
    await server.connect(this.transport);

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
    return { url: `http://${localIp}:${port}/mcp`, pairingCode: this.pairingCode, port, localIp };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: this.activeSessions.size }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }

    // 新建会话必须带配对码；已有会话走 Mcp-Session-Id
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId) {
      const code = req.headers["x-pairing-code"];
      if (code !== this.pairingCode) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid or missing X-Pairing-Code" }));
        return;
      }
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
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    this.http = null;
    this.transport = null;
    this.activeSessions.clear();
    this.aiName = null;
  }
}
