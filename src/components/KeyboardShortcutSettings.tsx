import { useState } from "react";
import { t } from "@/lib/i18n";
import { bindingConflict, isMacPlatform, parseShortcutBinding, setShortcutBinding, SHORTCUT_GROUPS, shortcutKeysForPlatform, useShortcutBindings, type ShortcutItem } from "@/lib/keyboard-shortcuts";
import { Card } from "./SettingsPrimitives";

function ShortcutEditor({ item }: { item: ShortcutItem }) {
  const bindings = useShortcutBindings();
  const isMac = isMacPlatform();
  const keys = shortcutKeysForPlatform(item, isMac);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const save = (reset = false) => {
    const next = reset ? (isMac ? item.macKeys : item.winKeys) : parseShortcutBinding(draft, item.id, isMac);
    if (!next) { setError(t("settings.shortcuts.invalid")); return; }
    const conflict = bindingConflict(item.id, next, bindings, isMac);
    if (conflict) { setError(t("settings.shortcuts.conflict", { action: conflict.description })); return; }
    setShortcutBinding(item.id, reset ? null : next, isMac);
    setEditing(false);
    setError("");
  };
  return <div className="border-b border-hairline/40 py-3 last:border-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 text-[13px] text-ink">{item.description}
        <span className="mt-1 block text-[11px] text-ink-secondary">{t(item.rebindable ? "settings.shortcuts.editable" : "settings.shortcuts.fixed")}</span>
      </div>
      <kbd className="rounded border border-hairline/50 bg-control px-2 py-1 text-[12px] text-ink">{keys.join(" + ")}</kbd>
      {item.rebindable && <button type="button" className="ui-button" aria-label={t("settings.shortcuts.editAction", { action: item.description })}
        onClick={() => { setDraft(keys.join("+")); setError(""); setEditing(true); }}>{t("settings.shortcuts.edit")}</button>}
    </div>
    {editing && <form data-shortcut-editor className="mt-3 flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); save(); }}>
      <input autoFocus aria-label={t("settings.shortcuts.bindingAction", { action: item.description })} value={draft} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); } }}
        className="min-w-0 rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink" />
      <button type="submit" className="ui-button">{t("settings.shortcuts.save")}</button>
      <button type="button" className="ui-button" onClick={() => save(true)}>{t("settings.shortcuts.reset")}</button>
      <button type="button" className="ui-button" onClick={() => { setEditing(false); setError(""); }}>{t("settings.shortcuts.cancel")}</button>
      {(item.id === "jump-bot" || item.id === "switch-bot") && <p className="w-full text-[12px] text-ink-secondary">{t(item.id === "jump-bot" ? "settings.shortcuts.digits" : "settings.shortcuts.pair")}</p>}
    </form>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </div>;
}

export function KeyboardShortcutSettings() {
  return <>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("settings.shortcuts.subtitle")}</p>
    {SHORTCUT_GROUPS.map(group => <Card key={group.category} title={group.category}>
      {group.items.map(item => <ShortcutEditor key={item.id} item={item} />)}
    </Card>)}
  </>;
}
