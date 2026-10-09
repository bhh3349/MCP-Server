# MCP-Server 桌面版（Electron）

不依赖系统 WebView2：Electron 自带 Chromium，开箱即用。

## 原理

Electron 壳只负责窗口 + 安装包；真正的后端是 Node sidecar（与 Tauri 版共用同一份）：

```
Electron 窗口 (1440x900, 无边框, 自定义标题栏)
   └─► <resources>/node-bin/node.exe <resources>/sidecar/sidecar.cjs --dashboard
          └─► http://127.0.0.1:18789（控制中心 UI + /api）
```

窗口初始隐藏，主进程等 18789 端口可连接后再 `show()`，避免白屏。

## 构建（Windows）

前置：Node.js 20+（不需要 Rust，不需要 WebView2）。

```bash
npm install
npm run electron:build   # 先 build:sidecar，再 electron-builder --win
```

产物：`release-electron/MCP-Server_<版本>_x64-setup.exe`（当前用户安装，无需管理员）。

`build:sidecar` 把后端打成自包含单文件（与 Tauri 版共用 `scripts/build-sidecar.mjs`）：

```
src-tauri/sidecar/sidecar.cjs   # esbuild 单文件（含 ws/zod/SDK/ssh2 等全部运行时依赖）
src-tauri/sidecar/ui/           # 控制中心静态文件
src-tauri/sidecar/extensions/  # 插件 / 技能 / 连接器
```

这三者随 `electron-builder.yml → extraResources` 一起安装，
运行时主进程用安装包内的 `node-bin/node.exe` 拉起 `sidecar/sidecar.cjs --dashboard`。

## 开发调试

```bash
# 终端 1：起后端（dashboard + 本地信道）
npm run local-channel -- --dashboard

# 终端 2：起 Electron 壳（直连本机 18789，不拉 sidecar）
npm run electron:dev
```

## 窗口约束（与 Tauri 版一致）

- 1440x900，16:10 等比缩放（主进程 `resize` 事件里按宽度算高度）
- 无原生装饰栏，拖动靠 `#topbar`（`-webkit-app-region: drag`，仅 `html.tauri` 下启用，
  浏览器里打开 dashboard 不受影响）
- 右上最小化/最大化/关闭按钮走 `window.mcpWindow`（preload 桥，只暴露三个方法）
- UI 侧优先检测 `window.mcpWindow`（Electron），其次 `window.__TAURI__`（Tauri），
  最后是纯浏览器——三者互不干扰

## 与 Tauri 版的对应关系

| Tauri | Electron |
|---|---|
| `src-tauri/src/main.rs` | `src-electron/main.cjs` |
| `tauri.conf.json` 窗口/打包配置 | `electron-builder.yml` |
| Rust 拉起 sidecar | Node `child_process.spawn` 拉起 sidecar |
| `window.__TAURI__` | `window.mcpWindow`（preload） |
| `data-tauri-drag-region` | `-webkit-app-region: drag` |
| `src-tauri/target/.../nsis/*.exe` | `release-electron/*-setup.exe` |
| `.github/workflows/tauri-build.yml` | `.github/workflows/electron-build.yml` |
