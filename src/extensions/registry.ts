/**
 * 扩展注册表：统一管理插件 / 技能 / 连接器。
 *
 * 目录布局（默认 ./extensions，可用 MCP_EXTENSIONS_DIR 覆盖）：
 *   extensions/
 *     plugins/<name>/manifest.json + index.js
 *     skills/<name>/SKILL.md (+ scripts/)
 *     connectors/<name>/manifest.json + index.js + config.json
 */
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadPlugins } from "./plugin.js";
import { loadSkills } from "./skill.js";
import { loadConnectors } from "./connector.js";
import type { ExtensionKind, LoadedExtension } from "./types.js";

export class ExtensionRegistry {
  private extensions: LoadedExtension[] = [];

  constructor(private server: McpServer, private rootDir: string) {}

  async loadAll(): Promise<void> {
    const [plugins, skills, connectors] = await Promise.all([
      loadPlugins(this.server, join(this.rootDir, "plugins")),
      loadSkills(this.server, join(this.rootDir, "skills")),
      loadConnectors(this.server, join(this.rootDir, "connectors")),
    ]);
    this.extensions = [...plugins, ...skills, ...connectors];
    const counts = {
      plugins: plugins.length,
      skills: skills.length,
      connectors: connectors.length,
    };
    console.log(`[extensions] loaded: ${JSON.stringify(counts)}`);
  }

  list(kind?: ExtensionKind): LoadedExtension[] {
    return kind ? this.extensions.filter((e) => e.kind === kind) : [...this.extensions];
  }

  get(name: string): LoadedExtension | undefined {
    return this.extensions.find((e) => e.manifest.name === name);
  }

  async disable(name: string): Promise<boolean> {
    const ext = this.get(name);
    if (!ext) return false;
    await ext.disable();
    return true;
  }

  /** 注册到 MCP 的全部工具名（含命名空间） */
  toolNames(): string[] {
    return this.extensions.flatMap((e) => e.toolNames);
  }
}
