import { z } from "zod";
export const manifest = { name: "hello", version: "0.1.0", description: "示例插件" };
export const tools = [
  {
    name: "greet",
    description: "打招呼",
    inputSchema: z.object({ name: z.string() }),
    handler: async ({ name }) => ({ greeting: `你好，${name}！` }),
  },
];
