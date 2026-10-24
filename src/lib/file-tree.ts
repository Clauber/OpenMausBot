import { visibleMessages, type Bot } from "@/state/store";

export interface FolderEntry { name: string; bytes: number; mime: string }
export interface FolderListing { folders: string[]; entries: FolderEntry[]; truncated: boolean }
export interface OpenedFile { root: number; path: string; mime: string; bytes: number }
/** Folder keys are `${root}:${path}`; root 0's paths are below the folder `up` levels above the working folder. */
export interface FileTreeState { up: number; expanded: string[]; opened: OpenedFile | null }

export type TreeRow =
  | { kind: "folder"; key: string; root: number; path: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; key: string; root: number; path: string; name: string; depth: number; entry: FolderEntry }
  | { kind: "note"; key: string; depth: number; note: string };

export const folderKey = (root: number, path: string) => `${root}:${path}`;
const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

export function treeRows(
  rootNames: readonly string[],
  state: FileTreeState,
  listings: ReadonlyMap<string, FolderListing>,
  errors: ReadonlyMap<string, string>,
): TreeRow[] {
  const expanded = new Set(state.expanded);
  const rows: TreeRow[] = [];
  const visit = (root: number, path: string, name: string, depth: number) => {
    const key = folderKey(root, path);
    const open = expanded.has(key);
    rows.push({ kind: "folder", key, root, path, name, depth, expanded: open });
    if (!open) return;
    const listing = listings.get(key);
    const error = errors.get(key);
    if (error) rows.push({ kind: "note", key: `${key}#note`, depth: depth + 1, note: error });
    if (!listing) {
      if (!error) rows.push({ kind: "note", key: `${key}#note`, depth: depth + 1, note: "loading" });
      return;
    }
    for (const folder of listing.folders) visit(root, joinPath(path, folder), folder, depth + 1);
    for (const entry of listing.entries) {
      const file = joinPath(path, entry.name);
      rows.push({ kind: "file", key: `${root}:${file}#file`, root, path: file, name: entry.name, depth: depth + 1, entry });
    }
    if (listing.truncated) rows.push({ kind: "note", key: `${key}#truncated`, depth: depth + 1, note: "truncated" });
  };
  rootNames.forEach((name, root) => visit(root, "", name, 0));
  return rows;
}

/** One folder up: everything root 0 had expanded or open is now below the old folder's name. */
export function climbedState(state: FileTreeState, folderName: string): FileTreeState {
  const below = (path: string) => joinPath(folderName, path);
  return {
    up: state.up + 1,
    expanded: [...new Set(state.expanded.flatMap((key) => key.startsWith("0:") ? (key === "0:" ? ["0:", `0:${folderName}`] : [`0:${below(key.slice(2))}`]) : [key]))],
    opened: state.opened?.root === 0 ? { ...state.opened, path: below(state.opened.path) } : state.opened,
  };
}

const normalized = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** What this chat's turns added ("A") or modified ("M"), by absolute path, plus every folder holding one. */
export function changedFileMarks(bot: Bot): { files: Map<string, "A" | "M">; folders: Set<string> } {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const cwd = task?.cwd === undefined ? bot.cwd : task.cwd;
  const absolute = (path: string) => {
    const clean = normalized(path);
    if (/^([a-z]:)?\//i.test(clean)) return clean;
    return typeof cwd === "string" ? `${normalized(cwd)}/${clean.replace(/^(\.\/)+/, "")}` : null;
  };
  const files = new Map<string, "A" | "M">();
  for (const message of visibleMessages(bot)) {
    const changes = message.digest?.files;
    if (!changes) continue;
    for (const path of changes.added) { const at = absolute(path); if (at) files.set(at, "A"); }
    for (const path of changes.changed) { const at = absolute(path); if (at && files.get(at) !== "A") files.set(at, "M"); }
    for (const path of changes.deleted) { const at = absolute(path); if (at) files.delete(at); }
  }
  const folders = new Set<string>();
  for (const path of files.keys()) {
    for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) folders.add(path.slice(0, cut));
  }
  return { files, folders };
}

export const absoluteIn = (base: string, path: string) => (path ? `${normalized(base)}/${path}` : normalized(base));

const STORAGE_PREFIX = "omb-file-tree";
const fresh = (): FileTreeState => ({ up: 0, expanded: ["0:"], opened: null });

export function readFileTreeState(botId: string, threadId: string, storage: Pick<Storage, "getItem"> = localStorage): FileTreeState {
  try {
    const value = JSON.parse(storage.getItem(`${STORAGE_PREFIX}:${botId}:${threadId}`) ?? "null") as Partial<FileTreeState> | null;
    if (value && Number.isInteger(value.up) && value.up! >= 0 && Array.isArray(value.expanded) && value.expanded.every((key) => typeof key === "string")) {
      return { up: value.up!, expanded: value.expanded, opened: value.opened ?? null };
    }
  } catch {
  }
  return fresh();
}

export function writeFileTreeState(botId: string, threadId: string, state: FileTreeState, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(`${STORAGE_PREFIX}:${botId}:${threadId}`, JSON.stringify(state));
  } catch {
  }
}
