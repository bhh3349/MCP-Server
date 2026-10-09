/**
 * Electron 开发启动器（零依赖，不用 cross-env）。
 *
 * 用法：
 *   终端 1：npm run local-channel -- --dashboard   # 或 npm run dashboard
 *   终端 2：npm run electron:dev                    # 本脚本：直连本机 dashboard，不拉 sidecar
 *
 * Windows 上 `ELECTRON_DEV=1 electron ...` 的内联写法在 cmd/pwsh 下不可用，
 * 所以用 Node 先置环境变量再 spawn electron，保证跨平台一致。
 */
import { spawn } from "node:child_process";

const child = spawn("npx", ["electron", "src-electron/main.cjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ELECTRON_DEV: "1" },
});

child.on("exit", (code) => process.exit(code ?? 0));
