// Serve the exact production bundle, with fixture-only first-run preferences
// and an API proxy that can reach only the launcher's isolated server.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { preview } from "vite";
import type { MountedPreview } from "./preview-fixture.ts";

export async function mountPagesBuiltPreview(apiUrl: string): Promise<MountedPreview> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl)) throw new Error("Pages preview requires an explicit isolated loopback URL");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const html = readFileSync(join(root, "dist", "index.html"), "utf8").replace("<head>",
    '<head><script>localStorage.setItem("omb-email-gate","skipped");localStorage.setItem("omb-analytics-opt-out","1");</script>');
  const server = await preview({ root, configFile: false, logLevel: "error", build: { outDir: "dist" },
    preview: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: apiUrl }, "/.well-known/openmausbot/environment": { target: apiUrl } } },
    plugins: [{ name: "pages-built-fixture", configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/") return next();
        res.setHeader("content-type", "text/html"); res.end(html);
      });
    } }],
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) { await server.close(); throw new Error("Pages built preview has no URL"); }
  return { previewUrl: url, close: () => server.close() };
}
