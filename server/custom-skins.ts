// Custom skins: the persisted collection behind Settings → Appearance's
// "your skins" and the create_skin agent tool. A skin is a small recipe
// (shared/skin-recipe.ts); the CSS is derived on the client at render, so
// this store never holds colours it would have to keep in sync.
//
// Shape follows WebhookManager: one JSON file in the data directory, zod
// narrowed on load, atomic saves, and frames emitted through an injected
// emitter so index.ts stays the only place that knows how to broadcast.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseJson, type JsonValue } from "./schema.ts";
import {
  MAX_CUSTOM_SKINS,
  SKIN_NAME_MAX,
  SKIN_TAGLINE_MAX,
  parseSkinInput,
  type CustomSkin,
} from "../shared/skin-recipe.ts";

export type CustomSkinManagerEvent =
  | { kind: "skin"; skin: CustomSkin }
  | { kind: "skin.deleted"; skinId: string };

export interface CustomSkinManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (event: CustomSkinManagerEvent) => void;
}

const recipeSchema = z.object({
  mode: z.enum(["dark", "light"]),
  accent: z.string().regex(/^#[0-9a-f]{6}$/),
  tint: z.string().regex(/^#[0-9a-f]{6}$/),
  bubble: z.enum(["match", "inverted"]),
  corners: z.enum(["sharp", "soft", "round"]),
});

const skinSchema = z.object({
  id: z.string().regex(/^cs-[0-9a-f]{8}$/),
  name: z.string().min(1).max(SKIN_NAME_MAX),
  tagline: z.string().max(SKIN_TAGLINE_MAX),
  recipe: recipeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.object({ botId: z.string(), name: z.string() }).optional(),
});

const skinFileSchema = z.object({ version: z.literal(1), skins: z.array(skinSchema).max(MAX_CUSTOM_SKINS) });

type StoredSkin = z.output<typeof skinSchema>;

export class CustomSkinManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly emit?: (event: CustomSkinManagerEvent) => void;
  private skins: StoredSkin[] = [];

  constructor(options: CustomSkinManagerOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "custom-skins.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    try {
      const parsed = skinFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.skins = parsed.data.skins;
    } catch {
      this.skins = [];
    }
  }

  list(): CustomSkin[] {
    return this.skins.map(publicSkin);
  }

  get(id: string): CustomSkin | null {
    const skin = this.skins.find((candidate) => candidate.id === id);
    return skin ? publicSkin(skin) : null;
  }

  /** Create from untrusted input, or — when a skin of the same name already
   *  exists — replace that skin's recipe, keeping its id. Replacement is the
   *  agent's iteration loop ("make the accent more orange" → same call),
   *  and it keeps the person's picker from filling with near-duplicates.
   *  `createdBy` is only stamped on a fresh create; editing preserves the
   *  original author. */
  save(input: JsonValue, author?: { botId: string; name: string }): { skin: CustomSkin; replaced: boolean } {
    const parsed = parseSkinInput(input);
    if (!parsed.ok) fail(400, parsed.error);
    const now = this.now();
    const existing = this.skins.find((candidate) => candidate.name.toLowerCase() === parsed.name.toLowerCase());
    if (existing) {
      existing.recipe = parsed.recipe;
      existing.tagline = parsed.tagline;
      existing.updatedAt = now;
      this.saveFile();
      const skin = publicSkin(existing);
      this.emit?.({ kind: "skin", skin });
      return { skin, replaced: true };
    }
    if (this.skins.length >= MAX_CUSTOM_SKINS) {
      fail(400, `At most ${MAX_CUSTOM_SKINS} custom skins fit in the picker — delete one first.`);
    }
    const skin: StoredSkin = {
      id: newSkinId(),
      name: parsed.name,
      tagline: parsed.tagline,
      recipe: parsed.recipe,
      createdAt: now,
      updatedAt: now,
      ...(author ? { createdBy: author } : {}),
    };
    this.skins.unshift(skin);
    this.saveFile();
    this.emit?.({ kind: "skin", skin: publicSkin(skin) });
    return { skin: publicSkin(skin), replaced: false };
  }

  /** The editor's PATCH: fields only, by id. Takes untrusted input and
   *  narrows it itself, exactly like save. */
  update(id: string, patch: unknown): CustomSkin | null {
    const skin = this.skins.find((candidate) => candidate.id === id);
    if (!skin) return null;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) fail(400, "body");
    const raw = patch as Record<string, unknown>;
    if (raw.name !== undefined) {
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) fail(400, "name must be a non-empty string.");
      if (name.length > SKIN_NAME_MAX) fail(400, `name must be at most ${SKIN_NAME_MAX} characters.`);
      const clash = this.skins.find((c) => c !== skin && c.name.toLowerCase() === name.toLowerCase());
      if (clash) fail(400, `A skin named "${name}" already exists.`);
      skin.name = name;
    }
    if (raw.tagline !== undefined) {
      if (typeof raw.tagline !== "string") fail(400, "tagline must be a string.");
      if (raw.tagline.length > SKIN_TAGLINE_MAX) fail(400, `tagline must be at most ${SKIN_TAGLINE_MAX} characters.`);
      skin.tagline = raw.tagline.trim();
    }
    if (raw.recipe !== undefined) {
      // name/tagline stay owned by their own fields, never the recipe blob.
      const parsed = parseSkinInput({ ...(typeof raw.recipe === "object" && raw.recipe !== null ? raw.recipe : {}), name: skin.name, tagline: skin.tagline });
      if (!parsed.ok) fail(400, parsed.error);
      skin.recipe = parsed.recipe;
    }
    skin.updatedAt = this.now();
    this.saveFile();
    const public_ = publicSkin(skin);
    this.emit?.({ kind: "skin", skin: public_ });
    return public_;
  }

  remove(id: string): boolean {
    const at = this.skins.findIndex((candidate) => candidate.id === id);
    if (at === -1) return false;
    this.skins.splice(at, 1);
    this.saveFile();
    this.emit?.({ kind: "skin.deleted", skinId: id });
    return true;
  }

  private saveFile(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, skins: this.skins } satisfies z.output<typeof skinFileSchema>, null, 2),
      { mode: 0o600 },
    );
  }
}

function newSkinId(): string {
  return `cs-${randomUUID().split("-")[0]}`;
}

function publicSkin(skin: StoredSkin): CustomSkin {
  return {
    id: skin.id,
    name: skin.name,
    tagline: skin.tagline,
    recipe: { ...skin.recipe },
    createdAt: skin.createdAt,
    updatedAt: skin.updatedAt,
    ...(skin.createdBy ? { createdBy: { ...skin.createdBy } } : {}),
  };
}

function fail(status: number, error: string): never {
  const e = new Error(error) as Error & { status?: number };
  e.status = status;
  throw e;
}
