# node-bin（可选）

把各平台的 portable Node.js 可执行文件放进这个目录，打包时会随安装包分发
（tauri.conf.json → bundle.resources → `node-bin/*`），运行时 Tauri 后端会
优先使用这里的 node，而不是要求用户机器上装 Node。

- Windows: `node.exe`（+ 同目录的 `node.dll` 等依赖也一并放入）
- macOS: `node`（darwin arm64 / x64 按目标平台）
- Linux: `node`（对应架构）

下载地址：https://nodejs.org/dist/（选 "Windows Binary (.zip)" 等 portable 包）

不放也可以：此时按 `MCP_NODE` 环境变量 → `PATH` 上的 `node` 顺序查找。
