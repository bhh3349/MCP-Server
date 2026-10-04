/**
 * http_request: 发起 HTTP(S) 请求，返回状态/头/正文。
 * 替代 exec 套 curl 的笨办法，输出结构化。
 * 限制：默认超时 30s，正文上限 5MB（超了截断并标记）。
 */
import { z } from "zod";

const MAX_BODY = 5 * 1024 * 1024;

export const HttpRequestInput = z.object({
  url: z.string().url().describe("http(s) URL"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional().describe("请求头"),
  body: z.string().optional().describe("请求正文（字符串）"),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxBytes: z.number().int().min(1024).max(MAX_BODY).default(MAX_BODY),
});

export async function httpRequest(args: z.infer<typeof HttpRequestInput>) {
  const { url, method, headers, body, timeoutMs, maxBytes } = HttpRequestInput.parse(args);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const h = new Headers({ "User-Agent": "mcp-server/1.0" });
    if (headers) for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const res = await fetch(url, {
      method,
      headers: h,
      body: body ?? null,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;
    const ct = res.headers.get("content-type") || "";
    const isText = /text|json|xml|html|javascript|svg/i.test(ct) || !ct;
    return {
      url: res.url,
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      truncated,
      bytes: buf.length,
      body: isText ? slice.toString("utf-8") : slice.toString("base64"),
      bodyEncoding: isText ? "utf8" : "base64",
    };
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? `timeout after ${timeoutMs}ms: ${url}` : String(e);
    throw new Error(`http-request-failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
