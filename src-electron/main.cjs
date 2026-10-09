/**
 * MCP-Server Electron 主进程（替代 Tauri 的 main.rs）。
 *
 * 启动流程（与 Tauri 版一一对应）：
 * 1. 用安装包内 node（node-bin/）或 MCP_NODE / PATH 上的 node，
 *    拉起 sidecar：`node sidecar/sidecar.cjs --dashboard`
 * 2. 轮询 127.0.0.1:18789（DASHBOARD_PORT）直到端口可连接
 * 3. 显示主窗口（初始 hidden，避免白屏/连接失败闪屏）
 * 4. 进程退出时回收 sidecar。
 *
 * 打包布局（electron-builder extraResources）：
 *   resources/
 *     sidecar/sidecar.cjs   # esbuild 单文件，自带全部运行时依赖
 *     sidecar/ui/           # 控制中心静态文件
 *     sidecar/extensions/   # 插件 / 技能 / 连接器
 *     node-bin/node.exe     # portable node（Windows）
 *
 * 开发模式：ELECTRON_DEV=1 时直接连本机已有 dashboard（npm run local-channel -- --dashboard），
 * 不拉 sidecar。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DASHBOARD_PORT = Number.parseInt(process.env.DASHBOARD_PORT || "18789", 10);
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 400;

let sidecarProc = null;
let mainWindow = null;

function logFile(msg) {
  try {
    const p = path.join(os.tmpdir(), "mcp-server-electron.log");
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(p, line, "utf-8");
  } catch { /* ignore */ }
}

function log(msg) {
  console.log(`[electron] ${msg}`);
  logFile(msg);
}

/** 应用资源根目录：打包后是 process.resourcesPath，开发时是项目根 */
function resourceDir() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "..");
}

/** sidecar 脚本位置：打包版 resources/sidecar/sidecar.cjs；开发版 src-tauri/sidecar 或直接用 tsx */
function resolveSidecar() {
  const base = resourceDir();
  // 1. 打包版
  const bundled = path.join(base, "sidecar", "sidecar.cjs");
  if (fs.existsSync(bundled)) return { script: bundled, workdir: path.dirname(bundled) };
  // 2. 开发版：刚跑完 npm run build:sidecar 的 src-tauri/sidecar/
  const devSidecar = path.join(base, "src-tauri", "sidecar", "sidecar.cjs");
  if (fs.existsSync(devSidecar)) return { script: devSidecar, workdir: path.dirname(devSidecar) };
  return null;
}

/** Node 查找顺序：MCP_NODE > 安装包内 node-bin/ > PATH 上的 node（与 Tauri 版一致） */
function resolveNode() {
  if (process.env.MCP_NODE && fs.existsSync(process.env.MCP_NODE)) return process.env.MCP_NODE;
  const base = resourceDir();
  const bundled = process.platform === "win32"
    ? path.join(base, "node-bin", "node.exe")
    : path.join(base, "node-bin", "node");
  if (fs.existsSync(bundled)) return bundled;
  // 开发模式：仓库内 portable node 在 src-tauri/node-bin/（打包时才搬运到 resources/node-bin/）
  if (!app.isPackaged) {
    const devBundled = process.platform === "win32"
      ? path.join(base, "src-tauri", "node-bin", "node.exe")
      : path.join(base, "src-tauri", "node-bin", "node");
    if (fs.existsSync(devBundled)) return devBundled;
  }
  return "node";
}

function spawnSidecar() {
  if (process.env.ELECTRON_DEV === "1") {
    log("ELECTRON_DEV=1：跳过 sidecar，直连本机 dashboard");
    return true;
  }
  const target = resolveSidecar();
  if (!target) {
    log("ERROR: 找不到 sidecar.cjs（先跑 npm run build:sidecar）");
    return false;
  }
  const node = resolveNode();
  log(`node: ${node}`);
  log(`cli:  ${target.script}`);
  log(`cwd:  ${target.workdir}`);

  const sidecarLog = path.join(os.tmpdir(), "mcp-server-sidecar.log");
  let outFd = null;
  try {
    outFd = fs.openSync(sidecarLog, "a");
  } catch { /* ignore */ }

  const child = spawn(node, [target.script, "--dashboard"], {
    cwd: target.workdir,
    stdio: outFd !== null ? ["ignore", outFd, outFd] : ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      DASHBOARD_PORT: String(DASHBOARD_PORT),
      MCP_UI_DIR: path.join(target.workdir, "ui"),
      MCP_EXTENSIONS_DIR: path.join(target.workdir, "extensions"),
    },
    windowsHide: true,
  });
  child.on("error", (e) => log(`sidecar 启动失败: ${e.message}`));
  child.on("exit", (code, signal) => log(`sidecar 已退出: code=${code} signal=${signal}`));
  sidecarProc = child;
  log(`sidecar pid=${child.pid}`);
  return true;
}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(DASHBOARD_PORT, "127.0.0.1");
    s.once("connect", () => { s.end(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

async function waitReady() {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await portOpen()) return true;
    if (sidecarProc && sidecarProc.exitCode !== null) {
      log(`sidecar 已退出（code=${sidecarProc.exitCode}），停止等待`);
      return false;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  log("等待 dashboard 超时");
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    maxWidth: 2160,
    maxHeight: 1350,
    center: true,
    title: "MCP-Server",
    // 对齐 Tauri 版：无原生装饰栏，拖动靠 #topbar[data-tauri-drag-region]
    frame: false,
    show: false, // 就绪后再 show，避免白屏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}`);

  // 等比缩放 16:10：按宽度算高度（与 Tauri 版 on_window_event 对齐）
  let resizing = false;
  mainWindow.on("resize", () => {
    if (resizing) return;
    try {
      const [w, h] = mainWindow.getSize();
      const want = Math.round(w / (1440 / 900));
      if (Math.abs(h - want) > 2) {
        resizing = true;
        mainWindow.setSize(w, want);
        resizing = false;
      }
    } catch { /* ignore */ }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// preload 桥：窗口控制（替代 Tauri 的 window.__TAURI__）
ipcMain.handle("win:minimize", () => mainWindow?.minimize());
ipcMain.handle("win:toggleMaximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("win:close", () => mainWindow?.close());

function killSidecar() {
  if (sidecarProc && sidecarProc.exitCode === null) {
    log(`回收 sidecar pid=${sidecarProc.pid}`);
    try { sidecarProc.kill(); } catch { /* ignore */ }
  }
  sidecarProc = null;
}

app.whenReady().then(async () => {
  const ok = spawnSidecar();
  createWindow();
  if (ok) await waitReady();
  // 无论 sidecar 是否就绪都显示窗口（由前端提示错误），与 Tauri 版一致
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  killSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => killSidecar());
