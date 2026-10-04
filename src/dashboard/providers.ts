/**
 * 模型供应商配置存储：~/.mcp-server/agent.json（600 权限）
 * API key 只存服务端，绝不返回给前端。
 */
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ModelProvider {
  id: string;
  name: string;
  /** openai-compatible 覆盖 OpenAI/DeepSeek/月之暗面等；anthropic 走官方 API */
  type: "openai" | "anthropic";
  baseUrl?: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

/** 返回给前端的安全视图（不含 key） */
export interface ProviderView {
  id: string;
  name: string;
  type: string;
  baseUrl?: string | undefined;
  model: string;
  enabled: boolean;
  hasKey: boolean;
}

const DIR = join(homedir(), ".mcp-server");
const PATH = join(DIR, "agent.json");

interface Store { providers: ModelProvider[]; activeId?: string | undefined }

async function load(): Promise<Store> {
  try {
    const raw = await readFile(PATH, "utf-8");
    const s = JSON.parse(raw) as Store;
    return { providers: s.providers ?? [], activeId: s.activeId };
  } catch {
    return { providers: [] };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  try { await chmod(PATH, 0o600); } catch { /* windows 忽略 */ }
}

const view = (p: ModelProvider): ProviderView => ({
  id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
  model: p.model, enabled: p.enabled, hasKey: !!p.apiKey,
});

export async function listProviders(): Promise<ProviderView[]> {
  return (await load()).providers.map(view);
}

export async function getProvider(id: string): Promise<ModelProvider | undefined> {
  return (await load()).providers.find((p) => p.id === id);
}

export async function getActiveProvider(): Promise<ModelProvider | undefined> {
  const s = await load();
  return s.providers.find((p) => p.id === s.activeId && p.enabled) ?? s.providers.find((p) => p.enabled);
}

export async function upsertProvider(input: Omit<ModelProvider, "id"> & { id?: string; baseUrl?: string; apiKey?: string }): Promise<ProviderView> {
  const s = await load();
  let p: ModelProvider;
  if (input.id) {
    const i = s.providers.findIndex((x) => x.id === input.id);
    if (i < 0) throw new Error("provider not found");
    const cur = s.providers[i]!;
    // 空 key 表示不修改原 key
    p = { ...cur, ...input, id: input.id, apiKey: input.apiKey || cur.apiKey };
    s.providers[i] = p;
  } else {
    p = { ...input, id: randomUUID() };
    s.providers.push(p);
  }
  if (!s.activeId) s.activeId = p.id;
  await save(s);
  return view(p);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const s = await load();
  const i = s.providers.findIndex((p) => p.id === id);
  if (i < 0) return false;
  s.providers.splice(i, 1);
  if (s.activeId === id) s.activeId = s.providers[0]?.id;
  await save(s);
  return true;
}

export async function setActiveProvider(id: string): Promise<boolean> {
  const s = await load();
  if (!s.providers.some((p) => p.id === id)) return false;
  s.activeId = id;
  await save(s);
  return true;
}
