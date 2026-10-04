/**
 * clipboard_read / clipboard_write: 跨平台剪贴板。
 * Windows: PowerShell Get-Clipboard / Set-Clipboard
 * macOS: pbpaste / pbcopy
 * Linux: xclip / xsel（需安装，缺失时报错提示）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { z } from "zod";

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[], input?: string): Promise<string> {
  try {
    const opts: any = {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
      windowsHide: true,
    };
    if (input !== undefined) opts.input = input;
    const { stdout } = await execFileAsync(cmd, args, opts);
    return String(stdout);
  } catch (e) {
    throw new Error(`clipboard-failed: ${(e as Error).message}`);
  }
}

export const ClipboardReadInput = z.object({});
export async function clipboardRead(_args: z.infer<typeof ClipboardReadInput>) {
  const p = platform();
  let text: string;
  if (p === "win32") {
    text = await run("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]);
  } else if (p === "darwin") {
    text = await run("pbpaste", []);
  } else {
    // Linux: 依次试 xclip / xsel
    try {
      text = await run("xclip", ["-selection", "clipboard", "-o"]);
    } catch {
      text = await run("xsel", ["--clipboard", "--output"]);
    }
  }
  return { text, chars: text.length };
}

export const ClipboardWriteInput = z.object({
  text: z.string().describe("写入剪贴板的文本"),
});
export async function clipboardWrite(args: z.infer<typeof ClipboardWriteInput>) {
  const { text } = ClipboardWriteInput.parse(args);
  const p = platform();
  if (p === "win32") {
    await run("powershell", ["-NoProfile", "-Command", "Set-Clipboard"], text);
  } else if (p === "darwin") {
    await run("pbcopy", [], text);
  } else {
    try {
      await run("xclip", ["-selection", "clipboard"], text);
    } catch {
      await run("xsel", ["--clipboard", "--input"], text);
    }
  }
  return { written: true, chars: text.length };
}
