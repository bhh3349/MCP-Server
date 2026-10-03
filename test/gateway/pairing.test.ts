/**
 * 网关单元测试：配对码、token、协议常量。
 * 运行：npx tsx --test test/gateway/pairing.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generatePairingCode,
  isValidPairingCode,
  PAIRING_CODE_LENGTH,
  PAIRING_ALPHABET,
  isPairingExpired,
  type PairingRecord,
} from "../../src/channel/pairing.js";
import { generateGatewayToken } from "../../src/gateway/server.js";
import { TOKEN_RE } from "../../src/gateway/protocol.js";

describe("pairing code", () => {
  it("12 位长度", () => {
    assert.equal(generatePairingCode().length, PAIRING_CODE_LENGTH);
  });

  it("字符集无易混淆字符", () => {
    assert.ok(!PAIRING_ALPHABET.includes("0"));
    assert.ok(!PAIRING_ALPHABET.includes("O"));
    assert.ok(!PAIRING_ALPHABET.includes("1"));
    assert.ok(!PAIRING_ALPHABET.includes("l"));
    assert.ok(!PAIRING_ALPHABET.includes("I"));
  });

  it("1 万个无碰撞", () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) set.add(generatePairingCode());
    assert.equal(set.size, 10_000);
  });

  it("格式校验", () => {
    assert.ok(isValidPairingCode(generatePairingCode()));
    assert.ok(!isValidPairingCode("short"));
    assert.ok(!isValidPairingCode("toolongcode123"));
    assert.ok(!isValidPairingCode("has space 12"));
    assert.ok(!isValidPairingCode("has-dash-123"));
    assert.ok(!isValidPairingCode(123));
    assert.ok(!isValidPairingCode(null));
  });

  it("TTL 过期判定", () => {
    const now = Date.now();
    const fresh: PairingRecord = { code: "x", bindingId: "y", createdAt: now, used: false };
    assert.ok(!isPairingExpired(fresh, now));
    const old: PairingRecord = { code: "x", bindingId: "y", createdAt: now - 16 * 60 * 1000, used: false };
    assert.ok(isPairingExpired(old, now));
    const used: PairingRecord = { code: "x", bindingId: "y", createdAt: now, used: true };
    assert.ok(isPairingExpired(used, now));
  });
});

describe("gateway token", () => {
  it("64 位 hex", () => {
    const t = generateGatewayToken();
    assert.ok(TOKEN_RE.test(t), t);
    assert.equal(t.length, 64);
  });

  it("每次不同", () => {
    assert.notEqual(generateGatewayToken(), generateGatewayToken());
  });

  it("格式拒绝", () => {
    assert.ok(!TOKEN_RE.test("short"));
    assert.ok(!TOKEN_RE.test("g".repeat(64))); // 非 hex
    assert.ok(!TOKEN_RE.test("a".repeat(63)));
  });
});
