// Custom picker: search the live inject list, and pin models the host
// already has in memory so the user can pick them without scrolling.

export function filterCustomModels<T extends { id: string; label: string; provider?: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.id.toLowerCase().includes(needle) ||
      (option.provider?.toLowerCase().includes(needle) ?? false),
  );
}

export function partitionCustomModels<T extends { id: string; loaded?: boolean }>(
  options: readonly T[],
) {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const option of options) {
    if (option.loaded) pinned.push(option);
    else rest.push(option);
  }
  return { pinned, rest };
}

/** Keep the active and default choices visible, then fill the compact list
 * from catalog order. Catalog order is provider-owned and already reflects
 * its preferred/current models. */
export function suggestedModels<T extends { id: string }>(
  options: readonly T[],
  defaultId: string,
  currentId: string | undefined,
  limit = 5,
): T[] {
  const picked: T[] = [];
  const seen = new Set<string>();
  const add = (option: T | undefined) => {
    if (!option || seen.has(option.id) || picked.length >= limit) return;
    seen.add(option.id);
    picked.push(option);
  };
  add(currentId ? options.find((option) => option.id === currentId) : undefined);
  add(options.find((option) => option.id === defaultId));
  for (const option of options) add(option);
  return picked;
}

/** One group per provider facet, in first-seen order. An engine that lists
 * several providers' models (zcode mirrors its harness's own picker) renders
 * one section header per group, its rows under it; rows without a provider —
 * a passthrough default — form a headerless group. Collecting by provider
 * rather than by run also keeps the suggested list's hoisted current model
 * from splitting its provider into two sections. */
export function groupModelsByProvider<T extends { provider?: string }>(
  options: readonly T[],
): Array<{ provider?: string; options: T[] }> {
  const groups = new Map<string | undefined, { provider?: string; options: T[] }>();
  for (const option of options) {
    let group = groups.get(option.provider);
    if (!group) {
      group = { provider: option.provider, options: [] };
      groups.set(option.provider, group);
    }
    group.options.push(option);
  }
  return [...groups.values()];
}

/** Whether a rendered list spans more than one named provider: only then do
 * the section headers pay for themselves. One provider's rows — plus any
 * headerless default — keep the per-row badge instead. */
export function hasMultipleProviders<T extends { provider?: string }>(options: readonly T[]): boolean {
  const seen = new Set<string>();
  for (const option of options) if (option.provider !== undefined) seen.add(option.provider);
  return seen.size > 1;
}
