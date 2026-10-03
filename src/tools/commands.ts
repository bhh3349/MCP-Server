/**
 * Command execution: run shell commands with timeout, streaming output.
 * Long-running commands can be backgrounded and polled.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";

const jobs = new Map<string, { proc: ChildProcess; output: string; done: boolean; code: number | null }>();
let seq = 0;

export const ExecInput = z.object({
  command: z.string().describe("Shell command to run"),
  cwd: z.string().optional().describe("Working directory"),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
  background: z.boolean().default(false).describe("Return immediately with a job id"),
});
export async function exec({ command, cwd, timeoutMs, background }: z.infer<typeof ExecInput>) {
  const id = `job-${++seq}-${Date.now().toString(36)}`;
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
  const proc = spawn(shell, shellArgs, { cwd, timeout: background ? 0 : timeoutMs });
  const rec = { proc, output: "", done: false, code: null as number | null };
  jobs.set(id, rec);
  proc.stdout?.on("data", (d) => { rec.output += d.toString(); });
  proc.stderr?.on("data", (d) => { rec.output += d.toString(); });
  const finished = new Promise<void>((resolve) => {
    proc.on("close", (code) => { rec.done = true; rec.code = code; resolve(); });
    proc.on("error", () => { rec.done = true; resolve(); });
  });
  if (background) {
    return { jobId: id, status: "running" as const };
  }
  await finished;
  jobs.delete(id);
  return { output: rec.output.slice(-8000), exitCode: rec.code };
}

export const JobOutputInput = z.object({
  jobId: z.string(),
});
export async function jobOutput({ jobId }: z.infer<typeof JobOutputInput>) {
  const rec = jobs.get(jobId);
  if (!rec) throw new Error(`unknown job: ${jobId}`);
  return {
    jobId,
    done: rec.done,
    exitCode: rec.code,
    output: rec.output.slice(-8000),
  };
}

export const JobKillInput = z.object({ jobId: z.string() });
export async function jobKill({ jobId }: z.infer<typeof JobKillInput>) {
  const rec = jobs.get(jobId);
  if (!rec) throw new Error(`unknown job: ${jobId}`);
  rec.proc.kill("SIGKILL");
  jobs.delete(jobId);
  return { jobId, killed: true };
}
