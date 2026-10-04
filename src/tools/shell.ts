import { existsSync } from "node:fs";

/**
 * Windows 上只用 Git Bash，不用 PowerShell。
 * 按以下顺序找 bash.exe（结果缓存）：
 *   C:\Program Files\Git\bin\bash.exe
 *   C:\Program Files (x86)\Git\bin\bash.exe
 * 找不到时抛错（不静默回退 PowerShell）。
 */

let cached: string | null | undefined;

export function findGitBash(): string | null {
  if (cached !== undefined) return cached;
  const pf = process.env["ProgramFiles"];
  const pf86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    pf ? `${pf}\\Git\\bin\\bash.exe` : "",
    pf86 ? `${pf86}\\Git\\bin\\bash.exe` : "",
  ].filter(Boolean);
  cached = candidates.find((c) => { try { return existsSync(c); } catch { return false; } }) ?? null;
  return cached;
}

/** 解析当前平台要用的 shell；Windows 上找不到 Git Bash 直接抛错 */
export function resolveShell(): { shell: string; args: (command: string) => string[] } {
  if (process.platform === "win32") {
    const bash = findGitBash();
    if (!bash) {
      throw new Error("未找到 Git Bash，请安装 Git for Windows（https://git-scm.com/downloads）后再试");
    }
    return { shell: bash, args: (command: string) => ["-c", command] };
  }
  return { shell: "/bin/sh", args: (command: string) => ["-c", command] };
}
