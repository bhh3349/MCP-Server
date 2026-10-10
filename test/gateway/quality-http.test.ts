/**
 * 回归测试：HTTP 代理通道（第三方网页 AI 走的那条路）必须能测到延迟。
 *
 * 背景：此前打点只加在 forwardToMcp/forwardToAi（WS 通道），
 * 而网页 AI 走 POST /mcp/{id} 代理，压根不经过这两个函数 → 指标永远为空。
 * 这个测试锁住 HTTP 通道的打点，防止回归。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QualityTracker } from "../../src/gateway/quality.js";

describe("HTTP 通道打点（internalId 精确配对）", () => {
  it("HTTP 请求用内部 id 配对，延迟计入所属信道", () => {
    const q = new QualityTracker();
    // 信道 ch1 上同时发起 3 个请求（并发，各自内部 id）
    q.onAiRequest("ch1", "gw_1_abc", 1000);
    q.onAiRequest("ch1", "gw_2_abc", 1010);
    q.onAiRequest("ch1", "gw_3_abc", 1020);
    // 回包乱序到达
    q.onMcpResponse("gw_2_abc", "ch1", 1110); // 100ms
    q.onMcpResponse("gw_1_abc", "ch1", 1210); // 210ms
    q.onMcpResponse("gw_3_abc", "ch1", 1320); // 300ms
    const s = q.snapshot("ch1");
    assert.equal(s.samples, 3);
    assert.equal(s.e2eAvgMs, 203); // (100+210+300)/3 ≈ 203
  });

  it("内部 id 错配时不产生样本（不能拿别的请求凑数）", () => {
    const q = new QualityTracker();
    q.onAiRequest("ch1", "gw_A", 1000);
    // 回包带的 id 没有登记过
    q.onMcpResponse("gw_B", "ch1", 1100);
    assert.equal(q.snapshot("ch1").samples, 0);
  });

  it("内部 id 属于别的信道时不串数据", () => {
    const q = new QualityTracker();
    q.onAiRequest("ch1", "gw_A", 1000);
    q.onAiRequest("ch2", "gw_B", 1000);
    q.onMcpResponse("gw_A", "ch1", 1100);
    q.onMcpResponse("gw_B", "ch2", 1300);
    assert.equal(q.snapshot("ch1").e2eAvgMs, 100);
    assert.equal(q.snapshot("ch2").e2eAvgMs, 300);
  });

  it("通知类只记活动、不登记在途（不会堆积）", () => {
    const q = new QualityTracker();
    q.noteAiActivity("ch1", 1000);
    assert.equal(q.snapshot("ch1").aiActive, true);
    assert.equal(q.snapshot("ch1").samples, 0, "通知不应产生延迟样本");
  });

  it("通知与请求混合时活动与延迟各自正确", () => {
    const q = new QualityTracker();
    q.noteAiActivity("ch1", 1000);            // 通知
    q.onAiRequest("ch1", "gw_A", 1100);      // 请求
    q.onMcpResponse("gw_A", "ch1", 1150);    // 回包
    const s = q.snapshot("ch1");
    assert.equal(s.samples, 1);
    assert.equal(s.e2eAvgMs, 50);
  });

  it("forget 清理 HTTP 通道在途请求（内部 id 不等于信道 id）", () => {
    const q = new QualityTracker();
    q.onAiRequest("ch1", "gw_A", 1000);
    q.onAiRequest("ch1", "gw_B", 1010);
    q.forget("ch1");
    // 关闭后迟到的回包不应复活任何样本
    q.onMcpResponse("gw_A", "ch1", 1100);
    q.onMcpResponse("gw_B", "ch1", 1110);
    const s = q.snapshot("ch1");
    assert.equal(s.samples, 0);
    assert.equal(s.aiActive, false);
  });

  it("WS 通道（reqKey 省略）仍按信道配对", () => {
    const q = new QualityTracker();
    // 两侧都用显式时间戳，避免真实时钟与相对时间混用（差值会超120s 上限被丢弃）
    q.onAiRequest("chWS", undefined, 1000);
    q.onMcpResponse(undefined, "chWS", 1150);
    assert.equal(q.snapshot("chWS").e2eAvgMs, 150);
  });
});