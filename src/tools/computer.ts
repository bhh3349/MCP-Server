/**
 * computer_use: 鼠标键盘控制（桌面自动化）。
 *   mouse_move / mouse_click / mouse_drag / mouse_scroll
 *   key_type / key_press / hotkey
 *
 * Windows: PowerShell + user32.dll / SendKeys
 * macOS: cliclick（鼠标）/ AppleScript System Events（键盘）
 * Linux: xdotool
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const P = platform();

async function ps(script: string, timeout = 15000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout);
  } catch (e) {
    throw new Error(`computer-use-failed: ${(e as Error).message}`);
  }
}

async function sh(cmd: string, args: string[], timeout = 15000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout);
  } catch (e) {
    throw new Error(`computer-use-failed: ${(e as Error).message}`);
  }
}

// Windows user32 封装（复用，避免每次 Add-Type）
const WIN_MOUSE_CS = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MU {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int d,int e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct POINT { public int X; public int Y; }
}
"@;
`;

// ---------------------------------------------------------------- mouse_move

export const MouseMoveInput = z.object({
  x: z.number().int().min(0).describe("屏幕 X 坐标"),
  y: z.number().int().min(0).describe("屏幕 Y 坐标"),
});
export async function mouseMove(args: z.infer<typeof MouseMoveInput>) {
  const { x, y } = MouseMoveInput.parse(args);
  if (P === "win32") {
    await ps(`${WIN_MOUSE_CS}[MU]::SetCursorPos(${x}, ${y}) | Out-Null`);
  } else if (P === "darwin") {
    await sh("cliclick", [`m:${x},${y}`]);
  } else {
    await sh("xdotool", ["mousemove", String(x), String(y)]);
  }
  return { moved: true, x, y };
}

// ---------------------------------------------------------------- mouse_click

export const MouseClickInput = z.object({
  x: z.number().int().min(0).optional().describe("不传则在当前位置点"),
  y: z.number().int().min(0).optional(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  clicks: z.number().int().min(1).max(3).default(1).describe("连击次数（双击=2）"),
});
export async function mouseClick(args: z.infer<typeof MouseClickInput>) {
  const { x, y, button, clicks } = MouseClickInput.parse(args);
  const btn = { left: 0, right: 1, middle: 2 }[button];
  if (P === "win32") {
    let s = WIN_MOUSE_CS;
    if (x !== undefined && y !== undefined) s += `[MU]::SetCursorPos(${x}, ${y}) | Out-Null;`;
    // mouse_event flags: left down 0x2/up 0x4, right down 0x8/up 0x10, middle down 0x20/up 0x40
    const down = [0x2, 0x8, 0x20][btn], up = [0x4, 0x10, 0x40][btn];
    for (let i = 0; i < clicks; i++) {
      s += `[MU]::mouse_event(${down},0,0,0,0);[MU]::mouse_event(${up},0,0,0,0);`;
      if (i < clicks - 1) s += `Start-Sleep -Milliseconds 80;`;
    }
    await ps(s);
  } else if (P === "darwin") {
    const b = { left: "c", right: "rc", middle: "mc" }[button];
    const pos = x !== undefined && y !== undefined ? `${x},${y}` : ".";
    for (let i = 0; i < clicks; i++) await sh("cliclick", [`${b}:${pos}`]);
  } else {
    if (x !== undefined && y !== undefined) await sh("xdotool", ["mousemove", String(x), String(y)]);
    await sh("xdotool", ["click", "--repeat", String(clicks), String(btn + 1)]);
  }
  return { clicked: true, button, clicks, x, y };
}

// ---------------------------------------------------------------- mouse_drag

export const MouseDragInput = z.object({
  fromX: z.number().int().min(0),
  fromY: z.number().int().min(0),
  toX: z.number().int().min(0),
  toY: z.number().int().min(0),
  button: z.enum(["left", "right", "middle"]).default("left"),
});
export async function mouseDrag(args: z.infer<typeof MouseDragInput>) {
  const { fromX, fromY, toX, toY, button } = MouseDragInput.parse(args);
  if (P === "win32") {
    const down = [0x2, 0x8, 0x20][{ left: 0, right: 1, middle: 2 }[button]];
    const up = [0x4, 0x10, 0x40][{ left: 0, right: 1, middle: 2 }[button]];
    await ps(`${WIN_MOUSE_CS}[MU]::SetCursorPos(${fromX},${fromY})|Out-Null;` +
      `[MU]::mouse_event(${down},0,0,0,0);Start-Sleep -Milliseconds 60;` +
      `[MU]::SetCursorPos(${toX},${toY})|Out-Null;Start-Sleep -Milliseconds 60;` +
      `[MU]::mouse_event(${up},0,0,0,0);`);
  } else if (P === "darwin") {
    await sh("cliclick", [`dd:${fromX},${fromY}`, `du:${toX},${toY}`]);
  } else {
    await sh("xdotool", ["mousemove", String(fromX), String(fromY), "mousedown", String({ left: 1, right: 3, middle: 2 }[button]),
      "mousemove", String(toX), String(toY), "mouseup", String({ left: 1, right: 3, middle: 2 }[button])]);
  }
  return { dragged: true, fromX, fromY, toX, toY };
}

// ---------------------------------------------------------------- mouse_scroll

export const MouseScrollInput = z.object({
  x: z.number().int().min(0).optional().describe("滚动位置，不传则当前位置"),
  y: z.number().int().min(0).optional(),
  delta: z.number().int().describe("正数上滚 / 负数下滚（滚轮刻度）"),
});
export async function mouseScroll(args: z.infer<typeof MouseScrollInput>) {
  const { x, y, delta } = MouseScrollInput.parse(args);
  if (P === "win32") {
    let s = WIN_MOUSE_CS;
    if (x !== undefined && y !== undefined) s += `[MU]::SetCursorPos(${x},${y})|Out-Null;`;
    s += `[MU]::mouse_event(0x800,0,0,${delta * 120},0);`;
    await ps(s);
  } else if (P === "darwin") {
    const pos = x !== undefined && y !== undefined ? `${x},${y}` : ".";
    // cliclick kp "scroll-up"/"scroll-down" 无位置；用 AppleScript 滚轮
    await sh("osascript", ["-e",
      `tell application "System Events" to scroll ${delta > 0 ? "up" : "down"} ${Math.abs(delta)}`]);
    void pos;
  } else {
    if (x !== undefined && y !== undefined) await sh("xdotool", ["mousemove", String(x), String(y)]);
    await sh("xdotool", ["click", delta > 0 ? "4" : "5"]);
  }
  return { scrolled: true, delta };
}

// ---------------------------------------------------------------- key_type

export const KeyTypeInput = z.object({
  text: z.string().min(1).describe("要输入的文本"),
});
export async function keyType(args: z.infer<typeof KeyTypeInput>) {
  const { text } = KeyTypeInput.parse(args);
  if (P === "win32") {
    // SendKeys 特殊字符转义
    const esc = text.replace(/([+^%~(){}[\]])/g, "{$1}");
    await ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${esc.replace(/'/g, "''")}')`);
  } else if (P === "darwin") {
    const esc = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await sh("osascript", ["-e", `tell application "System Events" to keystroke "${esc}"`]);
  } else {
    await sh("xdotool", ["type", "--", text]);
  }
  return { typed: true, chars: text.length };
}

// ---------------------------------------------------------------- key_press

export const KeyPressInput = z.object({
  key: z.string().describe("键名：enter/tab/esc/space/up/down/left/right/delete/backspace/f1..f12 等，或单个字符"),
});
const KEY_ALIASES: Record<string, string> = {
  enter: "Return", return: "Return", tab: "Tab", esc: "Escape", escape: "Escape",
  space: "space", up: "Up", down: "Down", left: "Left", right: "Right",
  delete: "Delete", backspace: "BackSpace", home: "Home", end: "End",
  pageup: "Page_Up", pagedown: "Page_Down", insert: "Insert",
};
export async function keyPress(args: z.infer<typeof KeyPressInput>) {
  const { key } = KeyPressInput.parse(args);
  const k = key.toLowerCase();
  if (P === "win32") {
    const map: Record<string, string> = {
      enter: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}", space: " ",
      up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
      delete: "{DELETE}", backspace: "{BACKSPACE}", home: "{HOME}", end: "{END}",
      pageup: "{PGUP}", pagedown: "{PGDN}", insert: "{INSERT}",
    };
    let sk: string;
    if (map[k]) sk = map[k];
    else if (/^f\d{1,2}$/.test(k)) sk = `{${k.toUpperCase()}}`;
    else if (k.length === 1) sk = k.replace(/([+^%~(){}[\]])/g, "{$1}");
    else throw new Error(`unknown key: ${key}`);
    await ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${sk.replace(/'/g, "''")}')`);
  } else if (P === "darwin") {
    const code = KEY_ALIASES[k] ?? (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : null);
    if (code) {
      // key code 方式
      const keyCodes: Record<string, number> = {
        Return: 36, Tab: 48, Escape: 53, space: 49, Up: 126, Down: 125, Left: 123, Right: 124,
        Delete: 51, BackSpace: 51, Home: 115, End: 119, Page_Up: 116, Page_Down: 121, Insert: 114,
        F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
      };
      const kc = keyCodes[code];
      if (kc === undefined) throw new Error(`unknown key: ${key}`);
      await sh("osascript", ["-e", `tell application "System Events" to key code ${kc}`]);
    } else if (k.length === 1) {
      await sh("osascript", ["-e", `tell application "System Events" to keystroke "${k}"`]);
    } else throw new Error(`unknown key: ${key}`);
  } else {
    const kk = KEY_ALIASES[k] ?? k;
    await sh("xdotool", ["key", kk]);
  }
  return { pressed: true, key };
}

// ---------------------------------------------------------------- hotkey

export const HotkeyInput = z.object({
  keys: z.string().describe("组合键，如 ctrl+c / ctrl+shift+s / alt+f4（用 + 连接）"),
});
export async function hotkey(args: z.infer<typeof HotkeyInput>) {
  const { keys } = HotkeyInput.parse(args);
  const parts = keys.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error("hotkey needs 2+ keys joined by +, e.g. ctrl+c");
  if (P === "win32") {
    const mod: Record<string, string> = { ctrl: "^", alt: "%", shift: "+", win: "#" };
    const last = parts[parts.length - 1] ?? "";
    const mods = parts.slice(0, -1).map((m) => {
      if (!mod[m]) throw new Error(`unknown modifier: ${m}`);
      return mod[m];
    }).join("");
    const keyMap: Record<string, string> = {
      enter: "{ENTER}", tab: "{TAB}", esc: "{ESC}", space: " ", delete: "{DELETE}",
      up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
    };
    const kl = keyMap[last] ?? (/^f\d{1,2}$/.test(last) ? `{${last.toUpperCase()}}` : last.length === 1 ? last : null);
    if (!kl) throw new Error(`unknown key: ${last}`);
    await ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${(mods + kl).replace(/'/g, "''")}')`);
  } else if (P === "darwin") {
    const mods = parts.slice(0, -1).map((m) => {
      if (m === "ctrl" || m === "control") return "control down";
      if (m === "alt" || m === "option") return "option down";
      if (m === "shift") return "shift down";
      if (m === "cmd" || m === "win" || m === "command") return "command down";
      throw new Error(`unknown modifier: ${m}`);
    });
    const last = parts[parts.length - 1];
    await sh("osascript", ["-e",
      `tell application "System Events" to keystroke "${last}" using {${mods.join(", ")}}`]);
  } else {
    await sh("xdotool", ["key", parts.join("+")]);
  }
  return { pressed: true, keys };
}
