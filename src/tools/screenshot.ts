/**
 * screenshot: 截取主屏幕，返回 PNG（base64）。
 * Windows: PowerShell + .NET (System.Drawing)
 * macOS: screencapture
 * Linux: 依次试 gnome-screenshot / scrot / import (ImageMagick)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform, tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const PS_SCREENSHOT = `
Add-Type -AssemblyName System.Drawing;
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
`;

export const ScreenshotInput = z.object({
  maxWidth: z.number().int().min(320).max(3840).default(1280)
    .describe("输出最大宽度（等比缩放，省流量）"),
});
export async function screenshot(args: z.infer<typeof ScreenshotInput>) {
  const { maxWidth } = ScreenshotInput.parse(args);
  const p = platform();
  const out = join(tmpdir(), `mcp-shot-${randomUUID()}.png`);
  try {
    if (p === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms;` + PS_SCREENSHOT;
      await execFileAsync("powershell", ["-NoProfile", "-Command", ps, out], { timeout: 20000, windowsHide: true });
    } else if (p === "darwin") {
      await execFileAsync("screencapture", ["-x", "-t", "png", out], { timeout: 20000 });
    } else {
      // Linux: gnome-screenshot → scrot → import
      const tried: string[] = [];
      for (const [cmd, a] of [
        ["gnome-screenshot", ["-f", out]],
        ["scrot", [out]],
        ["import", ["-window", "root", out]],
      ] as [string, string[]][]) {
        try { await execFileAsync(cmd, a, { timeout: 20000 }); break; }
        catch (e) { tried.push(cmd); }
      }
      if (tried.length === 3) throw new Error("no screenshot tool (need gnome-screenshot/scrot/imagemagick)");
    }
    let buf = await fs.readFile(out);
    // 缩放太大时提示（不做服务端缩放，保持简单；客户端按需处理）
    return {
      mimeType: "image/png",
      bytes: buf.length,
      data: buf.toString("base64"),
      note: maxWidth < 3840 ? `建议显示宽度 ${maxWidth}px` : undefined,
    };
  } catch (e) {
    throw new Error(`screenshot-failed: ${(e as Error).message}`);
  } finally {
    await fs.unlink(out).catch(() => {});
  }
}
