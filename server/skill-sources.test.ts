import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listLibrarySkills, readLibrarySkillFile } from "./skill-library.ts";
import {
  buildSkillSourceCatalog,
  detectLunaDependence,
  detectSecretLiterals,
  importSkillSources,
  isSecretFileName,
  mirrorSkillTree,
  normalizeSkillMd,
} from "./skill-sources.ts";

// Secret-looking literals are assembled at run time so this file never holds
// one, and every one is an obvious placeholder shape, not a credential.
const FAKE_SK = `sk-${"A1b2".repeat(8)}`;
const FAKE_GH = `ghp_${"a1B2".repeat(10)}`;

const skill = (name: string, description = `Does ${name}.`, body = `# ${name}\n\nUse it.\n`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;

let dir: string;
const write = (rel: string, text: string) => {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-skill-sources-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[p.slice(root.length)] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(root);
  return out;
}

describe("credential-looking file names", () => {
  it("flags env files, keys and token/credential data files, not documentation", () => {
    for (const name of [".env", "prod.env", ".env.local", "server.pem", "deploy.key", "id_rsa", "id_ed25519.pub", "token.json", "api-token.txt", "credentials.yaml", "client_secret.json", "secrets.toml", "password"]) {
      expect(isSecretFileName(name), name).toBe(true);
    }
    for (const name of ["SKILL.md", "token-usage.md", "secrets-handling.md", "README.md", "run.sh", "keyboard.md", "tokenizer.py", "monkey.txt"]) {
      expect(isSecretFileName(name), name).toBe(false);
    }
  });
});

describe("mirroring a skill library", () => {
  it("copies skill folders into the mirror and never writes to the source", () => {
    const from = join(dir, "from");
    const to = join(dir, "mirror");
    for (const [rel, text] of Object.entries({
      "web/DESCRIPTION.md": "Web skills.\n",
      "web/scrape/SKILL.md": skill("scrape"),
      "web/scrape/references/notes.md": "notes\n",
      "plain/SKILL.md": skill("plain"),
    })) { mkdirSync(dirname(join(from, rel)), { recursive: true }); writeFileSync(join(from, rel), text); }
    const before = snapshot(from);
    chmodSync(from, 0o555);
    try {
      const result = mirrorSkillTree(from, to);
      expect(result.copied).toBe(4);
      expect(readFileSync(join(to, "web/scrape/references/notes.md"), "utf8")).toBe("notes\n");
      expect(readFileSync(join(to, "plain/SKILL.md"), "utf8")).toBe(skill("plain"));
    } finally {
      chmodSync(from, 0o755);
    }
    expect(snapshot(from)).toEqual(before);
  });

  it("leaves credential files, dot folders, links and oversized files behind and says so", () => {
    const from = join(dir, "from");
    const files: Record<string, string> = {
      "a/SKILL.md": skill("a"),
      "a/.env": "TOKEN=x\n",
      "a/client_secret.json": "{}",
      "a/server.pem": "pem",
      ".archive/old/SKILL.md": skill("old"),
      "a/scripts/run.sh": "echo hi\n",
    };
    for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(from, rel)), { recursive: true }); writeFileSync(join(from, rel), text); }
    writeFileSync(join(from, "a/big.bin"), Buffer.alloc(3 * 1024 * 1024));
    symlinkSync("/etc/hostname", join(from, "a/link.txt"));
    const to = join(dir, "mirror");
    const result = mirrorSkillTree(from, to, { maxFileBytes: 2 * 1024 * 1024 });
    expect(existsSync(join(to, "a/SKILL.md"))).toBe(true);
    expect(existsSync(join(to, "a/scripts/run.sh"))).toBe(true);
    for (const rel of ["a/.env", "a/client_secret.json", "a/server.pem", ".archive", "a/big.bin", "a/link.txt"]) {
      expect(existsSync(join(to, rel)), rel).toBe(false);
    }
    expect(result.excluded.map((entry) => entry.path).sort()).toEqual(["a/.env", "a/big.bin", "a/client_secret.json", "a/link.txt", "a/server.pem"]);
    expect(result.excluded.find((entry) => entry.path === "a/.env")?.reason).toMatch(/credential/);
  });

  it("removes mirror entries the source dropped, but only inside a mirror it created", () => {
    const from = join(dir, "from");
    const to = join(dir, "mirror");
    mkdirSync(join(from, "keep"), { recursive: true });
    mkdirSync(join(from, "drop"), { recursive: true });
    writeFileSync(join(from, "keep/SKILL.md"), skill("keep"));
    writeFileSync(join(from, "drop/SKILL.md"), skill("drop"));
    mirrorSkillTree(from, to);
    rmSync(join(from, "drop"), { recursive: true });
    const second = mirrorSkillTree(from, to);
    expect(second.removed).toBe(1);
    expect(existsSync(join(to, "drop"))).toBe(false);
    expect(existsSync(join(to, "keep/SKILL.md"))).toBe(true);
    // a folder that was not made by a mirror is refused, not emptied
    const stranger = join(dir, "stranger");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "precious.txt"), "mine");
    expect(() => mirrorSkillTree(from, stranger)).toThrow(/not a skill mirror/);
    expect(readFileSync(join(stranger, "precious.txt"), "utf8")).toBe("mine");
  });

  it("refuses a destination inside the source", () => {
    const from = join(dir, "from");
    mkdirSync(from);
    expect(() => mirrorSkillTree(from, join(from, "mirror"))).toThrow(/inside/);
    expect(lstatSync(from).isDirectory()).toBe(true);
  });
});

describe("conversion on import", () => {
  it("leaves a proper SKILL.md byte for byte", () => {
    const text = skill("fine", "A fine skill.", "# fine\n", "platforms: [macos]\n");
    expect(normalizeSkillMd(text, "fine")).toEqual({ text, notes: [] });
  });

  it("folds a block-scalar description onto one line", () => {
    const text = "---\nname: wrapped\ndescription: |\n  First line of it.\n  Second line.\n---\n\nbody\n";
    const result = normalizeSkillMd(text, "wrapped");
    expect(result.text).toContain("description: First line of it. Second line.\n");
    expect(result.text.endsWith("\nbody\n")).toBe(true);
    expect(result.notes).toEqual(["description folded onto one line"]);
    for (const marker of [">", ">-", "|-"]) {
      const variant = `---\nname: w\ndescription: ${marker}\n  one\n  two\n---\nb\n`;
      expect(normalizeSkillMd(variant, "w").text).toContain("description: one two\n");
    }
  });

  it("takes the folder name when the frontmatter has none, and slugs an unusable one", () => {
    const missing = normalizeSkillMd("---\ndescription: No name here.\n---\nbody\n", "from-folder");
    expect(missing.text).toContain("name: from-folder\n");
    expect(missing.notes).toEqual(["name taken from the folder"]);
    const messy = normalizeSkillMd("---\nname: My_Skill Name\ndescription: x\n---\nbody\n", "ignored");
    expect(messy.text).toContain("name: my-skill-name\n");
    expect(messy.notes).toEqual(["name rewritten to my-skill-name"]);
  });

  it("builds a description from the first paragraph when a skill has frontmatter without one", () => {
    const result = normalizeSkillMd("---\nname: bare\n---\n\n# Bare\n\nDoes the bare thing well.\n", "bare");
    expect(result.text).toContain("description: Does the bare thing well.\n");
    expect(result.notes).toEqual(["description taken from the first paragraph"]);
  });
});

describe("what a skill depends on", () => {
  it("flags Luna and Hermes-only references with the reason, not a quote", () => {
    const reasons = (text: string) => detectLunaDependence("some-skill", text);
    expect(reasons("Read /home/shado/notes.")).toEqual(["a path under /home/shado (Luna)"]);
    expect(reasons("Config lives in ~/.hermes/config.yaml")).toEqual(["the Hermes home directory"]);
    expect(reasons("Set HERMES_HOME first")).toEqual(["the Hermes home directory"]);
    expect(reasons("Run:\n  hermes gateway restart\n")).toEqual(["the hermes command"]);
    expect(reasons("ssh to Luna and look")).toEqual(["Luna, the Hermes host"]);
    expect(reasons("browse via http://10.69.42.113:9377")).toEqual(["a service on the home network (10.69.42.x)"]);
    expect(detectLunaDependence("hermes-themes", "Themes.")).toEqual(["a Hermes-only skill (hermes-themes)"]);
    expect(detectLunaDependence("hermes-desktop-plugins", "Plugins.")).toEqual(["a Hermes-only skill (hermes-desktop-plugins)"]);
    expect(reasons("Search the web with the fetch tool.")).toEqual([]);
    expect(reasons("A lunar eclipse and a lunatic.")).toEqual([]);
  });
});

describe("secret literals in skill text", () => {
  it("names the kind of literal and never carries it", () => {
    const text = `Use ${FAKE_SK} here.\nAuthorization: Bearer ${"Zz9_".repeat(8)}\ntoken: ${FAKE_GH}\napi_key = "${"Q7w3".repeat(6)}"\n-----BEGIN PRIVATE KEY-----\n`;
    const found = detectSecretLiterals(text);
    expect(found).toEqual(["an API key (sk-…)", "a bearer token", "a GitHub token", "a key or token assigned a literal value", "a private key block"]);
    expect(JSON.stringify(found)).not.toContain(FAKE_SK);
  });

  it("lets placeholders and key names through", () => {
    for (const text of [
      "export API_KEY=<your key>",
      "api_key: ${API_KEY}",
      "token: $TOKEN",
      "apiKey = YOUR_API_KEY_HERE_PLEASE_X",
      "Authorization: Bearer $TOKEN_VALUE_FROM_ENV_VAR",
      "use sk-xxxxxxxxxxxxxxxxxxxxxxxx as the format",
      "The key lives in MCP_GATEWAY_KEY in ~/ai/.env.",
      "password: changeme-changeme-changeme",
    ]) expect(detectSecretLiterals(text), text).toEqual([]);
  });
});

describe("the catalog of skill sources", () => {
  const tree = () => {
    write("hermes/web/DESCRIPTION.md", "Browsing and scraping skills.\n");
    write("hermes/web/scrape/SKILL.md", skill("scrape", "Scrape a page."));
    write("hermes/web/scrape/references/api.md", "ref\n");
    write("hermes/research/DESCRIPTION.md", "Research skills.\n");
    write("hermes/research/papers/SKILL.md", skill("papers", "Find papers."));
    write("hermes/research/deep/dive/SKILL.md", skill("dive", "Dive deep."));
    write("hermes/brainstorming/SKILL.md", skill("brainstorming", "Brainstorm."));
    write("hermes/hermes-themes/SKILL.md", skill("hermes-themes", "Theme the Hermes UI."));
    write("hermes/devops/box/SKILL.md", skill("box", "Operate the box.", "Edit /home/shado/box.yaml\n"));
    write("hermes/.archive/old/SKILL.md", skill("old"));
    write("hermes/leaky/SKILL.md", skill("leaky", "Has a key.", `Use ${FAKE_SK}\n`));
    write("shared/index.md", "index\n");
    write("shared/checkpoint/SKILL.md", skill("checkpoint", "Save state."));
    write("shared/instagram-ops/SKILL.md", skill("instagram", "Instagram ops."));
    write("shared/brainstorming/SKILL.md", skill("brainstorming", "A different brainstorm."));
    write("shared/shell/SKILL.md", "---\nname: shell\ndescription: |\n  Run shell\n  commands.\n---\nbody\n");
    return buildSkillSourceCatalog(dir, [{ id: "hermes", label: "Hermes" }, { id: "shared", label: "Shared" }]);
  };

  it("walks category folders down to their skills and reads each category's description", () => {
    const catalog = tree();
    const byName = Object.fromEntries(catalog.skills.map((entry) => [`${entry.source}:${entry.name}`, entry]));
    expect(byName["hermes:scrape"]).toMatchObject({ category: "web", categoryDescription: "Browsing and scraping skills.", relPath: "web/scrape", description: "Scrape a page.", supportingFiles: ["references/api.md"] });
    expect(byName["hermes:dive"]).toMatchObject({ category: "research/deep", relPath: "research/deep/dive" });
    expect(byName["hermes:brainstorming"]).toMatchObject({ category: "", relPath: "brainstorming" });
    expect(byName["shared:instagram"]).toMatchObject({ relPath: "instagram-ops" });
    expect(catalog.skills.some((entry) => entry.name === "old")).toBe(false);
    expect(catalog.sources.map((source) => [source.id, source.count])).toEqual([["hermes", 7], ["shared", 4]]);
  });

  it("flags Luna dependence, secret literals, conversions and cross-source duplicates", () => {
    const byKey = Object.fromEntries(tree().skills.map((entry) => [`${entry.source}:${entry.name}`, entry]));
    expect(byKey["hermes:hermes-themes"]!.lunaDependent).toEqual(["a Hermes-only skill (hermes-themes)"]);
    expect(byKey["hermes:box"]!.lunaDependent).toEqual(["a path under /home/shado (Luna)"]);
    expect(byKey["hermes:scrape"]!.lunaDependent).toEqual([]);
    expect(byKey["hermes:leaky"]!.secretLiterals).toEqual(["an API key (sk-…)"]);
    expect(JSON.stringify(byKey["hermes:leaky"])).not.toContain(FAKE_SK);
    expect(byKey["shared:shell"]!.converted).toEqual(["description folded onto one line"]);
    expect(byKey["shared:brainstorming"]!.duplicateOf).toBe("hermes");
    expect(byKey["hermes:brainstorming"]!.duplicateOf).toBeUndefined();
  });

  it("reads a missing source as empty", () => {
    const catalog = buildSkillSourceCatalog(join(dir, "nowhere"), [{ id: "hermes", label: "Hermes" }]);
    expect(catalog).toEqual({ root: join(dir, "nowhere"), sources: [{ id: "hermes", label: "Hermes", count: 0, present: false }], skills: [] });
  });
});

describe("importing into the library", () => {
  const library = () => join(dir, "library");
  const fill = () => {
    write("src/hermes/web/scrape/SKILL.md", skill("scrape", "Scrape a page."));
    write("src/hermes/web/scrape/references/api.md", "ref\n");
    write("src/hermes/ops/box/SKILL.md", skill("box", "Operate the box.", "See /home/shado/x\n"));
    write("src/hermes/leaky/SKILL.md", skill("leaky", "Has a key.", `Use ${FAKE_SK}\n`));
    write("src/shared/checkpoint/SKILL.md", "---\nname: checkpoint\ndescription: >-\n  Save\n  state.\n---\nbody\n");
    write("src/shared/scrape/SKILL.md", skill("scrape", "Same name, other bytes."));
    return buildSkillSourceCatalog(join(dir, "src"), [{ id: "hermes", label: "Hermes" }, { id: "shared", label: "Shared" }]);
  };

  it("lands clean skills disabled, with provenance, and holds flagged ones back", () => {
    const result = importSkillSources(fill(), { all: true }, library());
    expect(result.imported.sort()).toEqual(["checkpoint", "scrape"]);
    expect(result.held.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "box", source: "hermes", reason: "lunaDependent" },
      { name: "leaky", source: "hermes", reason: "secretLiteral" },
    ]);
    expect(result.conflicts).toEqual([{ name: "scrape", source: "shared", keptFrom: "hermes" }]);
    const listed = Object.fromEntries(listLibrarySkills(library()).map((entry) => [entry.name, entry]));
    expect(listed.scrape).toMatchObject({ enabled: false, source: "hermes:web/scrape", skippedFiles: ["references/api.md"], tags: expect.arrayContaining(["hermes", "web"]) });
    expect(listed.checkpoint).toMatchObject({ enabled: false, source: "shared:checkpoint" });
    expect(listed.checkpoint!.warnings.join(" ")).toContain("description folded onto one line");
    expect(readLibrarySkillFile("checkpoint", library())).toContain("description: Save state.");
  });

  it("imports a flagged skill only when it is named, with its flags attached as warnings", () => {
    const catalog = fill();
    const result = importSkillSources(catalog, { names: ["box"], include: ["box"] }, library());
    expect(result.imported).toEqual(["box"]);
    const box = listLibrarySkills(library()).find((entry) => entry.name === "box")!;
    expect(box.enabled).toBe(false);
    expect(box.warnings.join(" ")).toContain("Needs Hermes or Luna: a path under /home/shado (Luna)");
    expect(box.tags).toContain("luna-only");
    // a secret-literal skill needs its own review acknowledgement
    expect(importSkillSources(catalog, { names: ["leaky"], include: ["leaky"] }, library()).held).toEqual([{ name: "leaky", source: "hermes", reason: "secretLiteral" }]);
    const reviewed = importSkillSources(catalog, { names: ["leaky"], include: ["leaky"], reviewedSecrets: ["leaky"] }, library());
    expect(reviewed.imported).toEqual(["leaky"]);
    expect(listLibrarySkills(library()).find((entry) => entry.name === "leaky")!.warnings.join(" ")).toContain("may contain an API key (sk-…) — review before enabling");
    expect(JSON.stringify(listLibrarySkills(library()))).not.toContain(FAKE_SK);
  });

  it("is idempotent, and reports a changed source instead of overwriting", () => {
    const catalog = fill();
    importSkillSources(catalog, { all: true }, library());
    const again = importSkillSources(catalog, { all: true }, library());
    expect(again.imported).toEqual([]);
    expect(again.unchanged.sort()).toEqual(["checkpoint", "scrape"]);
    write("src/hermes/web/scrape/SKILL.md", skill("scrape", "Scrape a page, better."));
    const changed = importSkillSources(buildSkillSourceCatalog(join(dir, "src"), [{ id: "hermes", label: "Hermes" }]), { all: true }, library());
    expect(changed.changed).toEqual(["scrape"]);
    expect(listLibrarySkills(library()).find((entry) => entry.name === "scrape")!.description).toBe("Scrape a page.");
  });
});
