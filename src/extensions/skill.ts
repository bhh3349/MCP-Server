/**
 * 技能加载器。
 *
 * 目录结构：
 *   skills/<name>/
 *     SKILL.md        # frontmatter (name, description, when) + 使用说明正文
 *     scripts/...     # 可选：技能自带的辅助脚本
 *
 * 技能以两种形式暴露：
 * 1. MCP 资源：skill://<name>，正文即 SKILL.md 全文；
 * 2. list_skills 工具：列出所有技能的名称、描述、触发条件。
 *
 * AI 读到技能内容后，按里面的步骤执行（必要时用 exec 跑 scripts/）。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { LoadedExtension, SkillFrontmatter } from "./types.js";

const FrontmatterRe = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function parseSkillMd(raw: string): { front: SkillFrontmatter; body: string } {
  const m = FrontmatterRe.exec(raw);
  if (!m) throw new Error("SKILL.md missing frontmatter");
  const front: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!front["name"] || !front["description"]) {
    throw new Error("SKILL.md frontmatter needs name and description");
  }
  return {
    front: {
      name: front["name"]!,
      description: front["description"]!,
      ...(front["when"] ? { when: front["when"] } : {}),
    },
    body: m[2]!.trim(),
  };
}

export async function loadSkills(
  server: McpServer,
  skillsDir: string,
): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    return [];
  }

  const index: Array<{ name: string; description: string; when?: string }> = [];

  for (const name of entries) {
    const dir = join(skillsDir, name);
    try {
      const raw = await readFile(join(dir, "SKILL.md"), "utf-8");
      const { front, body } = parseSkillMd(raw);
      const uri = `skill://${front.name}`;

      server.registerResource(
        uri,
        uri,
        { description: `[skill] ${front.description}`, mimeType: "text/markdown" },
        async () => ({ contents: [{ uri, mimeType: "text/markdown", text: body }] }),
      );

      const entry: { name: string; description: string; when?: string } = {
        name: front.name,
        description: front.description,
      };
      if (front.when) entry.when = front.when;
      index.push(entry);
      loaded.push({
        kind: "skill",
        manifest: {
          name: front.name,
          version: "1.0.0",
          description: front.description,
          kind: "skill",
        },
        dir,
        enabled: true,
        toolNames: [],
        resourceUris: [uri],
        disable: async () => {},
      });
    } catch (err) {
      console.error(`[skill] failed to load ${name}:`, (err as Error).message);
    }
  }

  if (index.length > 0) {
    server.registerTool(
      "list_skills",
      { description: "List available skills (capability packages). Read skill://<name> for instructions." },
      async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }],
      }),
    );
  }

  return loaded;
}

// 供测试用
export { parseSkillMd };
