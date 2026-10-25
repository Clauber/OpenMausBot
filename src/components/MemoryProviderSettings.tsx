// Settings → General → Semantic memory. An optional provider behind markdown
// recall; off by default. The key is write-only: the server reports
// stored-or-not and the name of the variable it lives under, never the value.
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

const KINDS = ["generic-openai-embeddings", "supermemory", "serenity"] as const;
type Kind = (typeof KINDS)[number];

export function MemoryProviderSettings() {
  const { state, dispatch } = useStore();
  const status = state.config?.memoryProvider;
  const [kind, setKind] = useState<Kind | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownKind: Kind = kind ?? status?.kind ?? "generic-openai-embeddings";
  const shownUrl = url ?? status?.url ?? "";
  const shownModel = model ?? status?.model ?? "";
  const draftKey = key.trim();

  const put = async (memoryProvider: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      dispatch({ type: "configStatus", config: await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ memoryProvider }) }) });
      setKey("");
      setKind(null);
      setUrl(null);
      setModel(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = () => put({ kind: shownKind, url: shownUrl.trim(), model: shownModel.trim(), ...(draftKey ? { key: draftKey } : {}) });
  const field = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none";

  return (
    <Card title={t("memoryProvider.title")} subtitle={t("memoryProvider.subtitle")}>
      <SettingRow title={t("memoryProvider.enable")}>
        <Switch
          data-testid="memory-provider-enabled"
          aria-label={t("memoryProvider.enable")}
          checked={status?.enabled ?? false}
          disabled={busy || !state.config}
          onClick={() => void put({ enabled: !(status?.enabled ?? false) })}
          className="cursor-pointer"
        />
      </SettingRow>
      <div className="mt-2 flex flex-col gap-2">
        <select
          data-testid="memory-provider-kind"
          aria-label={t("memoryProvider.kind")}
          value={shownKind}
          onChange={(event) => setKind(event.target.value as Kind)}
          className={field}
        >
          {KINDS.map((k) => <option key={k} value={k}>{t(`memoryProvider.kind.${k}`)}</option>)}
        </select>
        <input
          data-testid="memory-provider-url"
          aria-label={t("memoryProvider.url")}
          value={shownUrl}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t("memoryProvider.urlPlaceholder")}
          spellCheck={false}
          className={field}
        />
        <input
          data-testid="memory-provider-model"
          aria-label={t("memoryProvider.model")}
          value={shownModel}
          onChange={(event) => setModel(event.target.value)}
          placeholder="text-embedding-3-small"
          spellCheck={false}
          className={field}
        />
        <div role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", status?.keyConfigured ? "bg-success" : "bg-raised-hover")} />
          {status?.keyConfigured ? t("memoryProvider.keyStored") : t("memoryProvider.keyNone")}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            data-testid="memory-provider-key"
            aria-label={t("memoryProvider.key")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={t("memoryProvider.keyPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className={field}
          />
          <button
            type="button"
            data-testid="memory-provider-save"
            onClick={() => void save()}
            disabled={busy}
            className="flex w-[72px] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("memoryProvider.save")}</>}
          </button>
          {status?.keyConfigured && (
            <button
              type="button"
              data-testid="memory-provider-remove-key"
              onClick={() => void put({ key: "" })}
              disabled={busy}
              className="shrink-0 cursor-pointer rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-danger hover:bg-raised/50 disabled:opacity-50"
            >
              {t("memoryProvider.removeKey")}
            </button>
          )}
        </div>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>
    </Card>
  );
}
