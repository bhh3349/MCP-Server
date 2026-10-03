import { z } from "zod";
let connected = false;
export const manifest = { name: "demo", version: "0.1.0", description: "示例连接器" };
export const configSchema = z.object({ apiKey: z.string().min(1) });
export const connect = async (config) => { connected = true; };
export const disconnect = async () => { connected = false; };
export const isConnected = () => connected;
export const getTools = () => [
  {
    name: "ping",
    description: "测试连接",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  },
];
