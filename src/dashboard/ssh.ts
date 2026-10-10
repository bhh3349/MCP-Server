import { Client } from "ssh2";
import { randomUUID } from "node:crypto";

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

function connectCfg(cfg: SshConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
    readyTimeout: 15000,
    // 首次连接自动接受 host key（内网/自有服务器场景）
    hostVerifier: () => true,
  } as const;
}

// ---------- 后台 SSH 任务（部署用） ----------

export interface SshJob {
  id: string;
  done: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

const jobs = new Map<string, SshJob>();
const MAX_OUT = 200000;

export function sshRunJob(cfg: SshConfig, command: string): string {
  const id = randomUUID();
  const job: SshJob = { id, done: false, stdout: "", stderr: "", exitCode: null };
  jobs.set(id, job);
  if (jobs.size > 20) {
    const oldest = jobs.keys().next().value;
    if (oldest) jobs.delete(oldest);
  }
  const conn = new Client();
  const fail = (msg: string) => {
    if (job.done) return;
    job.done = true;
    job.error = msg;
    try { conn.end(); } catch { /* ignore */ }
  };
  conn
    .on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return fail(`exec 失败: ${err.message}`);
        stream.on("data", (d: Buffer) => {
          job.stdout += d.toString();
          if (job.stdout.length > MAX_OUT) job.stdout = job.stdout.slice(-MAX_OUT);
        });
        stream.stderr.on("data", (d: Buffer) => {
          job.stderr += d.toString();
          if (job.stderr.length > MAX_OUT) job.stderr = job.stderr.slice(-MAX_OUT);
        });
        stream.on("close", (code: number) => {
          job.done = true;
          job.exitCode = code;
          conn.end();
        });
        // ssh2 Channel 无 'error' 监听会直接 throw 打崩进程
        stream.on("error", (e: Error) => fail(`SSH 通道错误: ${e.message}`));
      });
    })
    .on("error", (err) => fail(`SSH 连接失败: ${err.message}`))
    .connect(connectCfg(cfg));
  // 整体超时保护（部署脚本较长，给 10 分钟）
  setTimeout(() => fail("SSH 任务超时（10 分钟）"), 10 * 60 * 1000).unref();
  return id;
}

export function sshGetJob(id: string): SshJob | undefined {
  return jobs.get(id);
}

// ---------- 交互式 shell（终端用） ----------

export function sshShell(
  cfg: SshConfig,
  opts: { cols: number; rows: number },
  onStream: (stream: import("ssh2").ClientChannel) => void,
  onError: (message: string) => void,
): Client {
  const conn = new Client();
  conn
    .on("ready", () => {
      conn.shell({ term: "xterm-256color", cols: opts.cols, rows: opts.rows }, (err, stream) => {
        if (err) {
          onError(`shell 打开失败: ${err.message}`);
          conn.end();
          return;
        }
        onStream(stream);
      });
    })
    .on("error", (err) => onError(`SSH 连接失败: ${err.message}`))
    .connect(connectCfg(cfg));
  return conn;
}
