/**
 * GitHub 连接器。
 * 配置：config.json { "token": "ghp_..." }
 * 工具命名空间：github.<tool>
 */
import { z } from "zod";

export const manifest = { name: "github", version: "0.1.0", description: "GitHub 连接器：仓库/Issue/PR/文件读写" };
export const configSchema = z.object({
  token: z.string().min(1).describe("GitHub Personal Access Token"),
  baseUrl: z.string().url().default("https://api.github.com").optional(),
});

let cfg = null;
let connected = false;

export const connect = async (config) => {
  cfg = configSchema.parse(config);
  // 验证 token 有效
  const res = await gh("/user");
  if (!res.login) throw new Error("GitHub token 无效");
  connected = true;
};
export const disconnect = async () => { connected = false; cfg = null; };
export const isConnected = () => connected;

async function gh(path, { method = "GET", body, query } = {}) {
  if (!cfg) throw new Error("github 未连接");
  const base = (cfg.baseUrl || "https://api.github.com").replace(/\/+$/, "");
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const res = await fetch(`${base}${path}${qs}`, {
    method,
    headers: {
      "Authorization": `Bearer ${cfg.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-server-github-connector/0.1.0",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("github: token 无效或过期 (401)");
  if (res.status === 403) {
    const rl = res.headers.get("x-ratelimit-remaining");
    throw new Error(`github: 拒绝 (403)${rl === "0" ? "，API 限流" : ""}`);
  }
  if (res.status === 404) throw new Error(`github: 不存在 (404) ${path}`);
  if (!res.ok) throw new Error(`github: HTTP ${res.status} ${path}`);
  if (res.status === 204) return null;
  return res.json();
}

const repoArgs = { owner: z.string(), repo: z.string() };

export const getTools = () => {
  if (!connected) return [];
  return [
    {
      name: "repo_get",
      description: "获取仓库信息",
      inputSchema: z.object({ ...repoArgs }),
      handler: async ({ owner, repo }) => gh(`/repos/${owner}/${repo}`),
    },
    {
      name: "repo_list",
      description: "列出当前用户的仓库",
      inputSchema: z.object({
        per_page: z.number().int().min(1).max(100).default(30),
        sort: z.enum(["created", "updated", "pushed", "full_name"]).default("pushed"),
      }),
      handler: async ({ per_page, sort }) =>
        (await gh("/user/repos", { query: { per_page: String(per_page), sort } }))
          .map((r) => ({ full_name: r.full_name, private: r.private, description: r.description, updated_at: r.updated_at })),
    },
    {
      name: "file_get",
      description: "读取仓库文件（返回 content/base64 + sha，sha 用于更新时传）",
      inputSchema: z.object({ ...repoArgs, path: z.string(), ref: z.string().optional() }),
      handler: async ({ owner, repo, path, ref }) => {
        const q = ref ? { ref } : undefined;
        const f = await gh(`/repos/${owner}/${repo}/contents/${path.replace(/^\/+/, "")}`, { query: q });
        if (Array.isArray(f)) return f.map((x) => ({ name: x.name, path: x.path, type: x.type, sha: x.sha }));
        return {
          path: f.path, sha: f.sha, size: f.size,
          encoding: f.encoding,
          content: f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf-8") : f.content,
        };
      },
    },
    {
      name: "file_upsert",
      description: "创建或更新仓库文件（需传 file_get 拿到的 sha；新建不用传）",
      inputSchema: z.object({
        ...repoArgs, path: z.string(), content: z.string(),
        message: z.string(), sha: z.string().optional(), branch: z.string().optional(),
      }),
      handler: async ({ owner, repo, path, content, message, sha, branch }) =>
        gh(`/repos/${owner}/${repo}/contents/${path.replace(/^\/+/, "")}`, {
          method: "PUT",
          body: {
            message, content: Buffer.from(content, "utf-8").toString("base64"),
            ...(sha ? { sha } : {}), ...(branch ? { branch } : {}),
          },
        }),
    },
    {
      name: "issue_list",
      description: "列出仓库 Issue",
      inputSchema: z.object({
        ...repoArgs,
        state: z.enum(["open", "closed", "all"]).default("open"),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      handler: async ({ owner, repo, state, per_page }) =>
        (await gh(`/repos/${owner}/${repo}/issues`, { query: { state, per_page: String(per_page) } }))
          .map((i) => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login, created_at: i.created_at })),
    },
    {
      name: "issue_get",
      description: "获取 Issue 详情（含评论数）",
      inputSchema: z.object({ ...repoArgs, number: z.number().int() }),
      handler: async ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/issues/${number}`),
    },
    {
      name: "issue_create",
      description: "创建 Issue",
      inputSchema: z.object({ ...repoArgs, title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional() }),
      handler: async ({ owner, repo, title, body, labels }) =>
        gh(`/repos/${owner}/${repo}/issues`, { method: "POST", body: { title, body, labels } }),
    },
    {
      name: "issue_comment",
      description: "给 Issue/PR 评论",
      inputSchema: z.object({ ...repoArgs, number: z.number().int(), body: z.string() }),
      handler: async ({ owner, repo, number, body }) =>
        gh(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: { body } }),
    },
    {
      name: "pr_list",
      description: "列出 Pull Request",
      inputSchema: z.object({
        ...repoArgs,
        state: z.enum(["open", "closed", "all"]).default("open"),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      handler: async ({ owner, repo, state, per_page }) =>
        (await gh(`/repos/${owner}/${repo}/pulls`, { query: { state, per_page: String(per_page) } }))
          .map((p) => ({ number: p.number, title: p.title, state: p.state, user: p.user?.login, head: p.head?.ref, base: p.base?.ref })),
    },
    {
      name: "pr_get",
      description: "获取 PR 详情",
      inputSchema: z.object({ ...repoArgs, number: z.number().int() }),
      handler: async ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}`),
    },
    {
      name: "pr_create",
      description: "创建 Pull Request",
      inputSchema: z.object({
        ...repoArgs, title: z.string(), head: z.string(), base: z.string(), body: z.string().optional(),
      }),
      handler: async ({ owner, repo, title, head, base, body }) =>
        gh(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: { title, head, base, body } }),
    },
    {
      name: "search_code",
      description: "搜索代码",
      inputSchema: z.object({ q: z.string().describe("搜索关键词，可加 repo:owner/name 限定"), per_page: z.number().int().min(1).max(100).default(10) }),
      handler: async ({ q, per_page }) => {
        const r = await gh("/search/code", { query: { q, per_page: String(per_page) } });
        return { total: r.total_count, items: r.items.map((i) => ({ repo: i.repository.full_name, path: i.path })) };
      },
    },
  ];
};
