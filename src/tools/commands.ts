/**
 * 内置命令执行：编码安全的 shell。
 *
 * Windows 上只用 Git Bash（bash.exe -c），不用 PowerShell；
 * 找不到 Git Bash 时直接报错（不静默回退）。
 *
 * 解决的坑（见测试报告 C-04/C-05/C-06）：
 * 1. GBK 控制台吃中文 —— 不走控制台：Node 直接 spawn 子进程，stdio 全管道，
 *    bash 侧 UTF-8，Node 侧按 UTF-8 解码。
 * 2. 引号地狱 —— 命令经 spawn argv 原样送达 bash -c，不再被 PowerShell 命令行解析剥掉。
 * 3. stdout/stderr 合并 —— 分开捕获、分开返回。
 *
 * 回执统一形状（测试报告 P1）：{ jobId?, status, done, killed,
 *   stdout, stderr, exitCode, durationMs, truncated }。
 * 前台 exec 没有 jobId（记录已清理）；后台三件套形状完全一致。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { resolveShell } from "./shell.js";

export interface JobRecord {
  proc: ChildProcess;
  stdout: Buffer[];
  stderr: Buffer[];
  done: boolean;
  code: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
  killed: boolean;
  /** 进程退出时 resolve，供 jobKill 等待 */
  waitDone: Promise<void>;
}

const jobs = new Map<string, JobRecord>();
let seq = 0;

/** 已结束的后台作业保留时长：超时自动回收，避免输出缓冲区无界累积 */
const DONE_JOB_TTL_MS = 5 * 60 * 1000;
/** 已完成作业最多保留条数（超出即回收最旧的），防止短时大量作业撑爆内存 */
const MAX_DONE_JOBS = 50;
/** 单作业输出缓冲区上限：超出丢弃最旧部分，防止 tail -f 类任务无限增长 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

let gcTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 后台作业 GC：定时回收已结束（done/killed）的作业记录。
 * 此前 jobCleanup 存在但全代码库零调用 —— 每个后台作业的输出会永久驻留，
 * 长跑时内存单调增长。这里在首次创建作业时装上定时器。
 */
function ensureJobGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    // 1. 按 TTL 回收已结束的
    for (const [id, rec] of jobs) {
      if (!rec.done) continue;
      if (rec.endedAt !== null && now - rec.endedAt > DONE_JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
    // 2. 已结束的仍超限 → 回收最旧的
    let doneCount = 0;
    for (const rec of jobs.values()) if (rec.done) doneCount++;
    if (doneCount > MAX_DONE_JOBS) {
      const doneIds = [...jobs.entries()]
        .filter(([, r]) => r.done)
        .sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0))
        .map(([id]) => id);
      for (const id of doneIds.slice(0, doneCount - MAX_DONE_JOBS)) jobs.delete(id);
    }
    // 3. 没有作业了就停掉定时器，避免空转
    if (jobs.size === 0 && gcTimer) {
      clearInterval(gcTimer);
      gcTimer = null;
    }
  }, 60_000);
  if (gcTimer.unref) gcTimer.unref();
}

function decode(buf: Buffer[]): string {
  return Buffer.concat(buf).toString("utf-8");
}

export const ExecInput = z.object({
  command: z.string().describe("Shell command to run"),
  cwd: z.string().optional().describe("Working directory"),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
  background: z.boolean().default(false).describe("Return immediately with a job id"),
  /** 输出截断上限（字符），默认 20000 */
  maxOutputChars: z.number().int().min(1000).max(200000).default(20000),
});

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

/**
 * 统一的作业对象（测试报告 P1：exec / job_output / job_kill 回执形状一致）。
 * - 前台 exec：没有 jobId（记录已清理，不可再查），其余字段齐全。
 * - 后台 exec：jobId + status:"running"，输出为空。
 * - job_output / job_kill：同一形状的当前快照。
 */
export interface JobResult extends ExecResult {
  jobId?: string;
  status: "running" | "done" | "killed";
  done: boolean;
  killed: boolean;
}

function jobStatus(rec: JobRecord): JobResult["status"] {
  if (!rec.done) return "running";
  // killed:true 但 exitCode 为 null = 被 kill 中断；kill 时已自然结束则算 done
  if (rec.killed && rec.code === null) return "killed";
  return "done";
}

function toJobResult(id: string | undefined, rec: JobRecord | null, maxChars: number): JobResult {
  if (!rec) {
    return {
      ...(id ? { jobId: id } : {}),
      status: "running",
      done: false,
      killed: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 0,
      truncated: false,
    };
  }
  return {
    ...(id ? { jobId: id } : {}),
    status: jobStatus(rec),
    done: rec.done,
    killed: rec.killed,
    ...summarize(rec, maxChars),
  };
}

function summarize(rec: JobRecord, maxChars: number): ExecResult {
  const stdout = decode(rec.stdout);
  const stderr = decode(rec.stderr);
  const durationMs = (rec.endedAt ?? Date.now()) - rec.startedAt;
  let truncated = false;
  let out = stdout;
  let err = stderr;
  if (out.length + err.length > maxChars) {
    truncated = true;
    // 优先保 stdout
    out = out.slice(-maxChars);
    err = err.length > 2000 ? err.slice(-2000) : err;
  }
  return { stdout: out, stderr: err, exitCode: rec.code, durationMs, truncated };
}

export async function exec(
  args: z.infer<typeof ExecInput>,
): Promise<JobResult> {
  const { command, cwd, timeoutMs, background, maxOutputChars } = ExecInput.parse(args);
  const id = `job-${++seq}-${Date.now().toString(36)}`;
  const { shell, args: shellArgs } = resolveShell();

  const startedAt = Date.now();
  const proc = spawn(shell, shellArgs(command), {
    cwd,
    timeout: background ? 0 : timeoutMs,
    windowsHide: true,
    // 独立进程组：jobKill 时可一次性杀掉 shell 及其子进程，
    // 否则孤儿子进程攥着管道不放，close 事件迟迟不触发。
    detached: process.platform !== "win32",
  });
  const rec: JobRecord = {
    proc,
    stdout: [],
    stderr: [],
    done: false,
    code: null,
    signal: null,
    startedAt,
    endedAt: null,
    killed: false,
    waitDone: Promise.resolve(),
  };
  jobs.set(id, rec);
  ensureJobGc();

  // 输出缓冲区加上限：只保留最近 MAX_OUTPUT_BYTES，丢弃最旧的块。
  // 没有这层保护，tail -f / 长压测类任务会把内存吃满。
  const pushCapped = (arr: Buffer[], d: Buffer): void => {
    arr.push(d);
    let total = 0;
    for (const b of arr) total += b.length;
    while (total > MAX_OUTPUT_BYTES && arr.length > 1) {
      const dropped = arr.shift();
      if (dropped) total -= dropped.length;
    }
  };

  proc.stdout?.on("data", (d: Buffer) => pushCapped(rec.stdout, d));
  proc.stderr?.on("data", (d: Buffer) => pushCapped(rec.stderr, d));

  const finished = new Promise<void>((resolve) => {
    proc.on("close", (code, signal) => {
      rec.done = true;
      rec.code = code;
      rec.signal = signal;
      rec.endedAt = Date.now();
      resolve();
    });
    proc.on("error", () => {
      rec.done = true;
      rec.endedAt = Date.now();
      resolve();
    });
  });
  rec.waitDone = finished;

  if (background) {
    return toJobResult(id, rec, maxOutputChars);
  }
  await finished;
  const result = toJobResult(undefined, rec, maxOutputChars);
  jobs.delete(id); // 前台任务结束即清理：返回的 jobId 为空，不可再查
  return result;
}

export const JobOutputInput = z.object({
  jobId: z.string(),
  maxOutputChars: z.number().int().min(1000).max(200000).default(20000),
});

export async function jobOutput(
  args: z.infer<typeof JobOutputInput>,
): Promise<JobResult> {
  const { jobId, maxOutputChars } = JobOutputInput.parse(args);
  const rec = jobs.get(jobId);
  if (!rec) throw new Error(`unknown job: ${jobId}`);
  return toJobResult(jobId, rec, maxOutputChars);
}

export const JobKillInput = z.object({ jobId: z.string() });

export async function jobKill(
  args: z.infer<typeof JobKillInput>,
): Promise<JobResult> {
  const { jobId } = JobKillInput.parse(args);
  const rec = jobs.get(jobId);
  if (!rec) throw new Error(`unknown job: ${jobId}`);
  rec.killed = true;
  // 杀整个进程组（shell + 它拉起的子进程），防止孤儿子进程攥着管道导致 close 不触发
  try {
    if (rec.proc.pid !== undefined && process.platform !== "win32") {
      process.kill(-rec.proc.pid, "SIGKILL");
    } else {
      rec.proc.kill("SIGKILL");
    }
  } catch {
    /* 进程已经退出了 */
  }
  // 不删除记录：kill 后仍可用 job_output 取已产出的输出（测试报告 P1）。
  // 等进程真正退出再返回快照，调用方 kill 后立即 job_output 能看到 done:true。
  await Promise.race([
    rec.waitDone,
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  return toJobResult(jobId, rec, 20000);
}

/** 可选：清理已完成的后台任务记录 */
export function jobCleanup(jobId: string): boolean {
  const rec = jobs.get(jobId);
  if (!rec || !rec.done) return false;
  return jobs.delete(jobId);
}
