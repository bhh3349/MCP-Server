# 变更记录（Claude Code）

- 日期：2026-10-05
- 作者：Claude Code
- 范围：桌面安装包打包修复、版本号、UI 图标、日志可诊断性

> **规则：每次修改项目文件后，在此文档追加一条记录（最新在上）。**
> 记录格式：日期 · 版本 · 改了什么 · 涉及文件 · 验证方式。

---

## 2026-10-05

### 文档归档位置调整（Claude Code）
- 记录文档由根目录 `CHANGELOG.md` 迁至 `docs/fix-reports/2026-10-05-packaging-fixes-claude-code.md`，
  与 fix-reports 现有约定一致，文件名含 AI 名（`<日期>-<主题>-<AI名>.md`）。
- 涉及：`docs/fix-reports/`

### 信道稳定性修复（muse）
- **Bridge 半开连接检测**：2 个心跳周期无任何消息（含 pong）即判定连接已死，`emit("stale")`
  并 `terminate()` 触发重连，避免 TCP 半开导致信道假活。
- **本地信道空闲会话回收**：`activeSessions` 由 `Set` 改为 `Map<id, ts>` 记录活跃时间；
  每 5 分钟扫描、30 分钟无活动自动回收，防止客户端崩溃未发 `DELETE` 导致信道永久锁死；
  `stop()` 清理 GC 定时器。
- 涉及：`src/bridge/pipe.ts`、`src/local/channel-server.ts`
- 验证：`tsc --noEmit` 通过；`activeSessions` 全部用法（size/set/delete/has/迭代）Map 兼容。
- 提交：本次提交

### v0.1.2 · 安装版崩溃可诊断 + agent 兜底
- **日志**：sidecar 的 stdout/stderr 此前被 `Stdio::null()` 丢弃，崩溃无迹可查。改为写入
  `%TEMP%\mcp-server-sidecar.log`；新增 Rust panic hook 写日志；sidecar 提前退出时记录退出状态。
- **agent**：模型只输出纯工具名（如 `channels`）时的兜底解析。
- 涉及：`src-tauri/src/main.rs`、`src/dashboard/agent.ts`
- 验证：`cargo check` + `tsc --noEmit` 通过；安装版运行后两个日志文件均正常产出。
- 提交：`907cf5d`

### v0.1.2 · 修复 UI 图标不显示
- **根因**：`src/dashboard/ui/` 下需要浏览器加载的图片存的是 **base64 文本**（头字节 `iVBO`），
  浏览器解码失败 → 破图标。
- 解码回二进制共 10 个文件：`icons/logo-32.png`、`icons/logo-128.png`、`favicon.ico`，
  以及 `vendor/providers/{anthropic,deepseek,doubao,moonshot,openai,tongyi,zhipuai}.png`。
- 验证：HTTP 返回 `Content-Type: image/png`、头字节 `89 50 4e 47`；安装版实测正常。
- 提交：`c3a23e0`

### v0.1.2 · 版本统一 + 打包修复 + 等比缩放
- 版本统一到 **0.1.2**：`package.json`、`src/version.ts`、`src-tauri/Cargo.toml`、
  `src-tauri/tauri.conf.json`、`src/dashboard/ui/index.html`、`app.js`。
- **打包修复**（安装后启动失败）：`main.rs` 加 `windows_subsystem="windows"` 去掉控制台黑窗；
  Rust 端解析 `resources/sidecar/sidecar.cjs` 并注入 `MCP_UI_DIR`/`MCP_EXTENSIONS_DIR`；
  `tauri.conf.json` resources 改为 `["node-bin","sidecar"]` + `beforeBuildCommand`。
- **编译修复**：`on_window_event` 里 `tauri::dpi::PhysicalSize` → `tauri::PhysicalSize`。
- 涉及：`src-tauri/src/main.rs`、`src-tauri/tauri.conf.json`、`src/dashboard/api.ts`（`uiDir`）、
  `scripts/build-sidecar.mjs`、`.gitignore`
- 提交：`c102780`

### v0.1.1 · 打包后无法启动（初次修复）
- **根因**：① release 版是控制台程序（弹终端）；② `resources: ["../dist"]` 打包后被 Tauri
  重命名为 `_up_/dist`，Rust 找不到 `cli.js`；③ `dist/` 不含 `node_modules`，即便找到也会
  因缺依赖崩溃。
- **方案**：用 esbuild 把后端打成自包含单文件 `src-tauri/sidecar/sidecar.cjs`（含全部运行时依赖），
  并复制 `ui/`、`extensions/`、扩展依赖 `node_modules/zod`。
- 新增：`scripts/build-sidecar.mjs`、`package.json` → `build:sidecar`
- 验证：真实安装 → 运行 → 卸载；工具 33 项、扩展 5 个、UI 200、无控制台窗口。
- 提交：`c102780`（c102780 为 v0.1.2 一并提交）

---

## 归档说明
- 构建产物不入库：`src-tauri/target/`、`src-tauri/gen/`、`src-tauri/sidecar/`、`dist/`、`release/`、`node_modules/`
- 安装包：`src-tauri/target/release/bundle/nsis/MCP-Server_<版本>_x64-setup.exe`
