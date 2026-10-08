import { defineConfig } from "vitest/config";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testTmp = join(tmpdir(), "stealth-browser-tests");
mkdirSync(testTmp, { recursive: true });
mkdirSync(join(testTmp, "state"), { recursive: true });
mkdirSync(join(testTmp, "profiles"), { recursive: true });
mkdirSync(join(testTmp, "recordings"), { recursive: true });

process.env.STATE_DIR = join(testTmp, "state");
process.env.PROFILES_DIR = join(testTmp, "profiles");
process.env.RECORDINGS_DIR = join(testTmp, "recordings");
process.env.CDP_PORT = "0";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
    setupFiles: ["tests/setup.ts"],
    env: {
      STATE_DIR: join(testTmp, "state"),
      PROFILES_DIR: join(testTmp, "profiles"),
      RECORDINGS_DIR: join(testTmp, "recordings"),
      CDP_PORT: "0", // random free port — avoids conflict with a running local server
    },
  },
});
