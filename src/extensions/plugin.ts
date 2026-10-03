/**
 * 插件加载器。
 *
 * 目录结构：
 *   plugins/<name>/
 *     manifest.json  { name, version, description, entry: "index.js" }
 *     index.js       module.exports = { manifest, tools, onEnable?, onDisable? }
 *
 * 工具注册为 MCP 工具，命名空间：<pluginName>.<toolName>，避免冲突。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  ExtensionToolDef,
  LoadedExtension,
  PluginModule,
} from "./types.js";

export async function loadPlugins(
  server: McpServer,
  pluginsDir: string,
): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  let entries: string[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    return []; // 目录不存在 = 没有插件
  }

  for (const name of entries) {
    const dir = join(pluginsDir, name);
    try {
      const ext = await loadOnePlugin(server, dir);
      loaded.push(ext);
    } catch (err) {
      console.error(`[plugin] failed to load ${name}:`, (err as Error).message);
    }
  }
  return loaded;
}

async function loadOnePlugin(
  server: McpServer,
  dir: string,
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
  )) as PluginModule;

  const tools: ExtensionToolDef[] = mod.tools ?? [];
  const toolNames: string[] = [];

  for (const t of tools) {
    const namespaced = `${manifestJson.name}.${t.name}`;
    server.registerTool(
      namespaced,
      { description: `[${manifestJson.name}] ${t.description}`, inputSchema: t.inputSchema },
      async (args) => ({
        content: [
          { type: "text" as const, text: JSON.stringify(await t.handler(args), null, 2) },
        ],
      }),
    );
    toolNames.push(namespaced);
  }

  await mod.onEnable?.();

  let enabled = true;
  return {
    kind: "plugin",
    manifest: { ...manifestJson, kind: "plugin" },
    dir,
    get enabled() {
      return enabled;
    },
    toolNames,
    resourceUris: [],
    disable: async () => {
      // MCP SDK v2 暂不支持注销工具：disable 停掉插件逻辑，
      // 工具调用时返回不可用。重启后彻底移除。
      enabled = false;
      await mod.onDisable?.();
    },
  };
}
