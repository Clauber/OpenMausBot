// ZCode server mode for one provider instance: the shared server, its sign-in and
// model catalog, and the turn transport. The driver (zcode.ts) asks this module for
// a transport and falls back to its own `zcode app-server` when there is none.
//
// One server serves every ZCode instance on this Legion. What stays per instance is
// the agent's HOME: the server passes the instance `identity` to the agent command,
// whose wrapper (agent-wrapper.ts) maps it to the same bot home the CLI path uses.
// The Z.ai login lives in the server's data folder, shared by all of them.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { DATA_DIR } from "../../config.ts";
import { stripWorkspaceCredentialEnv } from "../../credential-env.ts";
import { augmentedPath } from "../../env-path.ts";
import type { ModelCatalog, ProviderInstance } from "../../contracts.ts";
import type { ZcodeTransportHandlers } from "../zcode-transport.ts";
import { ZcodeServerAuth, zcodeServerAuthStatus, type WithZcodeClient } from "./auth.ts";
import { connectZcodeChannel } from "./channel.ts";
import { openServerTransport, type ZcodeServerTransport } from "./connection.ts";
import { ZcodeServerHost, type ZcodeServerLease } from "./host.ts";
import { detectZcodeServer, installZcodeServer, zcodeServerManagedInstallAvailable } from "./install.ts";
import { zcodeCatalogFromServerView } from "./models.ts";

const PROVIDERS_DIR = join(DATA_DIR, "providers", "zcode");
/** The server's own data folder: login, personal providers, sessions. Not a 64-hex instance folder. */
const SERVER_DATA_DIR = join(PROVIDERS_DIR, "server");

/** An operator override for where the official server bundle lives (a folder with bin/zcode). */
const configuredServerPath = () => process.env.OMB_ZCODE_SERVER_PATH?.trim() || undefined;

// The server's own launcher is a shell script that calls `dirname`, so a stripped PATH must still reach the system tools.
const withSystemPath = (path: string) => [path, ...["/usr/bin", "/bin"].filter((dir) => !path.split(delimiter).includes(dir))].join(delimiter);

const serverEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: withSystemPath(augmentedPath()) };
  stripWorkspaceCredentialEnv(env);
  return env;
};

let sharedHost: ZcodeServerHost | null = null;
let hostUsers = 0;

function acquireHost(): ZcodeServerHost {
  sharedHost ??= new ZcodeServerHost({
    resolveRoot: async () => {
      const found = await detectZcodeServer({ dataDir: DATA_DIR, configuredPath: configuredServerPath(), env: serverEnv() });
      if (!found) {
        throw new Error(zcodeServerManagedInstallAvailable()
          ? "The ZCode server is not installed. Install it from this engine's settings, or set OMB_ZCODE_SERVER_PATH."
          : "The ZCode server is not installed. Set OMB_ZCODE_SERVER_PATH to a ZCode server folder.");
      }
      return found.root;
    },
    dataDir: SERVER_DATA_DIR,
    botHomesRoot: PROVIDERS_DIR,
    env: serverEnv,
  });
  hostUsers += 1;
  return sharedHost;
}

async function releaseHost(): Promise<void> {
  hostUsers -= 1;
  if (hostUsers > 0 || !sharedHost) return;
  const host = sharedHost;
  sharedHost = null;
  await host.stopAll();
}

export interface ZcodeServerMode {
  /** Opens a turn's transport on the shared server; rejects when the server cannot be reached. */
  openTransport(options: { workspacePath: string; threadId: string }, handlers: ZcodeTransportHandlers): Promise<ZcodeServerTransport>;
  /** The server's model list, or null when the server cannot say. */
  readModels(): Promise<ModelCatalog | null>;
  /** Signed in to Z.ai on the server (reads key names from its data folder only). */
  signedIn(): Promise<boolean>;
  /** The instance members for install and Z.ai sign-in. */
  instanceMembers(): Pick<ProviderInstance, "installRuntime" | "startAuthentication" | "getAuthentication" | "cancelAuthentication" | "signOut" | "authenticationMethod">;
  dispose(): Promise<void>;
}

export function createZcodeServerMode(options: {
  /** Names this instance's bot home for the server's agent (see agent-wrapper.ts). */
  identity: string;
  /** This instance's merged personal provider config, copied into the server's data folder before it starts. */
  personalConfigPath: string | null;
  /** Runs after sign-in or sign-out so the instance's catalog follows the account. */
  onAccountChange: () => Promise<void>;
}): ZcodeServerMode {
  const host = acquireHost();
  let disposed = false;
  let copiedConfig: string | null = null;

  /** The server reads its personal providers from its data folder; keep it in step with this instance's merge. */
  const syncPersonalConfig = async () => {
    const source = options.personalConfigPath;
    if (!source) return;
    const content = await readFile(source, "utf8").catch(() => null);
    if (content === null || content === copiedConfig) return;
    const directory = join(SERVER_DATA_DIR, ".zcode", "v2");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(source, join(directory, "provider_config.json"));
    copiedConfig = content;
  };

  const acquire = async (): Promise<ZcodeServerLease> => {
    if (disposed) throw new Error("This provider was removed. Select an engine and send again.");
    await syncPersonalConfig();
    return host.acquire();
  };

  const withClient: WithZcodeClient = async (use) => {
    const lease = await acquire();
    try {
      const client = await connectZcodeChannel(lease.endpoint);
      try {
        return await use(client);
      } finally {
        client.close();
      }
    } finally {
      lease.release();
    }
  };

  const readModels = async (): Promise<ModelCatalog | null> => {
    const view = await withClient((client) => client.call("model-selection", "getView"));
    const catalog = zcodeCatalogFromServerView(view);
    return catalog.options.some((option) => option.id !== "agent-default") ? catalog : null;
  };

  // The link is relayed to a person who may not be at the machine: allow the long side of what the server keeps pending.
  const auth = new ZcodeServerAuth({ withClient, refresh: options.onAccountChange, ttlMs: 15 * 60_000 });

  return {
    openTransport: async ({ workspacePath, threadId }, handlers) => {
      const lease = await acquire();
      return openServerTransport({ endpoint: lease.endpoint, workspacePath, identity: options.identity, threadId, release: lease.release }, handlers);
    },
    readModels,
    signedIn: async () => (await zcodeServerAuthStatus(SERVER_DATA_DIR)).authenticated,
    instanceMembers: () => ({
      authenticationMethod: "browser-poll",
      startAuthentication: () => auth.start(),
      getAuthentication: (flowId) => auth.status(flowId),
      cancelAuthentication: () => auth.cancel(),
      signOut: () => auth.signOut(),
      ...(zcodeServerManagedInstallAvailable()
        ? { installRuntime: async () => { await installZcodeServer({ dataDir: DATA_DIR }); } }
        : {}),
    }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await auth.cancel().catch(() => {});
      await releaseHost();
    },
  };
}
