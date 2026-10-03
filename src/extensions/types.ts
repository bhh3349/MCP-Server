/**
 * 扩展系统类型定义：插件 / 技能 / 连接器。
 *
 * 三者分工：
 * - 插件 (Plugin)：第三方工具包。JS 模块，导出一组工具，动态加载。
 * - 技能 (Skill)：能力说明包。SKILL.md（Claude Code 风格）+ 可选脚本，
 *   以 MCP 资源形式暴露，告诉 AI "在什么场景下按什么步骤做事"。
 * - 连接器 (Connector)：外部服务集成（GitHub、邮件……）。带鉴权配置，
 *   有连接状态，导出该服务的工具。
 */
import type { z } from "zod";

export type ExtensionKind = "plugin" | "skill" | "connector";

export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  kind: ExtensionKind;
  /** 入口 JS 文件（插件/连接器），相对于扩展目录 */
  entry?: string;
}

/** 扩展导出的单个工具定义 */
export interface ExtensionToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<unknown>;
}

export interface LoadedExtension {
  kind: ExtensionKind;
  manifest: ExtensionManifest;
  dir: string;
  enabled: boolean;
  /** 注册到 MCP 的工具名（命名空间后） */
  toolNames: string[];
  /** 注册到 MCP 的资源 URI（技能） */
  resourceUris: string[];
  disable: () => Promise<void>;
}

/** 插件模块的导出形状 */
export interface PluginModule {
  manifest: Omit<ExtensionManifest, "kind">;
  tools: ExtensionToolDef[];
  onEnable?: () => Promise<void>;
  onDisable?: () => Promise<void>;
}

/** 连接器模块的导出形状 */
export interface ConnectorModule {
  manifest: Omit<ExtensionManifest, "kind">;
  /** 配置的 Zod schema（用户在 config.json 里填） */
  configSchema: z.ZodTypeAny;
  connect: (config: unknown) => Promise<void>;
  disconnect: () => Promise<void>;
  /** 连接成功后可用；未连接时返回 [] */
  getTools: () => ExtensionToolDef[];
  /** 连接状态 */
  isConnected: () => boolean;
}

/** 技能的 SKILL.md frontmatter */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** 什么场景下使用（给 AI 看的触发条件） */
  when?: string;
}
