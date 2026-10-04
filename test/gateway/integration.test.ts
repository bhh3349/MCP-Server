/**
 * 网关集成测试：真实 WebSocket 上的完整流程。
 *
 *   网关 ←→ MCP（Bridge + GatewayClient + ChannelManager 数据面）←→ AI（裸 WS）
 *
 * 覆盖：建信道两步走、MCP 协议穿透（initialize/tools/list/tools/call）、
 * AI 断线通知、MCP 断线 10 分钟宽限内的无缝重连、错误配对码/坏 token。
 *
 * 运行：npx tsx --test test/gateway/integration.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { GatewayServer, generateGatewayToken } from "../../src/gateway/server.js";
import { ChannelManager } from "../../src/channel/manager.js";
import { Bridge } from "../../src/bridge/pipe.js";
import { buildServer } from "../../src/server.js";

const TOKEN = generateGatewayToken();
let gw: GatewayServer;
let gwPort: number;
let mgr: ChannelManager;

function wsJson(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMsg(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("msg timeout")), timeoutMs);
    ws.once("message", (buf) => {
      clearTimeout(t);
      resolve(JSON.parse(buf.toString()));
    });
  });
}

/** AI 侧的 MCP 会话：通过网关发 JSON-RPC，收响应 */
class AiSession {
  private seq = 0;
  private pending = new Map<number, (v: any) => void>();
  constructor(
    private ws: WebSocket,
    private ch: string,
  ) {
    ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m?.type === "msg" && m.data) {
        try {
          const rpc = JSON.parse(m.data);
          const cb = this.pending.get(rpc.id);
          if (cb) {
            this.pending.delete(rpc.id);
            cb(rpc);
          }
        } catch { /* ignore */ }
      }
    });
  }
  call(method: string, params: any = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, 8000);
      this.pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      this.ws.send(JSON.stringify({
        type: "msg",
        ch: this.ch,
        data: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }));
    });
  }
}

before(async () => {
  gw = new GatewayServer({
    port: 0,
    tokens: [TOKEN],
    heartbeatTimeoutMs: 3000,
    disconnectGraceMs: 8000,
    sweepIntervalMs: 500,
  });
  const info = await gw.start();
  gwPort = info.port;

  const dummyBridge = new Bridge({ gatewayUrl: "local", autoReconnect: false });
  mgr = new ChannelManager(
    dummyBridge,
    async () => (await buildServer({ extensionsDir: "/home/hatch/workspace/MCP-Server/extensions" })).server,
  );
});

after(async () => {
  await gw.stop();
});

describe("建信道两步走", () => {
  it("MCP 建信道 → AI 配对码加入 → 双向打通", async () => {
    const { pairingCode, mcpUrl } = await mgr.establish({
      gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      token: TOKEN,
      name: "test-1",
    });
    assert.match(pairingCode, /^[A-Za-z0-9]{12}$/);
    assert.ok(mcpUrl.includes("/v1/ai"));

    const ai = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    ai.send(JSON.stringify({ type: "join", pairingCode, ai: { name: "test-ai" } }));
    const joined = await nextMsg(ai);
    assert.equal(joined.type, "joined");
    const ch = joined.channelId;
    assert.ok(ch);
    ai.close();
  });

  it("坏 token 被拒", async () => {
    const bad = new Bridge({
      gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      token: "0".repeat(64),
      autoReconnect: false,
    });
    await assert.rejects(() => bad.open(), /auth failed/);
    await bad.close();
  });

  it("错误配对码被拒", async () => {
    const ai = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    ai.send(JSON.stringify({ type: "join", pairingCode: "AAAAAAAAAAAA", ai: { name: "x" } }));
    const err = await nextMsg(ai);
    assert.equal(err.type, "join.error");
  });

  it("配对码一次性：用过的码不能再 join", async () => {
    const { pairingCode } = await mgr.establish({
      gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      token: TOKEN,
      name: "test-once",
    });
    const ai1 = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    ai1.send(JSON.stringify({ type: "join", pairingCode }));
    const j1 = await nextMsg(ai1);
    assert.equal(j1.type, "joined");

    const ai2 = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    ai2.send(JSON.stringify({ type: "join", pairingCode }));
    const j2 = await nextMsg(ai2);
    assert.equal(j2.type, "join.error");
    ai1.close();
  });
});

describe("MCP 协议穿透网关", () => {
  it("initialize → tools/list → tools/call 全链路", async () => {
    const { pairingCode } = await mgr.establish({
      gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      token: TOKEN,
      name: "test-e2e",
    });
    const aiWs = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    aiWs.send(JSON.stringify({ type: "join", pairingCode }));
    const joined = await nextMsg(aiWs);
    assert.equal(joined.type, "joined");

    const ai = new AiSession(aiWs, joined.channelId);
    const init = await ai.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "itest", version: "1" },
    });
    assert.ok(init.result, JSON.stringify(init).slice(0, 200));

    const list = await ai.call("tools/list");
    const names = (list.result?.tools ?? []).map((t: any) => t.name);
    assert.ok(names.includes("exec"), names.join(","));
    assert.ok(names.includes("read_file"));

    const h = await ai.call("tools/call", {
      name: "exec",
      arguments: { command: "echo via-gateway" },
    });
    const text = h.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("via-gateway"), text.slice(0, 200));

    // 网关 metrics 看到路由量
    assert.ok(gw.metrics.msgsRouted > 0);
    aiWs.close();
  });
});

describe("断线与重连", () => {
  it("AI 断线 → MCP 收到 peer.leave；信道保留可 recode 重配", async () => {
    const { pairingCode, bindingId } = await mgr.establish({
      gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      token: TOKEN,
      name: "test-aileave",
    });
    const ai = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    ai.send(JSON.stringify({ type: "join", pairingCode }));
    await nextMsg(ai);
    ai.close();
    await new Promise((r) => setTimeout(r, 800));
    const st = mgr.listChannels().find((c) => c.bindingId === bindingId);
    assert.ok(st);
    assert.equal(st.ai?.online, false);

    // recode 换新配对码
    const client = (mgr as any).gwClients.get(`ws://127.0.0.1:${gwPort}`).client;
    const recoded = await client.recode(bindingId);
    assert.match(recoded.pairingCode, /^[A-Za-z0-9]{12}$/);
    assert.notEqual(recoded.pairingCode, pairingCode);
  });

  it("MCP 断线 → AI 收到 peer.leave(grace)；宽限内重连无缝恢复", async () => {
    const { pairingCode } = await mgr.establish({
      gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      token: TOKEN,
      name: "test-reconnect",
    });
    const ai = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
    ai.send(JSON.stringify({ type: "join", pairingCode }));
    const joined = await nextMsg(ai);
    assert.equal(joined.type, "joined");

    // 杀掉 MCP 的 bridge（模拟断线）
    const client = (mgr as any).gwClients.get(`ws://127.0.0.1:${gwPort}`).client;
    const bridge: Bridge = (client as any).bridge;
    await bridge.close();

    const leave = await nextMsg(ai, 8000);
    assert.equal(leave.type, "peer.leave");
    assert.equal(leave.reason, "mcp_lost");
    assert.ok(leave.graceMs > 0);

    // 宽限内重连：网关自动接管旧信道
    await bridge.open();
    const rejoin = await nextMsg(ai, 8000);
    assert.equal(rejoin.type, "peer.join");

    // 数据面仍可用
    const sess = new AiSession(ai, joined.channelId);
    const pong = await sess.call("tools/call", {
      name: "exec",
      arguments: { command: "echo back" },
    });
    const text = pong.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("back"), text.slice(0, 200));
    ai.close();
  });
});
