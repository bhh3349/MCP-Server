/**
 * 打包桌面版 sidecar。
 *
 * 把 src/local/cli.ts（连同其全部运行时依赖 ws/zod/@modelcontextprotocol/server/ssh2…）
 * 用 esbuild 打成单文件 CJS，再把它需要的运行期资源（UI 静态文件、extensions 扩展）
 * 一起放到 src-tauri/sidecar/，供 tauri.conf.json 的 bundle.resources 分发。
 *
 * 为什么不用 tsc 产物：dist/ 只有编译后的 JS，不含 node_modules，
 * 安装到用户机器后 node 会因找不到模块立即崩溃。
 *
 * 为什么放 src-tauri/sidecar 而不是引用 ../dist：
 * Tauri 对带 `..` 的 resource 路径会在打包时重命名为 `_up_/…`，
 * 运行时路径对不上；放在 src-tauri 内部则路径稳定。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "src-tauri", "sidecar");

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src", "local", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs", // CJS：ws/ssh2 等依赖含动态 require 与 __dirname，ESM 会崩
  target: "node20",
  outfile: join(outDir, "sidecar.cjs"),
  logLevel: "info",
});

// 运行期资源：UI 静态文件 + 扩展包
cpSync(join(root, "src", "dashboard", "ui"), join(outDir, "ui"), { recursive: true });
cpSync(join(root, "extensions"), join(outDir, "extensions"), { recursive: true });

// 扩展是运行时才 import 的外部文件，不经 esbuild，无法享用主程序的依赖内联。
// 它们从 sidecar/node_modules 解析依赖，这里把示例扩展用到的包一并带上。
// 扩展若需要其它 npm 包，作者应自带或在此列表追加。
const extensionDeps = ["zod"];
mkdirSync(join(outDir, "node_modules"), { recursive: true });
for (const dep of extensionDeps) {
  const from = join(root, "node_modules", dep);
  if (isDirectory(from)) {
    cpSync(from, join(outDir, "node_modules", dep), { recursive: true });
  } else {
    console.warn(`[build-sidecar] 警告：找不到扩展依赖 ${dep}`);
  }
}

console.log(`[build-sidecar] 完成 → ${outDir}`);
