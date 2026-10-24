// Security: the folder browser reads a bot's own folders and, on a desktop or self-hosted server, the folders above its
// working folder up to the person's home. The app's data folder stays hidden apart from that bot's own folders in it:
// it holds credentials and other bots' memories.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { browseFolder, containedBy, openBrowsedFile, statusError } from "./message-file.ts";

export interface BotFolderScope {
  /** The conversation's working folder first, then the bot's shared folder. */
  roots: readonly string[];
  /** The bot's folders inside the data folder that stay readable. */
  ownFolders: readonly string[];
  dataDir: string;
  /** Where climbing stops; null where the browser never leaves the bot's folders (Cloud and hosted servers). */
  home: string | null;
}

export interface BrowseRequest {
  /** Index into the scope's roots. */
  root: number;
  /** Parent folders above the working folder. */
  up: number;
  /** Path below that base, "/"-separated. */
  path: string;
}

function canonical(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

export function botFolderBrowser(scope: BotFolderScope) {
  const roots = scope.roots.map(canonical);
  const own = [...roots, ...scope.ownFolders.map(canonical)].filter((folder): folder is string => folder !== null);
  const data = canonical(scope.dataDir);
  const home = scope.home === null ? null : canonical(scope.home);
  const hidden = (path: string) => data !== null && containedBy(data, path) && !own.some((folder) => containedBy(folder, path));
  const climbable = (folder: string) => {
    const parent = dirname(folder);
    return parent !== folder && home !== null && containedBy(home, parent) && !hidden(parent) ? parent : null;
  };

  const base = ({ root, up }: BrowseRequest) => {
    const start = roots[root];
    if (!start) throw statusError(404, "no such folder");
    let folder = start;
    for (let step = 0; step < up; step += 1) {
      const parent = root === 0 ? climbable(folder) : null;
      if (!parent) throw statusError(403, "that folder is outside what this bot's files can show", "outside_workspace");
      folder = parent;
    }
    return { folder, canGoUp: root === 0 && climbable(folder) !== null };
  };

  return {
    async list(request: BrowseRequest) {
      const { folder, canGoUp } = base(request);
      return { base: folder, canGoUp, ...(await browseFolder(request.path, folder, hidden)) };
    },
    async open(request: BrowseRequest) {
      return openBrowsedFile(request.path, base(request).folder, hidden);
    },
  };
}
