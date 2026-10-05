# MCP-Server 桌面版（Tauri）

## 原理

Tauri 壳只负责窗口 + 安装包；真正的后端是 Node sidecar：

```
Tauri 窗口 (1440x900, 无边框, 自定义标题栏)
   └─► node <resources>/dist/local/cli.js --dashboard
          └─► http://127.0.0.1:18789（控制中心 UI + /api）
```

窗口初始隐藏，Rust 后端等 18789 端口可连接后再 `show()`，避免白屏。

## 构建（Windows）

前置：Rust 工具链（rustup）、Node.js 20+、WebView2（Win10/11 自带）。

```bash
npm install
npm run tauri:build    # 生成安装包：src-tauri/target/release/bundle/nsis/
```

产物：`MCP-Server_0.1.0_x64-setup.exe`（当前用户安装，无需管理员）。

`tauri:build` 会先跑 `npm run build:sidecar`，把后端打成一个自包含文件：

```
src-tauri/sidecar/sidecar.cjs   # esbuild 单文件（含 ws/zod/SDK/ssh2 等全部运行时依赖）
src-tauri/sidecar/ui/           # 控制中心静态文件
src-tauri/sidecar/extensions/   # 插件 / 技能 / 连接器
```

这三者随 `bundle.resources` 一起安装，运行时 Rust 后端用安装包内的
`node-bin/node.exe` 拉起 `sidecar/sidecar.cjs --dashboard`。
**注意**：不能再让 sidecar 依赖 `dist/`——tsc 产物不含 `node_modules`，
装到用户机器上会因找不到模块立即崩溃。

`npm run tauri:dev` 用于开发调试（用项目根 dist/ 直跑）。

## 窗口约束（Bo 要求）

- 固定 1440x900，不可调整、不可最大化（tauri.conf.json 已锁死）
- 无原生装饰栏，拖动靠 `#topbar[data-tauri-drag-region]`，
  右上最小化/关闭按钮走 `window.__TAURI__`（`html.tauri` 下可见）

## 自包含安装包（可选）

默认安装包不带 Node，目标机器需自行安装 Node.js。
要做成完全免依赖的安装包：把 portable node 按 `node-bin/README.md`
放入 `src-tauri/node-bin/` 再打包。
