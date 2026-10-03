/**
 * File tools: bounded reads, atomic writes, listing, search.
 * All paths are resolved against MCP_SERVER_ROOT (default: cwd).
 * Writes are atomic (temp file + rename) with optional SHA-256 precondition.
 */
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { z } from "zod";

const ROOT = resolve(process.env.MCP_SERVER_ROOT || process.cwd());

function safePath(p: string): string {
  const abs = resolve(ROOT, p);
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..") || abs === ROOT.replace(/[/\\]$/, "")) {
    // allow ROOT itself for listing; block escapes
    if (rel.startsWith("..")) throw new Error(`path escapes root: ${p}`);
  }
  return abs;
}

export const ReadFileInput = z.object({
  path: z.string().describe("Path relative to server root"),
  offset: z.number().int().min(0).optional().describe("Start line (0-based)"),
  limit: z.number().int().min(1).max(2000).optional().describe("Max lines"),
});
export async function readFile({ path, offset, limit }: z.infer<typeof ReadFileInput>) {
  const abs = safePath(path);
  const text = await fs.readFile(abs, "utf-8");
  const lines = text.split("\n");
  const start = offset ?? 0;
  const end = limit ? start + limit : lines.length;
  const slice = lines.slice(start, end);
  return {
    path: relative(ROOT, abs),
    totalLines: lines.length,
    offset: start,
    content: slice.join("\n"),
    truncated: end < lines.length,
  };
}

export const WriteFileInput = z.object({
  path: z.string().describe("Path relative to server root"),
  content: z.string(),
  expectedHash: z.string().optional().describe("SHA-256 of current content; write fails if mismatch"),
});
export async function writeFile({ path, content, expectedHash }: z.infer<typeof WriteFileInput>) {
  const abs = safePath(path);
  if (expectedHash) {
    try {
      const cur = await fs.readFile(abs, "utf-8");
      const h = createHash("sha256").update(cur).digest("hex");
      if (h !== expectedHash.toLowerCase()) {
        throw new Error(`stale-file: expected ${expectedHash.slice(0, 12)}…, got ${h.slice(0, 12)}…`);
      }
    } catch (e: unknown) {
      if ((e as Error).message.startsWith("stale-file")) throw e;
      // file doesn't exist yet — that's fine, skip hash check
    }
  }
  await fs.mkdir(join(abs, ".."), { recursive: true });
  // atomic: write temp + rename
  const tmp = join(tmpdir(), `mcp-write-${randomUUID()}`);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, abs);
  const hash = createHash("sha256").update(content).digest("hex");
  return { path: relative(ROOT, abs), bytes: Buffer.byteLength(content), sha256: hash };
}

export const ListFilesInput = z.object({
  path: z.string().default(".").describe("Directory relative to server root"),
  recursive: z.boolean().default(false),
});
export async function listFiles({ path, recursive }: z.infer<typeof ListFilesInput>) {
  const abs = safePath(path);
  const out: Array<{ path: string; type: "file" | "dir"; size?: number | undefined }> = [];
  async function walk(dir: string, depth: number) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(ROOT, full).split(sep).join("/");
      if (e.isDirectory()) {
        out.push({ path: rel, type: "dir" });
        if (recursive && depth < 5) await walk(full, depth + 1);
      } else {
        const st = await fs.stat(full).catch(() => null);
        out.push({ path: rel, type: "file", size: st?.size });
      }
    }
  }
  await walk(abs, 0);
  return { root: relative(ROOT, abs) || ".", entries: out.slice(0, 500) };
}

export const FileHashInput = z.object({
  path: z.string().describe("Path relative to server root"),
});
export async function fileHash({ path }: z.infer<typeof FileHashInput>) {
  const abs = safePath(path);
  const data = await fs.readFile(abs);
  return {
    path: relative(ROOT, abs),
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
}
