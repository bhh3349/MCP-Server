#!/usr/bin/env node
/**
 * Soak test（长跑稳定性测试）：让网关在持续负载下跑 N 分钟，观察趋势而非瞬时值。
 *
 * 单元/集成测试证明"逻辑对"，但证不了"跑久了不崩"。
 * 昨天线上真实发生过 mcpConn 从 58 暴涨到 86、liveness 反复翻转——那是跑出来的。
 * 这个脚本就是把那类问题变成可复现、可断言的测试。
 *
 * 每轮做四件事（循环 N 轮）：
 *   1. 建信道 → AI 配对 → 跑一轮 MCP 请求（产生质量样本）
 *   2. 采样：延迟分位、网关 metrics、内部 Map 大小、RSS 内存
 *   3. 周期性拆信道（模拟真实 churn），验证 Map 不单调增长
 *   4. 周期性重连 MCP（模拟断线），验证重连不崩、不泄漏
 *
 * 用法：
 *   npx tsx scripts/soak.ts --minutes 30
 *   npx tsx scripts/soak.ts --minutes 5 --channels 20 --report report.md
 *
 * 输出：控制台滚动进度 + 结束时打印汇总（可选写 Markdown 报告）
 */
import { promises as fs } from "node:fs";
import { GatewayServer, generateGatewayToken } from "../src/gateway/server.js";
import { WebSocket } from "ws";

// ---------------------------------------------------------------- 参数

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
function argStr(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const MINUTES = arg("minutes", 30);
const CHANNELS = arg("channels", 10); // 同时存在的信道数
const ROUNDS = arg("rounds", 0) || Math.max(1, Math.ceil((MINUTES * 60) / 15)); // 每轮间隔约 15s
const REPORTS = argStr("report");

const TOKEN = generateGatewayToken();

// ---------------------------------------------------------------- 工具

function wsJson(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function nextMsg(ws: WebSocket, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.once("message", (buf) => {
      clearTimeout(t);
      resolve(JSON.parse(buf.toString()));
    });
  });
}

/**
 * 等到指定 type 的帧（跳过 ping/quality 等其他帧）。
 * 共享 WS 上会有心跳和 quality 推送混在业务帧里，
 * 用 once() 会随机抢到心跳，导致解析出错误的字段。
 */
function waitFor(ws: WebSocket, type: string, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`等待 ${type} 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    function onMsg(buf: Buffer) {
      let m: any;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m?.type === type) {
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(m);
      }
    }
    ws.on("message", onMsg);
  });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function fmtMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// ---------------------------------------------------------------- 数据结构

interface Sample {
  t: number; // 相对起始的秒数
  rttP50: number;
  rttP95: number;
  rttMax: number;
  msgsRouted: number;
  channelsCreated: number;
  channelsActive: number;
  mcpConns: number;
  authFailures: number;
  slowDrops: number;
  rss: number;
  heapUsed: number;
  // 内部 Map 大小（通过 any 访问 private，诊断用）
  qualityMaps: Record<string, number>;
  gwChannels: number;
  gwMcpConns: number;
  gwAiConns: number;
  mcpPending: number;
  errors: number;
}

interface Channel {
  ai: WebSocket;
  id: string;
  code: string;
}

/**
 * 单条共享 MCP WS（这是关键）。
 * 同一 token 只允许一条 WS 连接，多开会被网关互踢
 * （server.ts:698 "replaced by new connection"）——
 * 也就是 2026-10-10 线上 mcpConn 暴涨的真实原因。
 * 真实客户端就是一个进程一条 WS 管全部信道，这里必须照抄。
 */
let sharedMcp: WebSocket | null = null;

// ---------------------------------------------------------------- 主流程

const gw = new GatewayServer({
  port: 0,
  tokens: [TOKEN],
  // 加速心跳/清理节奏，让长跑里能观察到边界行为（生产是 30s/10min）
  heartbeatTimeoutMs: 30_000,
  sweepIntervalMs: 5_000,
});
const info = await gw.start();
const PORT = info.port;
const BASE = `ws://127.0.0.1:${PORT}`;

console.log(`\nSoak test 开始`);
console.log(`  时长     ${MINUTES} 分钟（${ROUNDS} 轮，每轮 ~15s）`);
console.log(`  信道数   ${CHANNELS}`);
console.log(`  网关     ${BASE}`);
console.log(`  启动 RSS ${fmtMb(process.memoryUsage().rss)}\n`);

const samples: Sample[] = [];
let totalErrors = 0;
let created = 0;
let churnDone = 0;
let reconnectDone = 0;
const t0 = Date.now();

/** 建一条完整配对的信道（复用共享 MCP WS） */
async function makeChannel(idx: number): Promise<Channel> {
  if (!sharedMcp) throw new Error("共享 MCP WS 未建立");
  const mcp = sharedMcp;

  mcp.send(JSON.stringify({ type: "channel.create", reqId: `c${idx}-${Date.now()}`, name: `soak-${idx}` }));
  const created0 = await waitFor(mcp, "channel.created");
  if (!created0.channelId) throw new Error(`create failed: ${JSON.stringify(created0)}`);

  const ai = await wsJson(`${BASE}/v1/ai`);
  ai.send(JSON.stringify({ type: "join", pairingCode: created0.pairingCode }));
  const joined = await waitFor(ai, "joined").catch(async () => {
    // 失败时把实际收到的帧带出来，便于定位
    throw new Error(`join 失败，pairingCode=${created0.pairingCode}`);
  });
  if (joined.type !== "joined") throw new Error(`join failed: ${JSON.stringify(joined)}`);

  // AI 侧自动 echo 任何 msg（模拟 MCP 回包）
  ai.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    if (m?.type === "msg" && m.data) {
      try {
        const rpc = JSON.parse(m.data);
        ai.send(JSON.stringify({
          type: "msg", ch: m.ch,
          data: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { ok: true } }),
        }));
      } catch { /* ignore */ }
    }
  });

  created++;
  return { ai, id: joined.channelId, code: created0.pairingCode };
}

/** 发一批请求，测往返延迟（经共享 MCP WS） */
async function drive(ch: Channel, n: number): Promise<number[]> {
  if (!sharedMcp) return [];
  const mcp = sharedMcp;
  const rtt: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = `r${Date.now()}-${i}-${ch.id.slice(-4)}`;
    const s = Date.now();
    try {
      const p = new Promise<void>((resolve) => {
        const onMsg = (buf: Buffer) => {
          let m: any;
          try { m = JSON.parse(buf.toString()); } catch { return; }
          if (m?.type === "msg" && typeof m.data === "string") {
            try {
              const rpc = JSON.parse(m.data);
              if (rpc.id === id) {
                mcp.off("message", onMsg);
                resolve();
              }
            } catch { /* 非 JSON-RPC，跳过 */ }
          }
        };
        mcp.on("message", onMsg);
        setTimeout(() => { mcp.off("message", onMsg); resolve(); }, 5000);
      });
      mcp.send(JSON.stringify({
        type: "msg", ch: ch.id,
        data: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
      }));
      await p;
      rtt.push(Date.now() - s);
    } catch {
      totalErrors++;
    }
  }
  return rtt;
}

function takeSample(rttAll: number[]): Sample {
  const mu = process.memoryUsage();
  const sorted = [...rttAll].sort((a, b) => a - b);
  const gwAny = gw as any;
  return {
    t: Math.round((Date.now() - t0) / 1000),
    rttP50: pct(sorted, 50),
    rttP95: pct(sorted, 95),
    rttMax: sorted.length ? sorted[sorted.length - 1]! : -1,
    msgsRouted: gw.metrics.msgsRouted,
    channelsCreated: gw.metrics.channelsCreated,
    channelsActive: gw.metrics.channelsActive,
    mcpConns: gw.metrics.mcpConnections,
    authFailures: gw.metrics.authFailures,
    slowDrops: gw.metrics.slowConsumerDrops,
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    qualityMaps: gwAny.quality?.internalSizes?.() ?? {},
    gwChannels: gwAny.channels?.size ?? -1,
    gwMcpConns: gwAny.mcpConns?.size ?? -1,
    gwAiConns: gwAny.aiConns?.size ?? -1,
    mcpPending: gwAny.mcpPending?.size ?? -1,
    errors: totalErrors,
  };
}

function fmtSample(s: Sample): string {
  const q = s.qualityMaps;
  const qsum = Object.values(q).reduce((a, b) => a + b, 0);
  return (
    `t=${String(s.t).padStart(4)}s ` +
    `RTT p50=${String(s.rttP50).padStart(3)} p95=${String(s.rttP95).padStart(3)} max=${String(s.rttMax).padStart(4)} | ` +
    `路由=${s.msgsRouted} 信道=${s.channelsActive}/${s.channelsCreated} | ` +
    `RSS=${fmtMb(s.rss)} heap=${fmtMb(s.heapUsed)} | ` +
    `maps(e/g/l/p/pend)=${Object.values(q).join("/")} sum=${qsum} | ` +
    `gw(ch/mcp/ai/pend)=${s.gwChannels}/${s.gwMcpConns}/${s.gwAiConns}/${s.mcpPending} | ` +
    `err=${s.errors}`
  );
}

// ---- 主循环
let live: Channel[] = [];
async function connectSharedMcp(): Promise<void> {
  const ws = await wsJson(`${BASE}/v1/mcp`);
  ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  const ok = await waitFor(ws, "auth.ok");
  if (ok.type !== "auth.ok") throw new Error(`auth failed: ${JSON.stringify(ok)}`);
  sharedMcp = ws;
}
try {
  await connectSharedMcp();
  // 建满初始信道
  for (let i = 0; i < CHANNELS; i++) {
    live.push(await makeChannel(i));
  }
  console.log(`初始 ${live.length} 条信道就绪（共享 1 条 MCP WS），开始负载...\n`);

  for (let round = 0; round < ROUNDS; round++) {
    // 1. 驱动一轮负载
    const rttAll: number[] = [];
    for (const ch of live) {
      try {
        rttAll.push(...(await drive(ch, 5)));
      } catch {
        totalErrors++;
      }
    }

    // 2. 采样
    const s = takeSample(rttAll);
    samples.push(s);
    process.stdout.write(`  ${fmtSample(s)}\n`);

    // 3. 周期性 churn：拆掉一条信道（只关 AI 侧，共享 MCP WS 不动）
    if (round % 3 === 2 && live.length > 0) {
      const victim = live.pop()!;
      victim.ai.close();
      churnDone++;
      await sleep(600); // 等 closeChannel 跑完
    }

    // 4. 周期性补信道
    while (live.length < CHANNELS) {
      try {
        live.push(await makeChannel(created));
      } catch (e) {
        totalErrors++;
        console.log(`    建信道失败: ${(e as Error).message}`);
        await sleep(1000);
      }
    }

    // 5. 周期性模拟 MCP 整体断线重连（真断开共享 WS 再重连）
    if (round % 5 === 4) {
      try {
        const oldMcp = sharedMcp;
        const ids = live.map((c) => c.id);
        oldMcp?.close();
        await sleep(400);
        await connectSharedMcp();
        // 重连后重新认领所有信道（网关也可自动接管，这里显式 attach 更接近真实客户端）
        for (const id of ids) {
          sharedMcp!.send(JSON.stringify({ type: "channel.attach", reqId: `a-${id}`, channels: [id] }));
          await waitFor(sharedMcp!, "channel.attached").catch(() => {});
        }
        reconnectDone++;
      } catch (e) {
        totalErrors++;
        console.log(`    重连失败: ${(e as Error).message}`);
        try { await connectSharedMcp(); } catch { /* ignore */ }
      }
    }

    if (round < ROUNDS - 1) await sleep(Math.max(0, 15_000 - 3000));
  }
} catch (e) {
  totalErrors++;
  console.error(`\n!!! 主循环异常: ${(e as Error).message}`);
}

// ---- 收尾
for (const ch of live) { try { ch.ai.close(); } catch { /* ignore */ } }
try { sharedMcp?.close(); } catch { /* ignore */ }
await sleep(800);
await gw.stop();

// ---------------------------------------------------------------- 分析

function trend(key: keyof Sample): "flat" | "growing" | "shrinking" {
  const vals = samples.map((s) => Number(s[key])).filter((v) => v >= 0);
  if (vals.length < 4) return "flat";
  const half = Math.floor(vals.length / 2);
  const a = vals.slice(0, half).reduce((x, y) => x + y, 0) / half;
  const b = vals.slice(half).reduce((x, y) => x + y, 0) / (vals.length - half);
  if (a === 0 && b === 0) return "flat";
  const ratio = b / Math.max(a, 1e-9);
  if (ratio > 1.5) return "growing";
  if (ratio < 0.67) return "shrinking";
  return "flat";
}

function verdict(ok: boolean): string { return ok ? "✓ PASS" : "✗ FAIL"; }

const first = samples[0];
const last = samples[samples.length - 1];
const rttAllSorted = samples.map((s) => s.rttP95).filter((v) => v >= 0).sort((a, b) => a - b);
const p95Worst = rttAllSorted.length ? rttAllSorted[rttAllSorted.length - 1]! : -1;
const p95Median = pct(rttAllSorted, 50);
const rssGrowth = first && last && first.rss > 0 ? (last.rss - first.rss) / first.rss : 0;
const finalQsum = last ? Object.values(last.qualityMaps).reduce((a, b) => a + b, 0) : 0;

// 判定标准（基于实际观察到的线上故障）
// 每条存活信道在 quality tracker 里约占 5 个 Map 条目（e2e/gaps/lastAiMsgAt/pings/pending）。
// 泄漏的真实特征是"信道路过数远大于存活数，且比值持续上升"。
const finalGwCh = last?.gwChannels ?? -1;
const perChannel = finalGwCh > 0 ? finalQsum / finalGwCh : -1;
const leaked =
  // 信道已清理但 Map 仍在：Map 条目比存活信道多出一大截
  finalGwCh > 0 && finalQsum > finalGwCh * 8;
// ch/mcpPending 是强泄漏信号：它们按"曾建立过的信道"累积，从不收缩
const gwGrowth = trend("gwChannels");
const pendingGrowth = trend("mcpPending");

const checks: { name: string; ok: boolean; detail: string }[] = [
  {
    name: "无未捕获异常 / 请求错误",
    ok: totalErrors === 0,
    detail: `${totalErrors} 次错误`,
  },
  {
    name: "MCP 连接数不暴涨（多实例互踢检测）",
    // mcpConnections 是**累计**计数（每次 WS 认证成功就 +1，server.ts:705），
    // 不是"当前连接数"。真正的当前值是 gwMcpConns（内部 Set 大小）。
    // 判据：累计增量应 ≈ 本脚本主动重连次数；且当前连接数必须恒为 1
    //       （一条 WS 管全部信道，出现 2+ 就是同 token 互踢）。
    ok: (last?.gwMcpConns ?? -1) <= 1
      && (last?.mcpConns ?? 0) - (first?.mcpConns ?? 0) <= reconnectDone + 2,
    detail: `当前 MCP 连接数=${last?.gwMcpConns}（应恒为1）; 累计认证 ${first?.mcpConns}→${last?.mcpConns}，本脚本主动重连 ${reconnectDone} 次`,
  },
  {
    name: "内部 Map 不单调增长（内存泄漏）",
    ok: !leaked && gwGrowth !== "growing",
    detail: `channels=${finalGwCh}, maps合计=${finalQsum}, 每信道≈${perChannel.toFixed(1)} 个条目（正常 5，>8 视为泄漏）`,
  },
  {
    name: "mcpPending 无悬挂",
    ok: (last?.mcpPending ?? -1) <= 5 && pendingGrowth !== "growing",
    detail: `pending=${last?.mcpPending}（应随请求结算回落到 0）`,
  },
  {
    name: "RSS 不持续增长",
    ok: rssGrowth < 0.5, // 允许 50% 增长（GC 抖动），超过说明泄漏
    detail: `RSS ${fmtMb(first?.rss ?? 0)} → ${fmtMb(last?.rss ?? 0)}（${(rssGrowth * 100).toFixed(1)}%）`,
  },
  {
    name: "延迟未劣化",
    ok: p95Worst < 500 && (p95Median === -1 || p95Worst < p95Median * 4 + 100),
    detail: `p95 中位=${p95Median}ms 最差=${p95Worst}ms`,
  },
  {
    name: "无慢消费者丢弃",
    ok: (last?.slowDrops ?? 0) === 0,
    detail: `slowDrops=${last?.slowDrops}`,
  },
  {
    name: "无认证失败",
    ok: (last?.authFailures ?? 0) === 0,
    detail: `authFailures=${last?.authFailures}`,
  },
];

const passed = checks.filter((c) => c.ok).length;
const total = checks.length;

console.log(`\n${"=".repeat(72)}`);
console.log(`Soak test 结果：${passed}/${total} 项通过`);
console.log(`  实际时长 ${Math.round((Date.now() - t0) / 1000)}s | 轮次 ${samples.length} | 建信道 ${created} | churn ${churnDone} | 重连 ${reconnectDone} | 错误 ${totalErrors}`);
console.log(`${"-".repeat(72)}`);
for (const c of checks) {
  console.log(`  ${verdict(c.ok)}  ${c.name.padEnd(34)} ${c.detail}`);
}
console.log(`${"=".repeat(72)}\n`);

// ---------------------------------------------------------------- 报告

if (REPORTS) {
  const lines: string[] = [];
  lines.push(`# Soak Test 报告`);
  lines.push(``);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 时长：${MINUTES} 分钟（实际 ${Math.round((Date.now() - t0) / 1000)}s）`);
  lines.push(`- 轮次：${samples.length}，信道数：${CHANNELS}`);
  lines.push(`- 建信道 ${created} 次，churn ${churnDone} 次，重连 ${reconnectDone} 次，错误 ${totalErrors} 次`);
  lines.push(``);
  lines.push(`## 结论：${passed}/${total} 项通过`);
  lines.push(``);
  lines.push(`| 检查项 | 结果 | 详情 |`);
  lines.push(`|---|---|---|`);
  for (const c of checks) {
    lines.push(`| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"} | ${c.detail} |`);
  }
  lines.push(``);
  lines.push(`## 采样明细`);
  lines.push(``);
  lines.push(`| t(s) | RTT p50 | p95 | max | 路由 | 信道 | RSS | heap | quality maps | gw ch/mcp/ai/pend | err |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of samples) {
    lines.push(
      `| ${s.t} | ${s.rttP50} | ${s.rttP95} | ${s.rttMax} | ${s.msgsRouted} | ${s.channelsActive}/${s.channelsCreated} | ` +
      `${fmtMb(s.rss)} | ${fmtMb(s.heapUsed)} | ${Object.values(s.qualityMaps).join("/")} | ` +
      `${s.gwChannels}/${s.gwMcpConns}/${s.gwAiConns}/${s.mcpPending} | ${s.errors} |`
    );
  }
  await fs.writeFile(REPORTS, lines.join("\n"), "utf-8");
  console.log(`报告已写入: ${REPORTS}`);
}

process.exit(passed === total ? 0 : 1);