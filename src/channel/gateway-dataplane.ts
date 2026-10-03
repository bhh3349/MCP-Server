/**
 * 网关数据平面（MCP 侧）：每条网关信道一个独立 McpServer。
 *
 * 网关只做不透明管道，MCP 协议的实际执行在本机：
 *
 *   网页 AI → 网关 → {type:"msg", ch, data} → 本类
 *     → JSON.parse(data) → InMemoryTransport → McpServer
 *     → 响应 → JSON.stringify → {type:"msg", ch, data} → 网关 → 网页 AI
 *
 * 每个信道独立 McpServer 实例：信道间状态隔离，一个 AI 的操作不影响另一个。
 */
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";

export class GatewayChannelSession {
  private clientT: InMemoryTransport | null = null;
  private serverT: InMemoryTransport | null = null;
  private server: McpServer | null = null;
  private started = false;

  /**
   * @param channelId 网关信道 ID
   * @param sendToGateway 把 {type:"msg", ch, data} 发回网关
   * @param makeServer 建独立 McpServer 的工厂
   */
  constructor(
    private channelId: string,
    private sendToGateway: (channelId: string, data: string) => void,
    private makeServer: () => Promise<McpServer>,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    this.clientT = clientT;
    this.serverT = serverT;

    const server = await this.makeServer();
    this.server = server;

    // McpServer 的响应 → 不透明 data 发回网关
    clientT.onmessage = (msg) => {
      try {
        this.sendToGateway(this.channelId, JSON.stringify(msg));
      } catch { /* 发送失败忽略，网关侧会超时 */ }
    };

    await server.connect(serverT);
    await clientT.start();
    this.started = true;
  }

  /** 网关来的 data（不透明 MCP JSON-RPC 字符串）→ 喂给 McpServer */
  async onData(data: string): Promise<void> {
    if (!this.started || !this.clientT) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // 非法载荷忽略
    }
    await this.clientT.send(msg as any);
  }

  async stop(): Promise<void> {
    this.started = false;
    try { await this.clientT?.close(); } catch { /* noop */ }
    try { await this.serverT?.close(); } catch { /* noop */ }
    try { await (this.server as any)?.close?.(); } catch { /* noop */ }
    this.clientT = null;
    this.serverT = null;
    this.server = null;
  }
}
