/**
 * Dashboard 入口：本地控制中心。
 *
 *   npm run dashboard
 *
 * 启动 127.0.0.1 上的 HTTP 服务：/api/* + 控制中心 UI。
 * 只绑本地回环，不对外暴露。
 */
import { startDashboard } from "./api.js";

const port = process.env["DASHBOARD_PORT"] ? parseInt(process.env["DASHBOARD_PORT"], 10) : undefined;

startDashboard({ ...(port ? { port } : {}) })
  .then(({ url }) => {
    console.log(`MCP-Server 控制中心: ${url}`);
    console.log("按 Ctrl+C 退出");
  })
  .catch((e) => {
    console.error("dashboard 启动失败:", e);
    process.exit(1);
  });
