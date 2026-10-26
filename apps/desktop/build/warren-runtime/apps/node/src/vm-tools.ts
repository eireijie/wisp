import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const MCP_MAIN = fileURLToPath(new URL("../../../packages/mcp/src/main.ts", import.meta.url));

let bundled: Promise<{ code: string; hash: string }> | null = null;

/**
 * warren-mcp as a single file that runs on any Node 22, so a harness inside a VM gets Warren's
 * tools without this device's node_modules (which are built for this device's OS). Built once per
 * process with esbuild, which Warren already has (through tsx).
 */
export function mcpBundle(): Promise<{ code: string; hash: string }> {
  bundled ??= (async () => {
    const { build } = await import("esbuild");
    const out = await build({
      entryPoints: [MCP_MAIN],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      logLevel: "silent",
      // some dependencies are CommonJS and require() Node's own modules
      banner: { js: "import { createRequire as __warrenRequire } from 'node:module'; const require = __warrenRequire(import.meta.url);" },
    });
    const code = out.outputFiles[0].text;
    return { code, hash: crypto.createHash("sha256").update(code).digest("hex").slice(0, 16) };
  })().catch((err) => {
    bundled = null;
    throw err;
  });
  return bundled;
}
