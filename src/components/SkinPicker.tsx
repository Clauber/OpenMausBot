// Works because styles.css keys skins on [data-skin], not :root[data-skin], so any element opens a skin context for its
// subtree.
import { useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { SKINS, applySkin, readSkin } from "@/lib/skins";
import { customSkinAttr } from "@/lib/custom-skins";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { setDressUp, useDressUp } from "@/lib/halloween-dress";
import type { HalloweenBodyId } from "../../shared/halloween-bodies";
import { MausAvatar } from "./Avatar";
import { Switch } from "./SettingsPrimitives";
import { Miniature } from "./SkinPickerMiniature";
import { CustomSkinEditor } from "./CustomSkinEditor";
import type { CustomSkin } from "../../shared/skin-recipe";

function customTagline(skin: CustomSkin): string {
  if (skin.tagline) return skin.tagline;
  return skin.createdBy ? t("settings.skin.custom.madeBy", { name: skin.createdBy.name }) : t("settings.skin.custom.fallbackTagline");
}

const DRESS_UP_PREVIEW: ReadonlyArray<[HalloweenBodyId, "orange" | "purple" | "teal" | "red"]> = [
  ["pumpkin", "orange"],
  ["ghost", "purple"],
  ["witch", "teal"],
  ["bat", "red"],
];

export function DressUpRow() {
  const dressed = useDressUp();
  const title = t("settings.skin.dressUp.title");
  return (
    <div data-dress-up className="mt-4 flex items-center gap-4 rounded-xl border border-accent-border/40 bg-accent/[0.06] p-3">
      <div className="flex shrink-0 -space-x-1.5" aria-hidden="true">
        {DRESS_UP_PREVIEW.map(([body, color]) => (
          <MausAvatar key={body} color={color} bodyId={body} size={30} animated={false} trackPointer={false} />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.skin.dressUp.subtitle")}</div>
      </div>
      <Switch checked={dressed} aria-label={title} onClick={() => setDressUp(!dressed)} />
    </div>
  );
}

export function SkinPicker() {
  // SAFETY: main.tsx writes data-skin from applySkin() before the first paint; readSkin() covers it missing.
  const [active, setActive] = useState<string>(
    () => document.documentElement.dataset.skin || readSkin(),
  );
  const { state } = useStore();
  // The mocked stores in tests build states by hand; absence means "none yet".
  const customSkins = state.customSkins ?? [];
  const [editing, setEditing] = useState<{ skin: CustomSkin | null } | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const pick = (value: string) => {
    applySkin(value);
    setActive(value);
  };

  const remove = async (id: string) => {
    if (armedDelete !== id) {
      setArmedDelete(id);
      return;
    }
    setArmedDelete(null);
    try {
      await api(`/api/skins/${id}`, { method: "DELETE" });
      // The frame bumps the peripheral and the store refetches; if this was
      // the active skin, the store's sync effect falls back to the default.
      setDeleteError(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SKINS.map((skin) => {
          const selected = skin.id === active;
          return (
            <button
              key={skin.id}
              type="button"
              onClick={() => pick(skin.id)}
              aria-pressed={selected}
              className={cn(
                "cursor-pointer flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                selected
                  ? "border-accent-border bg-control"
                  : "border-hairline/60 hover:border-hairline hover:bg-control/50",
              )}
            >
              <Miniature skin={skin.id} />
              <div className="flex items-start gap-1.5 px-0.5 pb-0.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{skin.name}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                    {skin.tagline}
                  </div>
                </div>
                {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
              </div>
            </button>
          );
        })}
      </div>
      {active === "halloween" && <DressUpRow />}

      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-medium text-ink">{t("settings.skin.custom.title")}</div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {customSkins.map((skin) => {
          const value = customSkinAttr(skin.id);
          const selected = value === active;
          return (
            <div
              key={skin.id}
              className={cn(
                "group relative flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                selected
                  ? "border-accent-border bg-control"
                  : "border-hairline/60 hover:border-hairline hover:bg-control/50",
              )}
            >
              <button
                type="button"
                onClick={() => pick(value)}
                aria-pressed={selected}
                className="flex flex-col gap-2 text-left"
              >
                <Miniature skin={value} />
                <div className="flex items-start gap-1.5 px-0.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{skin.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-secondary">
                      {customTagline(skin)}
                    </div>
                  </div>
                  {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
                </div>
              </button>
              <div className="absolute right-1.5 top-1.5 flex gap-1 rounded-lg bg-panel/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                <button
                  type="button"
                  aria-label={t("settings.skin.custom.edit", { name: skin.name })}
                  title={t("settings.skin.custom.edit", { name: skin.name })}
                  onClick={() => setEditing({ skin })}
                  className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  aria-label={armedDelete === skin.id ? t("settings.skin.custom.deleteConfirm") : t("settings.skin.custom.delete", { name: skin.name })}
                  title={armedDelete === skin.id ? t("settings.skin.custom.deleteConfirm") : t("settings.skin.custom.delete", { name: skin.name })}
                  onClick={() => void remove(skin.id)}
                  onBlur={() => setArmedDelete(null)}
                  className={cn(
                    "rounded-md p-1 hover:bg-raised",
                    armedDelete === skin.id ? "bg-danger text-danger-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setEditing({ skin: null })}
          className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-hairline/70 p-2 text-ink-secondary transition-colors hover:border-hairline hover:bg-control/50 hover:text-ink"
        >
          <Plus size={18} />
          <span className="text-[12px] font-medium">{t("settings.skin.custom.new")}</span>
        </button>
      </div>
      {deleteError && <div className="text-[12px] text-danger">{deleteError}</div>}

      {editing && (
        <CustomSkinEditor
          skin={editing.skin}
          onClose={() => setEditing(null)}
          onPreview={pick}
        />
      )}
    </div>
  );
}
