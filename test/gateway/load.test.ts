/**
 * 网关性能基准：延迟与吞吐分开测。
 *
 * 延迟：单信道顺序往返（无排队），测网关真实路由开销。
 * 吞吐：100 信道突发，测网关转发上限。
 * 网关只做不透明转发，这里测的是网关本身（不含 McpServer 执行）。
 *
 * 运行：npx tsx --test test/gateway/load.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { GatewayServer, generateGatewayToken } from "../../src/gateway/server.js";

const TOKEN = generateGatewayToken();

let gw: GatewayServer;
let gwPort: number;

function wsJson(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 10000);
    ws.once("message", (buf) => {
      clearTimeout(t);
      resolve(JSON.parse(buf.toString()));
    });
  });
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

/** 建一条配好对的信道，返回 {mcp, ai, channelId}（ai 自动 echo） */
async function makePairedChannel(name: string) {
  const mcp = await wsJson(`ws://127.0.0.1:${gwPort}/v1/mcp`);
  mcp.send(JSON.stringify({ type: "auth", token: TOKEN }));
  assert.equal((await nextMsg(mcp)).type, "auth.ok");
  mcp.send(JSON.stringify({ type: "channel.create", reqId: "r1", name }));
  const created = await nextMsg(mcp);
  assert.equal(created.type, "channel.created");

  const ai = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
  ai.send(JSON.stringify({ type: "join", pairingCode: created.pairingCode }));
  const joined = await nextMsg(ai);
  assert.equal(joined.type, "joined");
  ai.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    if (m?.type === "msg") ai.send(buf); // Buffer 直发，零拷贝 echo
  });
  return { mcp, ai, channelId: created.channelId };
}

before(async () => {
  gw = new GatewayServer({ port: 0, tokens: [TOKEN] });
  gwPort = (await gw.start()).port;
});

after(async () => {
  await gw.stop();
});

describe("网关性能", () => {
  it("延迟：单信道顺序 300 往返（无排队）", async () => {
    const { mcp, ai, channelId } = await makePairedChannel("lat");
    const rtts: number[] = [];
    const N = 300;
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      mcp.send(JSON.stringify({
        type: "msg", ch: channelId,
        data: JSON.stringify({ seq: i, pad: "x".repeat(200) }),
      }));
      // 跳过 peer.join 等通知帧，只收 msg 回显
      let m: any;
      do {
        m = await nextMsg(mcp);
      } while (m.type !== "msg");
      rtts.push(Date.now() - t0);
    }
    rtts.sort((a, b) => a - b);
    const p50 = percentile(rtts, 50);
    const p99 = percentile(rtts, 99);
    const max = rtts[rtts.length - 1]!;
    console.log(`    顺序 ${N} 往返：RTT p50=${p50}ms p99=${p99}ms max=${max}ms`);
    assert.ok(p99 < 50, `p99 ${p99}ms 超过 50ms（loopback 无排队）`);
    mcp.close();
    ai.close();
  }, 60_000);

  it("吞吐：100 信道 × 100 往返突发", async () => {
    const CHANNELS = 100;
    const ROUNDS = 100;
    const mcp = await wsJson(`ws://127.0.0.1:${gwPort}/v1/mcp`);
    mcp.send(JSON.stringify({ type: "auth", token: TOKEN }));
    assert.equal((await nextMsg(mcp)).type, "auth.ok");

    const channels: { id: string; code: string }[] = [];
    for (let i = 0; i < CHANNELS; i++) {
      mcp.send(JSON.stringify({ type: "channel.create", reqId: `c${i}`, name: `t${i}` }));
      const created = await nextMsg(mcp);
      channels.push({ id: created.channelId, code: created.pairingCode });
    }
    const aiSockets: WebSocket[] = [];
    for (const ch of channels) {
      const ai = await wsJson(`ws://127.0.0.1:${gwPort}/v1/ai`);
      ai.send(JSON.stringify({ type: "join", pairingCode: ch.code }));
      assert.equal((await nextMsg(ai)).type, "joined");
      ai.on("message", (buf) => {
        if (JSON.parse(buf.toString())?.type === "msg") ai.send(buf);
      });
      aiSockets.push(ai);
    }

    const total = CHANNELS * ROUNDS;
    let received = 0;
    const done = new Promise<void>((resolve) => {
      mcp.on("message", (buf) => {
        if (JSON.parse(buf.toString())?.type === "msg" && ++received >= total) resolve();
      });
    });

    const t0 = Date.now();
    const payload = "x".repeat(200);
    for (let r = 0; r < ROUNDS; r++) {
      for (const ch of channels) {
        mcp.send(JSON.stringify({
          type: "msg", ch: ch.id,
          data: JSON.stringify({ r, pad: payload }),
        }));
      }
    }
    await done;
    const sec = (Date.now() - t0) / 1000;
    const throughput = (total * 2) / sec; // 每次往返经网关 2 次转发
    console.log(`    突发 ${total} 往返：${sec.toFixed(2)}s，网关转发 ${(throughput / 1000).toFixed(1)}k msg/s`);
    console.log(`    metrics: msgsRouted=${gw.metrics.msgsRouted} slowDrops=${gw.metrics.slowConsumerDrops}`);
    assert.equal(received, total);
    assert.equal(gw.metrics.slowConsumerDrops, 0);
    assert.ok(throughput > 10000, `吞吐 ${throughput}/s 低于 10k`);

    for (const ai of aiSockets) ai.close();
    mcp.close();
  }, 120_000);
});
