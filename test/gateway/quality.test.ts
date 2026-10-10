/**
 * 网关 AI 质量测量测试（端到端延迟 / 抖动 / pong 应答率）。
 *
 * 口径见 src/gateway/quality.ts 开头：AI 是第三方网页，不支持 ping/pong，
 * 所以测的是"AI 发请求 → MCP 回包"这条业务链路，pongRate 默认为 null。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QualityTracker } from "../../src/gateway/quality.js";

describe("QualityTracker 端到端延迟", () => {
  it("单次往返的延迟 = 回包时刻 - 发起时刻", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 1000);
    q.onMcpResponse(undefined, "c1", 1150);
    const s = q.snapshot("c1", 2000);
    assert.equal(s.e2eAvgMs, 150);
    assert.equal(s.samples, 1);
  });

  it("无回包时样本不增加（不能凭空造出延迟）", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 1000);
    assert.equal(q.snapshot("c1", 2000).samples, 0);
  });

  it("超过 120s 的往返被丢弃（多半是 AI 没等回包就又发了一次）", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 0);
    q.onMcpResponse(undefined, "c1", 200_000);
    assert.equal(q.snapshot("c1").samples, 0);
  });

  it("多次往返取平均，样本数正确累加", () => {
    const q = new QualityTracker();
    for (let i = 1; i <= 4; i++) {
      q.onAiRequest("c1", undefined, i * 1000);
      q.onMcpResponse(undefined, "c1", i * 1000 + 100);
    }
    const s = q.snapshot("c1");
    assert.equal(s.samples, 4);
    assert.equal(s.e2eAvgMs, 100);
  });

  it("p95 不低于 p50（分位数单调）", () => {
    const q = new QualityTracker({ windowSize: 100 });
    for (let i = 1; i <= 100; i++) {
      q.onAiRequest("c1", undefined, i * 1000);
      q.onMcpResponse(undefined, "c1", i * 1000 + i);
    }
    const s = q.snapshot("c1");
    assert.ok(s.e2eP95Ms! >= 90 && s.e2eP95Ms! <= 100, `p95=${s.e2eP95Ms}`);
    assert.ok(s.e2eP95Ms! >= s.e2eAvgMs!);
  });

  it("滑动窗口封顶，样本数不会无限增长", () => {
    const q = new QualityTracker({ windowSize: 10 });
    for (let i = 1; i <= 50; i++) {
      q.onAiRequest("c1", undefined, i * 1000);
      q.onMcpResponse(undefined, "c1", i * 1000 + 10);
    }
    assert.equal(q.snapshot("c1").samples, 10);
  });
});

describe("QualityTracker 抖动", () => {
  it("等间隔到达 → 抖动为 0", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 0);
    q.onAiRequest("c1", undefined, 100);
    q.onAiRequest("c1", undefined, 200);
    assert.equal(q.snapshot("c1").jitterMs, 0);
  });

  it("间隔忽大忽小 → 抖动为正", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 0);
    q.onAiRequest("c1", undefined, 100);
    q.onAiRequest("c1", undefined, 400);
    assert.ok((q.snapshot("c1").jitterMs ?? 0) > 0);
  });

  it("样本不足 2 条时抖动为 null（0 会被误读成极稳定）", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 0);
    assert.equal(q.snapshot("c1").jitterMs, null);
  });

  it("超长空洞（切后台/断网重连）不计入抖动", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 0);
    q.onAiRequest("c1", undefined, 60_000); // 60s 间隔不是网络抖动
    assert.equal(q.snapshot("c1").jitterMs, null);
  });
});

describe("QualityTracker pong 应答率", () => {
  it("AI 从未回 pong 时为 null，而不是 0%", () => {
    const q = new QualityTracker();
    q.onPingSent("c1", 1000);
    q.onPingSent("c1", 2000);
    assert.equal(q.snapshot("c1").pongRate, null, "第三方网页 AI 不支持 ping，null 才是诚实的");
  });

  it("有回包时按比例计算", () => {
    const q = new QualityTracker();
    q.onPingSent("c1", 1);
    q.onPingSent("c1", 2);
    q.onPong("c1");
    assert.equal(q.snapshot("c1").pongRate, 0.5);
  });
});

describe("QualityTracker 信道状态", () => {
  it("AI 从未发过消息 → aiActive=false", () => {
    const q = new QualityTracker();
    assert.equal(q.snapshot("c1").aiActive, false);
  });

  it("AI 发过消息 → aiActive=true 且能算出距今时长", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 5000);
    const s = q.snapshot("c1", 8000);
    assert.equal(s.aiActive, true);
    assert.equal(s.lastAiMsgAgoMs, 3000);
  });

  it("forget 清理全部状态（防长期运行内存泄漏）", () => {
    const q = new QualityTracker();
    q.onAiRequest("c1", undefined, 1000);
    q.onMcpResponse(undefined, "c1", 1100);
    q.onPingSent("c1", 1000);
    q.forget("c1");
    const s = q.snapshot("c1");
    assert.equal(s.samples, 0);
    assert.equal(s.aiActive, false);
    assert.equal(s.pongRate, null);
  });

  it("多信道互不干扰", () => {
    const q = new QualityTracker();
    q.onAiRequest("a", undefined, 0);
    q.onMcpResponse(undefined, "a", 100);
    q.onAiRequest("b", undefined, 0);
    q.onMcpResponse(undefined, "b", 500);
    assert.equal(q.snapshot("a").e2eAvgMs, 100);
    assert.equal(q.snapshot("b").e2eAvgMs, 500);
  });
});