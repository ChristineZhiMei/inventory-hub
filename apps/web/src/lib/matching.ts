import { useCallback, useEffect, useRef, useState } from "react";
import type { MatchingGroupConfig, MatchingSlotConfig } from "@inventory-hub/contracts";
import { api, errorMessage } from "./api";
import type { InventoryNode } from "./types";
import { queries } from "./queries";
import type { Specification } from "./types";

export async function matchingSpecifications(): Promise<Specification[]> {
  const items: Specification[] = [];
  let cursor: string | null | undefined;
  do {
    const search = new URLSearchParams({ limit: "100" });
    if (cursor) search.set("cursor", cursor);
    const page = await queries.specifications(search.toString());
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export interface MatchingSlot extends MatchingSlotConfig {
  node: InventoryNode | null;
  currentNodeId: string | null;
  historyIds: string[];
  candidateCount: number;
  canGoPrevious: boolean;
}
export interface MatchingGroup {
  id: string;
  name: string;
  notes: string;
  version: number;
  updatedAt: string;
  slots: MatchingSlot[];
}
export interface MatchingGroupSummary {
  id: string; name: string; version: number; slotCount: number;
}

export function newMatchingSlot(): MatchingSlot {
  return {
    id: crypto.randomUUID(), name: "", notes: "", type: "ITEM", mode: "CONTAINS",
    categoryIds: [], tagIds: [], specificationIds: [], display: "LARGE", locked: false,
    node: null, currentNodeId: null, historyIds: [], candidateCount: 0, canGoPrevious: false,
  };
}

function groupConfig(group: MatchingGroup): MatchingGroupConfig {
  return { name: group.name, notes: group.notes, slots: group.slots.map((slot) => ({
    id: slot.id, name: slot.name, notes: slot.notes, type: slot.type, mode: slot.mode,
    categoryIds: slot.categoryIds, tagIds: slot.tagIds, specificationIds: slot.specificationIds,
    display: slot.display, locked: slot.locked,
  })) };
}

// Serialize saves and actions so rapid edits never overwrite a newer draft.
export function useMatchingGroup(initial: MatchingGroup, onSaved: (group: MatchingGroup) => void) {
  const [group, setGroup] = useState(initial);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = useRef(initial);
  const version = useRef(initial.version);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const acting = useRef(false);
  const mounted = useRef(true);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;

  const publish = useCallback((next: MatchingGroup) => {
    draft.current = next;
    if (mounted.current) setGroup(next);
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (saving.current) { await saving.current; return flush(); }
    if (savedRevision.current === revision.current) return;
    const save = async () => {
      if (mounted.current) { setSaveState("saving"); setError(""); }
      try {
        while (savedRevision.current !== revision.current) {
          const sentRevision = revision.current;
          const result = await api<MatchingGroup>(`/matching-groups/${draft.current.id}`, {
            method: "PUT", idempotent: true,
            body: { expectedVersion: version.current, config: groupConfig(draft.current) },
          });
          version.current = result.version;
          savedRevision.current = sentRevision;
          if (sentRevision === revision.current) publish(result);
          savedCallback.current(result);
        }
        if (mounted.current) setSaveState("saved");
      } catch (failure) {
        if (mounted.current) { setError(errorMessage(failure)); setSaveState("error"); }
        throw failure;
      }
    };
    saving.current = save();
    try { await saving.current; } finally { saving.current = null; }
  }, [publish]);

  const edit = useCallback((change: (current: MatchingGroup) => MatchingGroup) => {
    if (acting.current) return;
    publish(change(draft.current));
    revision.current += 1;
    setSaveState("pending");
  }, [publish]);

  useEffect(() => {
    if (saveState !== "pending") return;
    const timer = window.setTimeout(() => void flush().catch(() => undefined), 400);
    return () => window.clearTimeout(timer);
  }, [group, saveState, flush]);

  useEffect(() => {
    if (revision.current === savedRevision.current && !saving.current && !acting.current && initial.version > version.current) {
      version.current = initial.version;
      publish(initial);
    }
  }, [initial, publish]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void flush().catch(() => undefined); };
  }, [flush]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (revision.current !== savedRevision.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    const retry = () => { void flush().catch(() => undefined); };
    window.addEventListener("online", retry);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("online", retry); };
  }, [flush]);

  const act = async (action: "RANDOM" | "PREVIOUS", slotId?: string) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await flush();
      const result = await api<MatchingGroup>(`/matching-groups/${draft.current.id}/actions`, {
        method: "POST", idempotent: true, body: { expectedVersion: version.current, action, slotId },
      });
      version.current = result.version;
      publish(result);
      savedCallback.current(result);
      setError("");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { acting.current = false; setBusy(false); }
  };

  const reload = async () => {
    if (acting.current || saving.current) return;
    acting.current = true;
    setBusy(true);
    try {
      const result = await api<MatchingGroup>(`/matching-groups/${draft.current.id}`);
      version.current = result.version;
      savedRevision.current = revision.current;
      publish(result);
      savedCallback.current(result);
      setSaveState("saved");
      setError("");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { acting.current = false; setBusy(false); }
  };

  return { group, edit, act, busy, saveState, error, flush, reload, getVersion: () => version.current };
}
