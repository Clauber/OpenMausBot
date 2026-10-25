// Z.ai sign-in through the instance's own ZCode server. The server's OAuth service owns the login and keeps
// the tokens in its data folder; nothing here reads, stores or returns one. Every message is a fixed string.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../../contracts.ts";
import type { ZcodeChannelClient } from "./channel.ts";

export type WithZcodeClient = <T>(use: (client: ZcodeChannelClient) => Promise<T>) => Promise<T>;

const INDIVIDUAL_PROVIDER = "account:zai-individual-coding-plan";
const START_PROVIDER = "account:zai-start-plan";
const DEFAULT_TTL_MS = 300_000;
const FAILED = "Z.ai sign-in failed. Start again.";
const EXPIRED = "Z.ai sign-in expired. Start again.";
const CANCELLED = "Z.ai sign-in was cancelled.";

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

/** The plan connection to activate after sign-in. Individual keeps Start Plan usable too; an account with only Start Plan needs that one. */
export function chooseZcodeConnection(providerSettingsView: unknown): "individual-coding-plan" | "start-plan" | null {
  const providers = field(providerSettingsView, "providers");
  const entitled = (providerId: string) =>
    Array.isArray(providers) && providers.some((provider) => field(provider, "providerId") === providerId && field(field(provider, "accountState"), "entitled") === true);
  if (entitled(INDIVIDUAL_PROVIDER)) return "individual-coding-plan";
  return entitled(START_PROVIDER) ? "start-plan" : null;
}

/** Whether the data folder holds a Z.ai login. Reads key names only, so it never starts the server or touches a token. ZCode and its ZCodium fork keep the file in different folders. */
export async function zcodeServerAuthStatus(dataDir: string): Promise<{ authenticated: boolean }> {
  for (const folder of [".zcode", ".zcodium"]) {
    try {
      const keys = JSON.parse(await readFile(join(dataDir, folder, "v2", "credentials.json"), "utf8")) as unknown;
      if (typeof field(keys, "oauth:zai:access_token") === "string") return { authenticated: true };
    } catch {
      // A missing or unreadable file means no login in that folder.
    }
  }
  return { authenticated: false };
}

interface Flow {
  id: string;
  authorizationUrl: string;
  expiresAt: number;
  phase: ProviderAuthenticationStatus["phase"];
  message?: string;
  checking?: Promise<void>;
}

export class ZcodeServerAuth {
  readonly #withClient: WithZcodeClient;
  readonly #refresh: () => Promise<void>;
  readonly #ttlMs: number;
  #flow: Flow | null = null;
  #starting: Promise<ProviderAuthenticationStart> | null = null;

  constructor(options: { withClient: WithZcodeClient; refresh: () => Promise<void>; ttlMs?: number }) {
    this.#withClient = options.withClient;
    this.#refresh = options.refresh;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  start(): Promise<ProviderAuthenticationStart> {
    this.#starting ??= this.#begin().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #begin(): Promise<ProviderAuthenticationStart> {
    const waiting = (flow: Flow): ProviderAuthenticationStart => ({ phase: "waiting", flowId: flow.id, authorizationUrl: flow.authorizationUrl, expiresAt: new Date(flow.expiresAt).toISOString() });
    const current = this.#flow;
    if (current?.phase === "waiting") {
      if (Date.now() < current.expiresAt) return waiting(current);
      await this.#expire(current);
    }
    const url = await this.#withClient(async (client) => {
      const started = await client.call("oauth", "startOAuthWithPolling", ["zai"]);
      const authorizeUrl = field(started, "authorizeUrl");
      if (typeof authorizeUrl !== "string" || !URL.canParse(authorizeUrl) || new URL(authorizeUrl).protocol !== "https:") return null;
      return authorizeUrl;
    }).catch(() => null);
    if (url === null) throw new Error("Z.ai sign-in could not start. Try again.");
    const flow: Flow = { id: crypto.randomUUID(), authorizationUrl: url, expiresAt: Date.now() + this.#ttlMs, phase: "waiting" };
    this.#flow = flow;
    return waiting(flow);
  }

  async status(flowId: string): Promise<ProviderAuthenticationStatus> {
    const flow = this.#flow;
    if (flow === null || flow.id !== flowId) return { phase: "failed", flowId, authorizationUrl: null, expiresAt: null, message: FAILED };
    if (flow.phase === "waiting") {
      if (Date.now() >= flow.expiresAt) await this.#expire(flow);
      else await (flow.checking ??= this.#poll(flow).finally(() => { flow.checking = undefined; }));
    }
    return this.#view(flow);
  }

  async cancel(): Promise<void> {
    const flow = this.#flow;
    if (flow?.phase !== "waiting") return;
    flow.phase = "cancelled";
    flow.message = CANCELLED;
    await this.#cancelPending();
  }

  async signOut(): Promise<void> {
    await this.cancel();
    try {
      await this.#withClient((client) => client.call("oauth", "logout", ["zai"]));
    } catch {
      throw new Error("Could not sign out of Z.ai. Try again.");
    }
    this.#flow = null;
    await this.#refresh().catch(() => {});
  }

  #view(flow: Flow): ProviderAuthenticationStatus {
    const waiting = flow.phase === "waiting";
    return {
      phase: flow.phase,
      flowId: flow.id,
      authorizationUrl: waiting ? flow.authorizationUrl : null,
      expiresAt: new Date(flow.expiresAt).toISOString(),
      ...(flow.message === undefined ? {} : { message: flow.message }),
    };
  }

  async #expire(flow: Flow): Promise<void> {
    flow.phase = "expired";
    flow.message = EXPIRED;
    await this.#cancelPending();
  }

  async #cancelPending(): Promise<void> {
    await this.#withClient((client) => client.call("oauth", "cancelPending", ["zai"])).catch(() => {});
  }

  async #poll(flow: Flow): Promise<void> {
    try {
      const approved = await this.#withClient(async (client) => {
        if (field(await client.call("oauth", "pollPendingOAuth", ["zai"]), "kind") !== "session") return false;
        await this.#activateConnection(client);
        return true;
      });
      // A cancel or expiry that landed while the poll was in flight stays final.
      if (approved && flow.phase === "waiting") flow.phase = "succeeded";
    } catch {
      if (flow.phase === "waiting") {
        flow.phase = "failed";
        flow.message = FAILED;
      }
      return;
    }
    if (flow.phase === "succeeded") await this.#refresh().catch(() => {});
  }

  /** Selects the plan connection once so every plan the account holds is usable at the same time. */
  async #activateConnection(client: ZcodeChannelClient): Promise<void> {
    await client.call("provider-settings", "refresh", ["signed-in"]);
    const kind = chooseZcodeConnection(await client.call("provider-settings", "getView"));
    if (kind === null) return;
    const current = await client.call("setting", "get");
    const stored = field(current, "providerFamilyConnectionSelections");
    const selections: Record<string, unknown> = stored !== null && typeof stored === "object" ? { ...stored } : {};
    if (field(selections.zai, "kind") === kind) return;
    const domain = field(current, "providerFamilyDomain");
    const updatedAt = field(current, "providerFamilyDomainUpdatedAt");
    // The write is a compare-and-swap against what was just read.
    const expected = {
      ...(typeof domain === "string" ? { providerFamilyDomain: domain } : {}),
      providerFamilyConnectionSelections: selections,
      providerFamilyDomainUpdatedAt: typeof updatedAt === "number" ? updatedAt : 0,
    };
    await client.call("setting", "update", [
      { providerFamilyDomain: "zai", providerFamilyConnectionSelections: { ...selections, zai: { kind } } },
      expected,
    ]);
  }
}
