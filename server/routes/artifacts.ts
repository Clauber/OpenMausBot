// Thread artifacts API: list a thread's files, download one version, list a
// file's versions. Registered after the auth gate like every route module.
import { createReadStream, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Artifact, ArtifactsDb } from "../artifacts-db.ts";
import { ATTACHMENTS_DIR } from "../attachments.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ArtifactsRouteDeps {
  db(): ArtifactsDb;
  threadExists(threadId: string): boolean;
}

const wire = (a: Artifact) => ({ ...a, url: `/api/artifacts/${a.id}` });

export function createArtifactsRoutes(deps: ArtifactsRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET") return PASS;
    const list = path.match(/^\/api\/threads\/([\w-]+)\/artifacts$/);
    if (list) {
      if (!deps.threadExists(list[1])) return json(res, 404, { error: "no such conversation" });
      return json(res, 200, { artifacts: deps.db().listLatest(list[1]).map(wire) });
    }
    const versions = path.match(/^\/api\/artifacts\/([\w-]+)\/versions$/);
    if (versions) {
      const all = deps.db().versions(versions[1]);
      if (!all.length) return json(res, 404, { error: "no such artifact" });
      return json(res, 200, { versions: all.map(wire) });
    }
    const one = path.match(/^\/api\/artifacts\/([\w-]+)$/);
    if (!one) return PASS;
    const row = deps.db().get(one[1]);
    if (!row) return json(res, 404, { error: "no such artifact" });
    // The blob is one of our own UUID-named attachment files; never serve anything else.
    const file = join(ATTACHMENTS_DIR, basename(row.blob));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return json(res, 410, { error: "this version's file is no longer stored" });
    }
    res.writeHead(200, {
      "content-type": row.mime,
      "content-length": size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(res);
  };
}
