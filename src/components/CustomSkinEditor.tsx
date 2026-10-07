// The skin editor: a handful of taste parameters, a live miniature, and one
// save. Every value the user touches feeds shared/skin-recipe's derivation,
// which is what guarantees the result is readable — the editor never collects
// raw tokens, so it can never save an unreadable one. The draft renders under
// a synthetic id in its own <style> element (setDraftSkinStyle), so previewing
// never touches the saved collection or the active skin.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { setDraftSkinStyle } from "@/lib/custom-skins";
import { customSkinAttr, type CustomSkin, type SkinRecipe } from "../../shared/skin-recipe";
import { Miniature } from "./SkinPickerMiniature";

/** Never a server id (those come from randomUUID and never read 00000000). */
const DRAFT_ID = "cs-00000000";

const NEUTRAL_TINT = { dark: "#1b1410", light: "#f3ece2" };

interface DraftState {
  name: string;
  tagline: string;
  mode: SkinRecipe["mode"];
  accent: string;
  /** Empty string = neutral surfaces (the derivation's default). */
  tint: string;
  bubble: SkinRecipe["bubble"];
  corners: SkinRecipe["corners"];
}

function draftOf(skin: CustomSkin | null): DraftState {
  if (!skin) {
    return { name: "", tagline: "", mode: "dark", accent: "#6c8cff", tint: "", bubble: "match", corners: "soft" };
  }
  return {
    name: skin.name,
    tagline: skin.tagline,
    mode: skin.recipe.mode,
    accent: skin.recipe.accent,
    tint: skin.recipe.tint,
    bubble: skin.recipe.bubble,
    corners: skin.recipe.corners,
  };
}

function recipeOf(draft: DraftState): SkinRecipe {
  const tintNeutral = draft.mode === "dark" ? NEUTRAL_TINT.dark : NEUTRAL_TINT.light;
  return {
    mode: draft.mode,
    accent: draft.accent,
    tint: draft.tint || tintNeutral,
    bubble: draft.bubble,
    corners: draft.corners,
  };
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-lg border border-hairline/50 bg-inset p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-7 rounded-md px-3 text-[12px] font-medium transition-colors",
            option.value === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
      <span className="w-14 shrink-0">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="size-7 shrink-0 cursor-pointer rounded-md border border-hairline/50 bg-transparent p-0.5"
        aria-label={label}
      />
      <input
        type="text"
        value={value}
        onChange={(event) => {
          const text = event.target.value.trim().toLowerCase();
          if (/^#[0-9a-f]{0,6}$/.test(text)) onChange(text);
        }}
        onBlur={() => onChange(/^#[0-9a-f]{6}$/.test(value) ? value : "#808080")}
        className="w-20 rounded-md border border-hairline/40 bg-inset px-2 py-1 font-mono text-[12px] text-ink focus:border-focus"
        aria-label={`${label} hex`}
      />
    </label>
  );
}

export function CustomSkinEditor({ skin, onClose, onPreview }: {
  skin: CustomSkin | null;
  onClose: () => void;
  /** Called with the saved skin's attribute so the person can see it applied. */
  onPreview?: (attr: string) => void;
}) {
  const [draft, setDraft] = useState<DraftState>(() => draftOf(skin));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const recipe = recipeOf(draft);
  useEffect(() => {
    setDraftSkinStyle(DRAFT_ID, recipe);
    return () => setDraftSkinStyle(DRAFT_ID, null);
  }, [recipe.mode, recipe.accent, recipe.tint, recipe.bubble, recipe.corners]);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      let saved: CustomSkin;
      if (skin) {
        const r = await api<{ skin: CustomSkin }>(`/api/skins/${skin.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: draft.name.trim(), tagline: draft.tagline.trim(), recipe }),
        });
        saved = r.skin;
      } else {
        const r = await api<{ skin: CustomSkin }>("/api/skins", {
          method: "POST",
          body: JSON.stringify({ name: draft.name.trim(), tagline: draft.tagline.trim(), ...recipe }),
        });
        saved = r.skin;
      }
      onPreview?.(customSkinAttr(saved.id));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skin-editor-title"
        className="w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id="skin-editor-title" className="text-[15px] font-semibold text-ink">
              {skin ? t("settings.skin.editor.editTitle", { name: skin.name }) : t("settings.skin.editor.newTitle")}
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.skin.editor.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settings.skin.editor.close")}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4">
          <Miniature skin={customSkinAttr(DRAFT_ID)} />
          <p className="mt-1.5 text-center text-[11px] text-ink-secondary">{t("settings.skin.editor.previewHint")}</p>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <input
              ref={nameRef}
              type="text"
              value={draft.name}
              maxLength={40}
              placeholder={t("settings.skin.editor.namePlaceholder")}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="min-h-8 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-focus"
              aria-label={t("settings.skin.editor.name")}
            />
            <input
              type="text"
              value={draft.tagline}
              maxLength={120}
              placeholder={t("settings.skin.editor.taglinePlaceholder")}
              onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
              className="min-h-8 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-focus"
              aria-label={t("settings.skin.editor.tagline")}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented
              ariaLabel={t("settings.skin.editor.mode")}
              value={draft.mode}
              onChange={(mode) => setDraft({ ...draft, mode })}
              options={[
                { value: "dark" as const, label: t("settings.skin.editor.dark") },
                { value: "light" as const, label: t("settings.skin.editor.light") },
              ]}
            />
            <Segmented
              ariaLabel={t("settings.skin.editor.bubble")}
              value={draft.bubble}
              onChange={(bubble) => setDraft({ ...draft, bubble })}
              options={[
                { value: "match" as const, label: t("settings.skin.editor.bubbleMatch") },
                { value: "inverted" as const, label: t("settings.skin.editor.bubbleInverted") },
              ]}
            />
            <Segmented
              ariaLabel={t("settings.skin.editor.corners")}
              value={draft.corners}
              onChange={(corners) => setDraft({ ...draft, corners })}
              options={[
                { value: "sharp" as const, label: t("settings.skin.editor.sharp") },
                { value: "soft" as const, label: t("settings.skin.editor.soft") },
                { value: "round" as const, label: t("settings.skin.editor.round") },
              ]}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ColorField label={t("settings.skin.editor.accent")} value={draft.accent} onChange={(accent) => setDraft({ ...draft, accent })} />
            <div className="flex items-center gap-2">
              <ColorField label={t("settings.skin.editor.tint")} value={draft.tint || NEUTRAL_TINT[draft.mode]} onChange={(tint) => setDraft({ ...draft, tint: tint === NEUTRAL_TINT[draft.mode] ? "" : tint })} />
              <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
                <input
                  type="checkbox"
                  checked={draft.tint === ""}
                  onChange={(event) => setDraft({ ...draft, tint: event.target.checked ? "" : NEUTRAL_TINT[draft.mode] })}
                  className="size-3.5 accent-[var(--color-accent)]"
                />
                {t("settings.skin.editor.neutral")}
              </label>
            </div>
          </div>
        </div>

        {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-8 rounded-lg px-3 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {t("settings.skin.editor.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!draft.name.trim() || saving}
            className="min-h-8 rounded-lg bg-accent px-4 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            {skin ? t("settings.skin.editor.save") : t("settings.skin.editor.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
