// Files a bot handed over in this conversation. Each file keeps every version
// it was written as; the dropdown picks which one to download.
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { t } from "@/lib/i18n";

interface ArtifactRow {
  id: string;
  name: string;
  version: number;
  size: number;
  url: string;
}

function ArtifactItem({ artifact }: { artifact: ArtifactRow }) {
  const [versions, setVersions] = useState<ArtifactRow[]>([artifact]);
  const [selected, setSelected] = useState(artifact.id);
  useEffect(() => {
    if (artifact.version < 2) return;
    let live = true;
    void fetch(`/api/artifacts/${artifact.id}/versions`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { versions?: ArtifactRow[] } | null) => { if (live && body?.versions) setVersions(body.versions); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [artifact.id, artifact.version]);
  const chosen = versions.find((v) => v.id === selected) ?? artifact;
  return <li className="flex items-center gap-2 border-t border-hairline/30 py-2 text-[12px]">
    <span className="min-w-0 flex-1 break-all font-medium text-ink">{artifact.name}</span>
    {versions.length > 1 && <select
      aria-label={t("inspector.artifacts.version")}
      value={selected}
      onChange={(event) => setSelected(event.target.value)}
      className="rounded-md border border-hairline/40 bg-inset px-1 py-0.5 text-[11px] text-ink"
    >
      {[...versions].reverse().map((v) => <option key={v.id} value={v.id}>
        {v.id === artifact.id ? t("inspector.artifacts.latest", { version: v.version }) : `v${v.version}`}
      </option>)}
    </select>}
    <a
      href={chosen.url}
      download={chosen.name}
      aria-label={t("inspector.artifacts.download", { name: chosen.name })}
      title={t("inspector.artifacts.download", { name: chosen.name })}
      className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
    ><Download size={14} /></a>
  </li>;
}

export function ArtifactsList({ threadId }: { threadId: string }) {
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  useEffect(() => {
    let live = true;
    void fetch(`/api/threads/${threadId}/artifacts`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { artifacts?: ArtifactRow[] } | null) => { if (live) setArtifacts(body?.artifacts ?? []); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [threadId]);
  if (artifacts.length === 0) return null;
  return <section aria-label={t("inspector.artifacts.title")} className="px-4 pb-4">
    <h3 className="pb-1 text-[12px] font-medium text-ink-secondary">{t("inspector.artifacts.title")}</h3>
    <ul>{artifacts.map((artifact) => <ArtifactItem key={artifact.id} artifact={artifact} />)}</ul>
  </section>;
}
