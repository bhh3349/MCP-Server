/**
 * File tools: bounded reads, atomic writes, listing, hashing.
 * All paths are resolved against MCP_SERVER_ROOT (default: cwd).
 * Writes are atomic (temp file + rename) with optional SHA-256 precondition.
 *
 * 错误一律带错误码前缀，便于调用方分支处理（测试报告 P1）：
 *   file-not-found: <path>      路径不存在（原裸 ENOENT）
 *   is-directory: <path>         对目录做文件读/哈希（原裸 EISDIR）
 *   not-a-directory: <path>      list_files 的目标不是目录（原裸 ENOTDIR）
 *   permission-denied: <path>    权限不足（EACCES/EPERM）
 *   path-escapes-root: <path>    越界（沙箱拒绝）
 *   stale-file: ...             CAS 前置条件失败（带完整 64 位哈希，可直接重试）
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

/** 把常见 fs 错误码翻译成带错误码前缀的 Error（测试报告 P1：错误面结构化） */
function fsError(e: unknown, path: string): Error {
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT":
      return new Error(`file-not-found: ${path}`);
    case "EISDIR":
      return new Error(`is-directory: ${path}`);
    case "ENOTDIR":
      return new Error(`not-a-directory: ${path}`);
    case "EACCES":
    case "EPERM":
      return new Error(`permission-denied: ${path}`);
    case "EROFS":
      return new Error(`read-only-filesystem: ${path}`);
    default:
      return e as Error;
  }
}

// ---------------------------------------------------------------- read_file

export const ReadFileInput = z.object({
  path: z.string().describe("Path relative to server root"),
  offset: z.number().int().min(0).optional().describe("Start line, 0-based (text mode)"),
  limit: z.number().int().min(1).max(2000).optional().describe("Max lines (text mode)"),
  encoding: z.enum(["utf8", "base64"]).default("utf8")
    .describe("utf8 = text (default); base64 = raw bytes, lossless for binary"),
  startByte: z.number().int().min(0).optional()
    .describe("Byte offset — enables byte mode (offset/limit are ignored)"),
  maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional()
    .describe("Max bytes to return (byte mode)"),
  stripBom: z.boolean().default(true)
    .describe("Strip leading UTF-8 BOM (U+FEFF) in text mode"),
});

const BOM = "﻿";

export async function readFile(args: z.infer<typeof ReadFileInput>) {
  const { path, offset, limit, encoding, startByte, maxBytes, stripBom } = ReadFileInput.parse(args);
  const abs = safePath(path);
  const rel = relative(ROOT, abs);

  // ---- byte mode: startByte/maxBytes 任一出现即按字节读 ----
  if (startByte !== undefined || maxBytes !== undefined) {
    let fh;
    try {
      fh = await fs.open(abs, "r");
    } catch (e) {
      throw fsError(e, path);
    }
    try {
      const st = await fh.stat();
      if (st.isDirectory()) throw new Error(`is-directory: ${path}`);
      const totalBytes = st.size;
      const from = startByte ?? 0;
      const len = Math.min(maxBytes ?? totalBytes, Math.max(0, totalBytes - from));
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, from);
      const content = encoding === "base64" ? buf.toString("base64") : buf.toString("utf-8");
      return {
        path: rel,
        mode: "bytes" as const,
        encoding,
        totalBytes,
        startByte: from,
        bytes: buf.length,
        content,
        truncated: from + len < totalBytes,
      };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  // ---- text mode: 按行分页 ----
  let text: string;
  try {
    text = await fs.readFile(abs, "utf-8");
  } catch (e) {
    throw fsError(e, path);
  }
  let bomStripped = false;
  if (stripBom && text.startsWith(BOM)) {
    text = text.slice(BOM.length);
    bomStripped = true;
  }
  const lines = text.split("\n");
  const start = offset ?? 0;
  const end = limit ? start + limit : lines.length;
  const slice = lines.slice(start, end).join("\n");
  const content = encoding === "base64"
    ? Buffer.from(slice, "utf-8").toString("base64")
    : slice;
  return {
    path: rel,
    mode: "text" as const,
    encoding,
    totalLines: lines.length,
    offset: start,
    bytes: Buffer.byteLength(slice, "utf-8"),
    bomStripped,
    content,
    truncated: end < lines.length,
  };
}

// ---------------------------------------------------------------- write_file

export const WriteFileInput = z.object({
  path: z.string().describe("Path relative to server root"),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe(
    "base64 = content 是 base64 编码的二进制，写入前解码",
  ),
  expectedHash: z.string().optional().describe(
    "SHA-256 of current content; 'absent' = file must not exist. Write fails on mismatch (stale-file, full hashes).",
  ),
});

export async function writeFile(args: z.infer<typeof WriteFileInput>) {
  const { path, content, encoding, expectedHash } = WriteFileInput.parse(args);
  const abs = safePath(path);
  const rel = relative(ROOT, abs);

  const prevStat = await fs.stat(abs).catch(() => null);
  const prevIsFile = !!prevStat && prevStat.isFile();
  const previousBytes: number | null = prevIsFile ? prevStat!.size : null;

  if (expectedHash !== undefined) {
    if (expectedHash === "absent") {
      // 显式"必须不存在"语义（测试报告 P2），取代 sha256("") 隐式配方
      if (prevStat) {
        throw new Error(
          `stale-file: expected absent, but file exists (${previousBytes} bytes): ${path}`,
        );
      }
    } else {
      if (!prevIsFile) throw new Error(`file-not-found: ${path}`);
      const cur = await fs.readFile(abs);
      const h = createHash("sha256").update(cur).digest("hex");
      if (h !== expectedHash.toLowerCase()) {
        throw new Error(`stale-file: expected ${expectedHash}, got ${h}`);
      }
    }
  }

  await fs.mkdir(join(abs, ".."), { recursive: true });
  // atomic: write temp + rename（同文件系统）；跨盘时 rename 会 EXDEV，退化为 copy
  const data = encoding === "base64" ? Buffer.from(content, "base64") : content;
  const tmp = join(tmpdir(), `mcp-write-${randomUUID()}`);
  if (typeof data === "string") {
    await fs.writeFile(tmp, data, "utf-8");
  } else {
    await fs.writeFile(tmp, data);
  }
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
      await fs.copyFile(tmp, abs);
      await fs.unlink(tmp).catch(() => {});
    } else {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  const hash = createHash("sha256").update(buf).digest("hex");
  return {
    path: rel,
    bytes: buf.length,
    sha256: hash,
    previousBytes,
    overwrote: previousBytes !== null,
  };
}

// ---------------------------------------------------------------- list_files

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export const ListFilesInput = z.object({
  path: z.string().default(".").describe("Directory relative to server root"),
  recursive: z.boolean().default(false),
  glob: z.string().optional().describe("Filter by file/dir name, e.g. '*.ts', 'test-?' (* and ? wildcards)"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(1000).default(200),
});

interface DirEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number | null;
  mtimeMs: number | null;
}

export async function listFiles(args: z.infer<typeof ListFilesInput>) {
  const { path, recursive, glob, offset, limit } = ListFilesInput.parse(args);
  const abs = safePath(path);
  const out: DirEntry[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw fsError(e, path);
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(ROOT, full).split(sep).join("/");
      const st = await fs.stat(full).catch(() => null);
      const isDir = e.isDirectory();
      out.push({
        path: rel,
        name: e.name,
        type: isDir ? "dir" : "file",
        size: isDir ? null : (st?.size ?? null),
        mtimeMs: st?.mtimeMs ?? null,
      });
      if (isDir && recursive && depth < 5) await walk(full, depth + 1);
    }
  }

  await walk(abs, 0);

  const re = glob ? globToRegExp(glob) : null;
  const filtered = re ? out.filter((e) => re.test(e.name)) : out;
  filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const total = filtered.length;
  const slice = filtered.slice(offset, offset + limit);
  return {
    root: relative(ROOT, abs) || ".",
    total,
    offset,
    limit,
    truncated: offset + limit < total,
    entries: slice,
  };
}

// ---------------------------------------------------------------- file_hash

export const FileHashInput = z.object({
  path: z.string().describe("Path relative to server root"),
});
export async function fileHash(args: z.infer<typeof FileHashInput>) {
  const { path } = FileHashInput.parse(args);
  const abs = safePath(path);
  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch (e) {
    throw fsError(e, path);
  }
  return {
    path: relative(ROOT, abs),
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
}

// ---------------------------------------------------------------- delete_file

export const DeleteFileInput = z.object({
  path: z.string().describe("Path relative to server root"),
  recursive: z.boolean().default(false).describe("目录时递归删除（默认 false，目录非空会报错）"),
});
export async function deleteFile(args: z.infer<typeof DeleteFileInput>) {
  const { path, recursive } = DeleteFileInput.parse(args);
  const abs = safePath(path);
  const rel = relative(ROOT, abs);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(abs);
  } catch (e) {
    throw fsError(e, path);
  }
  try {
    if (stat.isDirectory()) {
      await fs.rm(abs, { recursive, force: false });
    } else {
      await fs.unlink(abs);
    }
  } catch (e) {
    throw fsError(e, path);
  }
  return { path: rel, deleted: true, wasDirectory: stat.isDirectory() };
}

// ---------------------------------------------------------------- move_file

export const MoveFileInput = z.object({
  src: z.string().describe("Source path relative to server root"),
  dest: z.string().describe("Destination path relative to server root"),
  overwrite: z.boolean().default(false).describe("目标已存在时是否覆盖"),
});
export async function moveFile(args: z.infer<typeof MoveFileInput>) {
  const { src, dest, overwrite } = MoveFileInput.parse(args);
  const absSrc = safePath(src);
  const absDest = safePath(dest);
  let srcStat: import("node:fs").Stats;
  try {
    srcStat = await fs.stat(absSrc);
  } catch (e) {
    throw fsError(e, src);
  }
  if (!overwrite) {
    const exists = await fs.stat(absDest).catch(() => null);
    if (exists) throw new Error(`dest-exists: ${dest} (use overwrite:true)`);
  }
  try {
    await fs.mkdir(join(absDest, ".."), { recursive: true });
    await fs.rename(absSrc, absDest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
      // 跨盘：复制后删除
      const { copyFile, rm } = fs;
      if (srcStat.isDirectory()) throw new Error(`cross-device directory move not supported: ${src}`);
      await copyFile(absSrc, absDest);
      await fs.unlink(absSrc);
    } else {
      throw fsError(e, dest);
    }
  }
  return {
    src: relative(ROOT, absSrc),
    dest: relative(ROOT, absDest),
    moved: true,
    wasDirectory: srcStat.isDirectory(),
  };
}
