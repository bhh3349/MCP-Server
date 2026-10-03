/**
 * 配对码设计。
 *
 * 为什么配对码必须与网关 token 分离：
 * - token（64 hex）是 MCP 连接网关的凭证，绝不能外泄；
 * - 配对码是用户复制给网页 AI 的东西，会经过聊天窗口、剪贴板等不可信路径；
 * - 两者混用 = 分享配对码 = 泄露网关凭证。
 *
 * 配对码格式：12 位，A-Za-z0-9（去掉 0/O/1/l/I 等易混淆字符），
 * 熵 58^12 ≈ 2.2e21，配合网关侧限流 + TTL 足够安全。
 *
 * 生命周期（网关侧执行）：
 * - 由网关在收到建信道请求后生成；
 * - TTL 15 分钟，超时未被网页 AI 使用则失效；
 * - 一次性：join 成功后立即失效；同一信道需要重新配对时申请新的。
 */
import { randomBytes } from "node:crypto";

/** 配对码字符集：大小写字母 + 数字，排除易混淆字符 */
export const PAIRING_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export const PAIRING_CODE_LENGTH = 12;
/** 配对码有效期（毫秒） */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

const PAIRING_RE = /^[A-Za-z0-9]{12}$/;

/** 生成配对码（网关侧调用） */
export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  }
  return code;
}

/** 校验配对码格式（网关收到 join 请求时先做格式校验，再查索引） */
export function isValidPairingCode(code: unknown): code is string {
  return typeof code === "string" && PAIRING_RE.test(code);
}

/** 网关侧配对码记录 */
export interface PairingRecord {
  code: string;
  bindingId: string;
  createdAt: number;
  used: boolean;
}

export function isPairingExpired(rec: PairingRecord, now = Date.now()): boolean {
  return rec.used || now - rec.createdAt > PAIRING_TTL_MS;
}
