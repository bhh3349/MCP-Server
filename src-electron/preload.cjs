/**
 * Electron preload：给 UI 暴露最小窗口控制 API（替代 Tauri 的 window.__TAURI__）。
 * contextIsolation 开启，UI 只能拿到这三个方法，拿不到 node / ipc 全权。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mcpWindow", {
  minimize: () => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),
  close: () => ipcRenderer.invoke("win:close"),
});
