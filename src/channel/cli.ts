/**
 * 网关信道管理 CLI（交互式）。
 *
 *   npm run channel
 *
 * 手动输入网关连接信息，建立信道、拿配对码。
 * 网关配置保存在 ~/.mcp-server/gateways.json，下次直接回车用上次的。
 * 也支持环境变量：GATEWAY_URL、GATEWAY_TOKEN。
 */
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { Bridge } from "../bridge/pipe.js";
import { ChannelManager } from "./manager.js";
import { buildServer } from "../server.js";
import { ToolStats } from "../dashboard/stats.js";
import { logStore } from "../dashboard/logger.js";
import { installCrashHandler } from "../dashboard/crashlog.js";
import { startDashboard } from "../dashboard/api.js";

// 崩溃留痕（交互式 CLI 也装：配对调试时崩了同样要留现场）
installCrashHandler("channel");

const CONFIG_PATH = join(homedir(), ".mcp-server", "gateways.json");

interface SavedGateway {
  url: string;
  token: string;
  lastUsed: number;
}

function loadConfig(): SavedGateway[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveConfig(gateways: SavedGateway[]) {
  mkdirSync(join(homedir(), ".mcp-server"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(gateways, null, 2));
}

function upsertGateway(url: string, token: string) {
  const list = loadConfig().filter((g) => g.url !== url);
  list.unshift({ url, token, lastUsed: Date.now() });
  saveConfig(list.slice(0, 10)); // 最多记 10 个
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function main() {
  console.log("");
  console.log("  MCP 信道管理");
  console.log("  ─────────────────────────────");

  // ---- 步骤0：网关连接信息（支持粘贴 mcp-gw://token@host:port 一键导入） ----
  const saved = loadConfig();
  const lastUsed = saved[0];

  const defaultUrl = process.env["GATEWAY_URL"] || lastUsed?.url || "";
  const urlInput = await ask(`  网关地址${defaultUrl ? ` [${defaultUrl}]` : ""}\n  （或直接粘贴 mcp-gw://token@host:port）: `);
  let gatewayUrl = urlInput || defaultUrl;
  let pastedToken = "";
  // 解析一键连接串 mcp-gw://<token>@<host>:<port>
  const m = gatewayUrl.match(/^mcp-gw:\/\/([^@]+)@(.+)$/);
  if (m && m[1] && m[2]) {
    pastedToken = m[1];
    let host: string = m[2];
    if (!/^wss?:\/\//.test(host)) host = `ws://${host}`;
    gatewayUrl = host;
    console.log(`  已从连接串解析网关地址`);
  }
  if (!gatewayUrl) {
    console.log("  未输入网关地址，退出");
    rl.close();
    return;
  }

  const savedToken = saved.find((g) => g.url === gatewayUrl)?.token;
  const defaultToken = process.env["GATEWAY_TOKEN"] || pastedToken || savedToken || "";
  const tokenInput = await ask(
    `  Token${defaultToken ? ` [${defaultToken.slice(0, 8)}…已保存，直接回车使用]` : ""}: `,
  );
  const token = tokenInput || defaultToken;
  if (!token) {
    console.log("  未输入 token，退出");
    rl.close();
    return;
  }
  upsertGateway(gatewayUrl, token);

  // ---- 建 ChannelManager（Bridge 在 establish 时自动打开） ----
  // dashboard 与信道内嵌 server 共享同一份工具调用统计
  const stats = new ToolStats();
  logStore.install();
  const mgr = new ChannelManager(
    new Bridge({ gatewayUrl: "", autoReconnect: false }),
    async () => (await buildServer({ stats, withChannels: false })).server,
  );

  if (process.argv.includes("--dashboard")) {
    const { extensions } = await buildServer({ stats });
    const { url } = await startDashboard({ manager: mgr, stats, extensions });
    console.log(`  控制中心: ${url}`);
  }

  console.log("  正在连接网关…");
  // 先建一条测试信道验证连通性？不，直接进菜单，create 时会连

  // ---- 菜单循环 ----
  for (;;) {
    console.log("");
    console.log("  ─────────────────────────────");
    console.log("  1. 建立信道（拿配对码）");
    console.log("  2. 信道列表");
    console.log("  3. 换发配对码");
    console.log("  4. 关闭信道");
    console.log("  5. 退出");
    const choice = await ask("  选择 > ");

    try {
      if (choice === "1") {
        const name = (await ask("  信道名称 [channel]: ")) || "channel";
        console.log("  正在建立信道…");
        const r = await mgr.establish({ gatewayUrl, token, name });
        console.log("");
        console.log("  ✓ 信道已建立");
        console.log("  ─────────────────────────────");
        console.log(`  AI 接入地址: ${r.mcpUrl}`);
        console.log(`  配对码: ${r.pairingCode}`);
        console.log("  ─────────────────────────────");
        console.log("  把上面两行发给网页 AI，AI 用配对码 join 即可");
        console.log("  （配对码一次性，15 分钟有效）");
      } else if (choice === "2") {
        const list = mgr.listChannels();
        if (list.length === 0) {
          console.log("  暂无信道");
        } else {
          console.log("");
          for (const c of list) {
            console.log(`  [${c.paired ? "✓已配对" : "○待配对"}] ${c.name} (${c.bindingId.slice(0, 12)}…)`);
            console.log(`      状态: ${c.liveness}${c.latencyMs !== null ? ` 延迟: ${c.latencyMs}ms` : ""}`);
            console.log(`      请求: ↓${c.stats.requestsIn} ↑${c.stats.requestsOut} 错误: ${c.stats.errors}`);
          }
        }
      } else if (choice === "3") {
        const list = mgr.listChannels().filter((c) => c.kind === "gateway");
        if (list.length === 0) {
          console.log("  暂无网关信道");
          continue;
        }
        list.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} (${c.bindingId.slice(0, 12)}…)`));
        const idx = parseInt(await ask("  选择信道 > "), 10) - 1;
        const target = list[idx];
        if (isNaN(idx) || !target) {
          console.log("  无效选择");
          continue;
        }
        const newCode = await mgr.recode(target.bindingId);
        console.log(`  ✓ 新配对码: ${newCode}（旧码已作废）`);
      } else if (choice === "4") {
        const list = mgr.listChannels();
        if (list.length === 0) {
          console.log("  暂无信道");
          continue;
        }
        list.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} (${c.bindingId.slice(0, 12)}…)`));
        const idx = parseInt(await ask("  选择信道 > "), 10) - 1;
        const target = list[idx];
        if (isNaN(idx) || !target) {
          console.log("  无效选择");
          continue;
        }
        await mgr.remove(target.bindingId);
        console.log("  ✓ 信道已关闭");
      } else if (choice === "5" || choice.toLowerCase() === "q") {
        break;
      } else {
        console.log("  无效选择");
      }
    } catch (err: any) {
      console.log(`  ✘ 出错: ${err.message || err}`);
    }
  }

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`  ✘ ${err.message || err}`);
  process.exit(1);
});
