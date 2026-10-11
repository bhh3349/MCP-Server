#!/usr/bin/env node
/**
 * 网关健康巡检：对真实网关跑一遍端到端检查，输出可读报告 + 退出码。
 *
 * 和 test/gateway/*.test.ts 的区别：那些测的是本地临时起的网关实例（确定性）；
 * 这个脚本打的是**线上真网关**，用来回答"现在这台服务器到底通不通、稳不稳"。
 *
 * 用法：
 *   npx tsx scripts/gateway-doctor.ts --url http://140.143.201.204:8080 --token <TOKEN>
 *   npx tsx scripts/gateway-doctor.ts --url http://... --token <TOKEN> --watch
 *
 * --watch   每 10s 一轮，只在指标恶化时报警（退出码 0），适合挂 CI/监控。
 *
 * 退出码：0=全绿  1=有检查失败  2=参数/网络错误
 */
import { WebSocket } from "ws";

interface Opts {
  url: string;
  token: string;
  watch: boolean;
  rounds: number;
}
function parseArgs(argv: string[]): Opts {
  const o: Opts = { url: "", token: "", watch: false, rounds: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--url") o.url = next();
    else if (a === "--token") o.token = next();
    else if (a === "--watch") o.watch = true;
    else if (a === "--rounds") o.rounds = Number(next()) || 1;
    else if (a === "-h" || a === "--help") {
      console.log("用法: gateway-doctor --url <网关地址> --token <TOKEN> [--watch] [--rounds N]");
      process.exit(0);
    }
  }
  if (!o.url || !o.token) {
    console.error("缺少 --url 或 --token");
    process.exit(2);
  }
  o.url = o.url.replace(/^ws/, "http").replace(/\/+$/, "");
  return o;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

interface Metrics {
  mcpConnections: number;
  aiConnections: number;
  channelsCreated: number;
  channelsActive: number;
  channelsClosed: number;
  pairingAttempts: number;
  pairingFailures: number;
  authFailures: number;
  msgsRouted: number;
  bytesRouted: number;
  slowConsumerDrops: number;
  uptimeSec: number;
  channelQuality?: Record<string, unknown>;
}

/** 一轮巡检。wsMs=WS 建连往返延迟 */
async function round(o: Opts): Promise<{ m: Metrics; wsMs: number }> {
  // 1. /healthz —— 进程活着吗
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let healthy = false;
  try {
    const r = await fetch(`${o.url}/healthz`, { signal: ac.signal });
    healthy = r.ok;
    check("/healthz 可达", r.ok, r.ok ? "200 OK" : `HTTP ${r.status}`);
  } catch (e) {
    check("/healthz 可达", false, `连接失败: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }

  // 2. /metrics —— 核心指标
  let m: Metrics | null = null;
  try {
    m = await getJson<Metrics>(`${o.url}/metrics`);
    check("/metrics 可读", true, `uptime=${m.uptimeSec}s routing=${m.msgsRouted}`);
  } catch (e) {
    check("/metrics 可读", false, (e as Error).message);
  }

  // 3. WS 建连 + 认证往返延迟（真实 RTT，不是业务延迟）
  //    注意：网关的 WS 认证走"首帧 auth"（server.ts:672），不是 HTTP Authorization 头。
  //    所以必须主动发 {type:"auth",token}，等服务端回 auth.ok 才算通过。
  const wsUrl = `${o.url.replace(/^http/, "ws")}/v1/mcp`;
  const t0 = Date.now();
  let wsMs = -1;
  try {
    const result = await new Promise<{ ms: number; authed: boolean }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const to = setTimeout(() => { ws.terminate(); reject(new Error("WS 认证超时 8s")); }, 8000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: o.token }));
      });
      ws.on("message", (buf) => {
        let m: any;
        try { m = JSON.parse(buf.toString()); } catch { return; }
        if (m?.type === "auth.ok") {
          clearTimeout(to);
          const ms = Date.now() - t0;
          ws.close();
          resolve({ ms, authed: true });
        } else if (m?.type === "auth.error") {
          clearTimeout(to);
          ws.close();
          resolve({ ms: -1, authed: false });
        }
      });
      ws.on("error", (e) => { clearTimeout(to); reject(e as Error); });
    });
    wsMs = result.ms;
    check("WS 建连 + 认证", result.authed, result.authed ? `auth.ok RTT=${wsMs}ms` : "认证失败");
  } catch (e) {
    check("WS 建连 + 认证", false, (e as Error).message);
  }

  // 4. 坏 token 必须被拒（安全边界）——同样按首帧 auth 协议判断
  try {
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(wsUrl);
      const to = setTimeout(() => { ws.terminate(); resolve(true); }, 8000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: "0".repeat(64) }));
      });
      ws.on("message", (buf) => {
        let m: any;
        try { m = JSON.parse(buf.toString()); } catch { return; }
        clearTimeout(to);
        // 收到 auth.error 才是"正确拒绝"
        resolve(m?.type === "auth.error");
        ws.close();
      });
      ws.on("error", () => { clearTimeout(to); resolve(true); });
      ws.on("close", () => { clearTimeout(to); resolve(true); });
    });
    check("坏 token 被拒", rejected, rejected ? "正确拒绝" : "!!! 未拒绝，认证形同虚设");
  } catch (e) {
    check("坏 token 被拒", false, (e as Error).message);
  }

  if (!m) throw new Error("metrics 不可读，终止本轮");

  // 5. 认证失败率——非 0 说明有客户端拿错 token 在撞
  check("无认证失败", m.authFailures === 0, `authFailures=${m.authFailures}`);

  // 6. 配对失败率
  const pr = m.pairingAttempts > 0 ? m.pairingFailures / m.pairingAttempts : 0;
  check("配对失败率 < 20%", pr < 0.2, `${m.pairingFailures}/${m.pairingAttempts} (${(pr * 100).toFixed(0)}%)`);

  // 7. 慢消费者丢弃——AI 读太慢被网关踢，正常应长期为 0
  check("无慢消费者丢弃", m.slowConsumerDrops === 0, `drops=${m.slowConsumerDrops}`);

  return { m, wsMs };
}

const o = parseArgs(process.argv.slice(2));

if (!o.watch) {
  console.log(`\n网关巡检: ${o.url}\n${"=".repeat(52)}`);
  try {
    const { m, wsMs } = await round(o);
    for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(22)} ${c.detail}`);
    const bad = checks.filter((c) => !c.ok).length;
    console.log(`${"=".repeat(52)}`);
    console.log(`WS RTT ${wsMs}ms | AI 在线 ${m.aiConnections} | 活跃信道 ${m.channelsActive}/${m.channelsCreated}`);
    console.log(bad === 0 ? "结论: 全部通过" : `结论: ${bad} 项失败`);
    process.exit(bad === 0 ? 0 : 1);
  } catch (e) {
    console.error(`巡检失败: ${(e as Error).message}`);
    process.exit(2);
  }
} else {
  // watch 模式：持续采样，只报变化
  console.log(`持续巡检 ${o.url}（Ctrl+C 停止）\n`);
  let prev: Metrics | null = null;
  let prevWs = -1;
  let regressions: string[] = [];

  for (;;) {
    checks.length = 0;
    let line = "";
    try {
      const { m, wsMs } = await round(o);
      const dConn = prev ? m.mcpConnections - prev.mcpConnections : 0;
      const dMsg = prev ? m.msgsRouted - prev.msgsRouted : 0;
      const t = new Date().toISOString().slice(11, 19);
      line = `${t}  RTT=${String(wsMs).padStart(4)}ms  AI=${m.aiConnections}  信道=${m.channelsActive}/${m.channelsCreated}  路由+${dMsg}  新连接+${dConn}`;

      const bad = checks.filter((c) => !c.ok);
      if (bad.length) {
        line += `  ⚠ ${bad.map((c) => c.name).join(",")}`;
        regressions = bad.map((c) => c.name);
      } else if (regressions.length) {
        line += `  ✓ 已恢复: ${regressions.join(",")}`;
        regressions = [];
      }

      // WS 延迟劣化提示（超过 500ms 认为异常）
      if (wsMs > 500 && prevWs > 0 && prevWs <= 500) line += "  ⚠ RTT 突增";
      prev = m;
      prevWs = wsMs;
    } catch (e) {
      line = `${new Date().toISOString().slice(11, 19)}  ⚠ 巡检异常: ${(e as Error).message}`;
    }
    console.log(line);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}