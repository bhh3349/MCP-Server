/**
 * 崩溃回归测试：v0.1.3 (f85cb56) 修复的 5 个"可导致进程崩溃"缺陷。
 *
 * 这类缺陷的共同点：不是断言失败，而是 unhandledRejection / 未捕获异常
 * 直接把进程带走，CI 上表现为整轮测试莫名中断、退出码非 0。
 * 所以每个用例都显式挂 process 级监听器，一旦真的抛出来就判定失败。
 *
 * 覆盖：
 *   1. bridge/pipe.ts    重连定时器吞掉 connect() 的 rejection
 *   2. bridge/pipe.ts    心跳 send() 抛错走 onUnexpectedClose()，不崩
 *   3. channel/manager.ts remove() 内 stop() 抛错不影响清理
 *   4. tools/files.ts    read_file 文本模式 50MB 上限（防 OOM）
 *
 * 运行：npx tsx --test test/regression/crash.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { GatewayServer, generateGatewayToken } from "../../src/gateway/server.js";
import { Bridge } from "../../src/bridge/pipe.js";
import { readFile } from "../../src/tools/files.js";

const TOKEN = generateGatewayToken();

/**
 * 在用例期间监听进程级错误事件。
 * unhandledRejection 在 Node 默认策略下会终止进程，
 * 这里我们提前挂监听把它变成可断言的失败，而不是"整个测试进程没了"。
 */
let unhandled: unknown[] = [];
let rejections: unknown[] = [];
const onRejection = (e: unknown) => rejections.push(e);
const onUncaught = (e: unknown) => unhandled.push(e);

before(() => {
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onUncaught);
});
after(() => {
  process.off("unhandledRejection", onRejection);
  process.off("uncaughtException", onUncaught);
});

/** 跑一段可能触发异步 rejection 的代码，然后确认进程没收到任何逃逸的异常 */
async function assertNoEscape(fn: () => Promise<void>, waitMs = 300): Promise<void> {
  rejections = [];
  unhandled = [];
  await fn();
  // 给事件循环几拍时间，让 rejection 有机会冒泡
  await new Promise((r) => setTimeout(r, waitMs));
  assert.deepEqual(rejections, [], `出现未处理的 rejection: ${rejections.map(String).join(" | ")}`);
  assert.deepEqual(unhandled, [], `出现未捕获异常: ${unhandled.map(String).join(" | ")}`);
}

// ---------------------------------------------------------------- 1 + 2

describe("bridge/pipe.ts 重连路径不产生逃逸异常", () => {
  let gw: GatewayServer;
  let port: number;

  before(async () => {
    gw = new GatewayServer({ port: 0, tokens: [TOKEN], heartbeatTimeoutMs: 30_000 });
    port = (await gw.start()).port;
  });
  after(async () => {
    await gw.stop();
  });

  it("网关不可达时反复重连，进程存活（回归 f85cb56 的 .catch(() => {})）", async () => {
    // 指向一个必然连不上的端口，强制 connect() 持续失败
    const bridge = new Bridge({
      gatewayUrl: `ws://127.0.0.1:${1}`,
      token: TOKEN,
      autoReconnect: true,
      reconnectBackoffMs: [10, 20],
    });

    await assertNoEscape(async () => {
      await bridge.open().catch(() => {}); // 首次失败是被 await 住的
      await new Promise((r) => setTimeout(r, 400)); // 让重连定时器反复触发
    });

    await bridge.close();
  });

  it("心跳 send() 在连接已死时不崩，走 onUnexpectedClose 重连", async () => {
    const bridge = new Bridge({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      autoReconnect: false,
      heartbeatMs: 20, // 把心跳压到 20ms
    });

    await assertNoEscape(async () => {
      await bridge.open();
      // 强制把底层 socket 弄成不可写状态：先 close 掉引用再让心跳继续跑
      (bridge as unknown as { ws: WebSocket | null }).ws = null;
      await new Promise((r) => setTimeout(r, 200));
    });

    await bridge.close();
  });

  it("坏 token 只报 auth_failed，不无限重连也不抛逃逸异常", async () => {
    const bridge = new Bridge({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      token: "0".repeat(64), // 格式合法但不在白名单
      autoReconnect: true,
      reconnectBackoffMs: [10],
    });

    await assertNoEscape(async () => {
      await assert.rejects(() => bridge.open(), /auth failed/);
      await new Promise((r) => setTimeout(r, 150));
    });

    await bridge.close();
  });
});

// ---------------------------------------------------------------- 3

describe("channel/manager.ts remove() 清理是 best-effort", () => {
  it("重复 remove 同一信道不抛（stop() 抛错被吞）", async () => {
    // 用真实的 ChannelManager 走一遍"建立 → remove → 再 remove"
    const { ChannelManager } = await import("../../src/channel/manager.js");
    const { buildServer } = await import("../../src/server.js");

    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const gw = new GatewayServer({ port: 0, tokens: [TOKEN], heartbeatTimeoutMs: 30_000 });
    const port = (await gw.start()).port;

    const mgr = new ChannelManager(
      new Bridge({ gatewayUrl: "local", autoReconnect: false }),
      async () => (await buildServer({ extensionsDir: path.join(REPO_ROOT, "extensions") })).server,
    );

    try {
      const { bindingId } = await mgr.establish({
        gatewayUrl: `ws://127.0.0.1:${port}`,
        token: TOKEN,
        name: "crash-reg",
      });
      assert.ok(bindingId);

      await assertNoEscape(async () => {
        await mgr.remove(bindingId);
        // 再 remove 一次：底层 bridge/close 已经结束了，
        // 旧代码里这里的 void remove() 会产生 unhandledRejection
        await mgr.remove(bindingId).catch(() => {});
        await new Promise((r) => setTimeout(r, 100));
      });
    } finally {
      await gw.stop();
    }
  });
});

// ---------------------------------------------------------------- 4

describe("tools/files.ts 文本模式体积上限（防 OOM）", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-crash-"));
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("超过 50MB 的文本模式读取被拒绝，且提示改用字节模式", async () => {
    const big = path.join(tmpDir, "big.txt");
    // 稀疏写 >50MB，避免真的往磁盘灌 50MB 数据
    const fh = await fs.open(big, "w");
    await fh.write(Buffer.alloc(1024));
    // 超过阈值即可（stat.size 判定），无需真实填满
    await fh.truncate(51 * 1024 * 1024);
    await fh.close();

    await assert.rejects(
      () => readFile({ path: big }),
      /file-too-large/,
      "超限文件必须拒绝，不能让整个文件进内存",
    );
    await assert.rejects(() => readFile({ path: big }), /字节模式/);
  });

  it("字节模式对同一超大文件仍可分页读取（不触发上限）", async () => {
    const big = path.join(tmpDir, "big.txt");
    const r = await readFile({ path: big, startByte: 0, maxBytes: 16 });
    assert.equal(r.mode, "bytes");
    assert.equal(r.totalBytes, 51 * 1024 * 1024);
    assert.equal(r.bytes, 16);
    assert.equal(r.truncated, true);
  });

  it("正常大小文件照常读取，未被上限误伤", async () => {
    const small = path.join(tmpDir, "small.txt");
    await fs.writeFile(small, "hello world", "utf-8");
    const r = await readFile({ path: small });
    assert.ok(r.content.includes("hello world"));
  });
});