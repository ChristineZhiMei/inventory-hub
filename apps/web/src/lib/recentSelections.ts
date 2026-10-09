import { useRef, useSyncExternalStore } from "react";

export type TaxonomyKind = "category" | "specification" | "tag";
type History = Partial<Record<TaxonomyKind, string[]>>;
const storageKey = "inventory-hub:recent-selections";
const changedEvent = "inventory-hub:recent-selections-changed";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memorySnapshot: string | undefined;

function snapshot() {
  try { return memorySnapshot ?? localStorage.getItem(storageKey) ?? ""; }
  catch { return memorySnapshot ?? ""; }
}

function readHistory(raw: string): History {
  try {
    const value = JSON.parse(raw);
    const history: History = {};
    for (const kind of ["category", "specification", "tag"] as const) {
      if (Array.isArray(value?.[kind])) {
        history[kind] = [...new Set<string>(value[kind].filter((id: unknown) => typeof id === "string" && idPattern.test(id)))].slice(0, 100);
      }
    }
    return history;
  } catch { return {}; }
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      memorySnapshot = undefined;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changedEvent, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changedEvent, listener);
  };
}

export function useRecentSelections(deferSorting = false) {
  const currentSnapshot = useSyncExternalStore(subscribe, snapshot, () => "");
  const sortingSnapshot = useRef(currentSnapshot);
  // Record immediately, but keep the open dropdown and paginated query stable.
  // Closing it exposes the latest ranking on the next render.
  if (!deferSorting) sortingSnapshot.current = currentSnapshot;
  const history = readHistory(sortingSnapshot.current);
  return {
    ids: (kind: TaxonomyKind) => history[kind] ?? [],
    sort: <T extends { id: string }>(kind: TaxonomyKind, options: T[]): T[] => {
      const ranks = new Map((history[kind] ?? []).map((id, index) => [id, index]));
      return [...options].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
    },
    record: (kind: TaxonomyKind, ids: string[], previous: string[] = []) => {
      const added = ids.filter((id) => id && !previous.includes(id));
      if (!added.length) return;
      const current = readHistory(snapshot());
      current[kind] = [...new Set([...added.reverse(), ...(current[kind] ?? [])])].slice(0, 100);
      memorySnapshot = JSON.stringify(current);
      try { localStorage.setItem(storageKey, memorySnapshot); } catch { /* Keep this session usable when storage is unavailable. */ }
      window.dispatchEvent(new Event(changedEvent));
    },
  };
}
