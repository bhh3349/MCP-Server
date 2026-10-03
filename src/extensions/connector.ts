/**
 * 连接器加载器。
 *
 * 目录结构：
 *   connectors/<name>/
 *     manifest.json  { name, version, description, entry: "index.js" }
 *     index.js       module.exports = { manifest, configSchema, connect, disconnect, getTools, isConnected }
 *     config.json    # 用户填写的鉴权配置（gitignore，不提交）
 *
 * 流程：
 * 1. 加载模块，读 config.json 按 configSchema 校验；
 * 2. connect(config) 成功 → 注册工具（命名空间 <name>.<tool>）；
 * 3. connect 失败 → 连接器记为未连接，不注册工具，不影响其他扩展。
 *
 * 另注册管理工具：
 * - list_connectors：全部连接器的连接状态
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConnectorModule, LoadedExtension } from "./types.js";

interface ConnectorState {
  name: string;
  connected: boolean;
  error?: string;
}

export async function loadConnectors(
  server: McpServer,
  connectorsDir: string,
): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  const states: ConnectorState[] = [];
  let entries: string[];
  try {
    entries = await readdir(connectorsDir, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    return [];
  }

  for (const name of entries) {
    const dir = join(connectorsDir, name);
    const state: ConnectorState = { name, connected: false };
    states.push(state);
    try {
      const ext = await loadOneConnector(server, dir, state);
      loaded.push(ext);
    } catch (err) {
      state.error = (err as Error).message;
      console.error(`[connector] failed to load ${name}:`, state.error);
    }
  }

  server.registerTool(
    "list_connectors",
    { description: "List connectors and their connection status." },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(states, null, 2) }],
    }),
  );

  return loaded;
}

async function loadOneConnector(
  server: McpServer,
  dir: string,
  state: ConnectorState,
): Promise<LoadedExtension> {
  const manifestRaw = await readFile(join(dir, "manifest.json"), "utf-8");
  const manifestJson = JSON.parse(manifestRaw) as {
    name: string;
    version: string;
    description: string;
    entry?: string;
  };
  const entry = manifestJson.entry ?? "index.js";
  const mod = (await import(
    pathToFileURL(join(dir, entry)).href
  )) as ConnectorModule;

  // 读配置（没有 config.json = 未配置，保持未连接）
  let config: unknown = undefined;
  try {
    const cfgRaw = await readFile(join(dir, "config.json"), "utf-8");
    config = mod.configSchema.parse(JSON.parse(cfgRaw));
  } catch {
    state.error = "missing or invalid config.json";
  }

  const toolNames: string[] = [];
  if (config !== undefined) {
    try {
      await mod.connect(config);
      state.connected = true;
      for (const t of mod.getTools()) {
        const namespaced = `${manifestJson.name}.${t.name}`;
        server.registerTool(
          namespaced,
          {
            description: `[${manifestJson.name}] ${t.description}`,
            inputSchema: t.inputSchema,
          },
          async (args) => {
            if (!mod.isConnected()) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `connector ${manifestJson.name} is not connected`,
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(await t.handler(args), null, 2),
                },
              ],
            };
          },
        );
        toolNames.push(namespaced);
      }
    } catch (err) {
      state.connected = false;
      state.error = `connect failed: ${(err as Error).message}`;
    }
  }

  return {
    kind: "connector",
    manifest: { ...manifestJson, kind: "connector" },
    dir,
    get enabled() {
      return state.connected;
    },
    toolNames,
    resourceUris: [],
    disable: async () => {
      await mod.disconnect().catch(() => {});
      state.connected = false;
    },
  };
}
