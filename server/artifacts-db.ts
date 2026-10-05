// Versioned thread artifacts: files a bot produced and handed over in a turn.
// One row per saved version; rewriting the same path in the same thread adds
// the next version instead of replacing the last. `path` is the source path
// the bot named (the identity of the file); `blob` is the private copy in the
// attachment store that holds that version's bytes.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Artifact {
  id: string;
  threadId: string;
  botId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  version: number;
  createdAt: number;
}

export interface ArtifactRecord extends Artifact {
  blob: string;
}

export interface NewArtifact {
  threadId: string;
  botId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  blob: string;
}

const COLUMNS = "id, threadId, botId, path, name, mime, size, version, createdAt";

export class ArtifactsDb {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        botId TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        version INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        blob TEXT NOT NULL,
        UNIQUE (threadId, path, version)
      );
      CREATE INDEX IF NOT EXISTS artifacts_thread ON artifacts (threadId, path, version)`);
  }

  /** Add a version. The first save of a path in a thread is v1; each later save is the next. */
  add(input: NewArtifact, now = Date.now()): Artifact {
    const id = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT MAX(version) AS v FROM artifacts WHERE threadId = ? AND path = ?")
        .get(input.threadId, input.path) as { v: number | null };
      const version = (last.v ?? 0) + 1;
      this.db.prepare(`INSERT INTO artifacts (id, threadId, botId, path, name, mime, size, version, createdAt, blob)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.threadId, input.botId, input.path, input.name, input.mime, input.size, version, now, input.blob);
      this.db.exec("COMMIT");
      return { id, threadId: input.threadId, botId: input.botId, path: input.path, name: input.name, mime: input.mime, size: input.size, version, createdAt: now };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The newest version of each path in a thread, most recently written first. */
  listLatest(threadId: string): Artifact[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM artifacts a
      WHERE threadId = ? AND version = (SELECT MAX(version) FROM artifacts WHERE threadId = a.threadId AND path = a.path)
      ORDER BY createdAt DESC, version DESC`).all(threadId) as unknown as Artifact[];
  }

  get(id: string): ArtifactRecord | undefined {
    return this.db.prepare(`SELECT ${COLUMNS}, blob FROM artifacts WHERE id = ?`).get(id) as unknown as ArtifactRecord | undefined;
  }

  /** Every version of the file this artifact is a version of, oldest first. */
  versions(id: string): Artifact[] {
    const row = this.get(id);
    if (!row) return [];
    return this.db.prepare(`SELECT ${COLUMNS} FROM artifacts WHERE threadId = ? AND path = ? ORDER BY version ASC`)
      .all(row.threadId, row.path) as unknown as Artifact[];
  }

  close(): void {
    this.db.close();
  }
}
