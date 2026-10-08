import { randomInt, randomUUID } from "node:crypto";
import type { MatchingGroupConfig, MatchingSlotConfig } from "@inventory-hub/contracts";
import type { InventoryDatabase } from "../db/database.js";
import { AppError, invariant } from "../errors.js";
import type { IdempotencyService, RequestIdentity } from "./idempotency.js";
import type { NodeService } from "./nodes.js";

interface StoredSlot extends MatchingSlotConfig {
  currentNodeId: string | null;
  historyIds: string[];
}
interface StoredConfig extends Omit<MatchingGroupConfig, "slots"> { slots: StoredSlot[] }
interface GroupRow { id: string; config: string; version: number; updatedAt: number }

export class MatchingService {
  constructor(
    private readonly database: InventoryDatabase,
    private readonly idempotency: IdempotencyService,
    private readonly nodes: NodeService,
  ) {}

  list(userId: string) {
    const rows = this.database.db.prepare(`SELECT id,config,version,updated_at updatedAt
      FROM matching_groups WHERE user_id=? ORDER BY created_at,id`).all(userId) as GroupRow[];
    return rows.map((row) => {
      const config = JSON.parse(row.config) as StoredConfig;
      return { id: row.id, name: config.name, version: row.version, slotCount: config.slots.length, updatedAt: new Date(row.updatedAt).toISOString() };
    });
  }

  detail(userId: string, id: string) {
    const row = this.get(userId, id);
    const config = JSON.parse(row.config) as StoredConfig;
    return {
      id: row.id, name: config.name, notes: config.notes, version: row.version,
      updatedAt: new Date(row.updatedAt).toISOString(),
      slots: config.slots.map((slot) => ({
        ...slot,
        node: this.nodeIfPresent(slot.currentNodeId),
        candidateCount: this.candidates(slot).length,
        canGoPrevious: slot.historyIds.some((nodeId) => this.nodeExists(nodeId)),
      })),
    };
  }

  create(identity: RequestIdentity, input: MatchingGroupConfig) {
    return this.write(identity, () => {
      const id = randomUUID();
      const now = Date.now();
      const config: StoredConfig = { ...input, slots: input.slots.map((slot) => ({ ...slot, currentNodeId: null, historyIds: [] })) };
      this.database.db.prepare("INSERT INTO matching_groups(id,user_id,config,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(id, identity.userId, JSON.stringify(config), now, now);
      return this.detail(identity.userId, id);
    });
  }

  update(identity: RequestIdentity, id: string, expectedVersion: number, input: MatchingGroupConfig) {
    return this.write(identity, () => {
      const row = this.get(identity.userId, id, expectedVersion);
      const previous = JSON.parse(row.config) as StoredConfig;
      const previousSlots = new Map(previous.slots.map((slot) => [slot.id, slot]));
      const config: StoredConfig = { ...input, slots: input.slots.map((slot) => {
        const old = previousSlots.get(slot.id);
        const changed = old && this.ruleKey(old) !== this.ruleKey(slot);
        invariant(!(old?.locked && slot.locked && changed), "INVALID_STATE", "请先解锁再修改匹配规则或类型");
        return {
          ...slot,
          currentNodeId: old && !changed ? old.currentNodeId : null,
          historyIds: old && !changed ? old.historyIds : [],
        };
      }) };
      this.save(identity.userId, id, config);
      return this.detail(identity.userId, id);
    });
  }

  act(identity: RequestIdentity, id: string, expectedVersion: number, action: "RANDOM" | "PREVIOUS", slotId?: string) {
    return this.write(identity, () => {
      const row = this.get(identity.userId, id, expectedVersion);
      const config = JSON.parse(row.config) as StoredConfig;
      if (slotId) invariant(config.slots.some((slot) => slot.id === slotId), "NOT_FOUND", "列表项不存在");
      for (const slot of config.slots) {
        if (slot.locked || (slotId && slot.id !== slotId)) continue;
        if (action === "RANDOM") {
          const candidates = this.candidates(slot);
          // Avoid immediately repeating the same archive when alternatives exist.
          const alternatives = candidates.filter((nodeId) => nodeId !== slot.currentNodeId);
          const pool = alternatives.length ? alternatives : candidates;
          if (!pool.length) {
            if (slot.currentNodeId) slot.historyIds = [...slot.historyIds, slot.currentNodeId].slice(-100);
            slot.currentNodeId = null;
            continue;
          }
          const next = pool[randomInt(pool.length)]!;
          if (next === slot.currentNodeId) continue;
          if (slot.currentNodeId) slot.historyIds = [...slot.historyIds, slot.currentNodeId].slice(-100);
          slot.currentNodeId = next;
        } else {
          while (slot.historyIds.length) {
            const previous = slot.historyIds.pop()!;
            if (this.nodeExists(previous)) { slot.currentNodeId = previous; break; }
          }
        }
      }
      this.save(identity.userId, id, config);
      return this.detail(identity.userId, id);
    });
  }

  delete(identity: RequestIdentity, id: string, expectedVersion: number) {
    return this.write(identity, () => {
      this.get(identity.userId, id, expectedVersion);
      this.database.db.prepare("DELETE FROM matching_groups WHERE id=? AND user_id=?").run(id, identity.userId);
      return { deleted: true };
    });
  }

  private candidates(slot: MatchingSlotConfig): string[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [slot.type];
    const dimensions = [
      ["node_categories", "category_id", slot.categoryIds],
      ["node_tags", "tag_id", slot.tagIds],
      ["node_specifications", "specification_id", slot.specificationIds],
    ] as const;
    for (const [table, column, ids] of dimensions) {
      if (!ids.length) continue;
      const matched = `(SELECT count(*) FROM ${table} r WHERE r.node_id=n.id AND r.${column} IN (${ids.map(() => "?").join(",")}))`;
      values.push(...ids);
      if (slot.mode === "ANY") conditions.push(`${matched}>0`);
      else {
        conditions.push(`${matched}=?${slot.mode === "EXACT" ? ` AND (SELECT count(*) FROM ${table} r WHERE r.node_id=n.id)=?` : ""}`);
        values.push(ids.length);
        if (slot.mode === "EXACT") values.push(ids.length);
      }
    }
    const filter = conditions.length ? ` AND (${conditions.join(slot.mode === "ANY" ? " OR " : " AND ")})` : "";
    const rows = this.database.db.prepare(`SELECT n.id FROM nodes n WHERE n.type=? AND n.is_system_staging=0${filter}`).all(...values) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private ruleKey(slot: MatchingSlotConfig) {
    return JSON.stringify([slot.type, slot.mode, [...slot.categoryIds].sort(), [...slot.tagIds].sort(), [...slot.specificationIds].sort()]);
  }

  private nodeExists(id: string | null): boolean {
    return Boolean(id && this.database.db.prepare("SELECT 1 FROM nodes WHERE id=? AND is_system_staging=0").get(id));
  }

  private nodeIfPresent(id: string | null) { return id && this.nodeExists(id) ? this.nodes.detail(id) : null; }

  private get(userId: string, id: string, expectedVersion?: number): GroupRow {
    const row = this.database.db.prepare("SELECT id,config,version,updated_at updatedAt FROM matching_groups WHERE user_id=? AND id=?")
      .get(userId, id) as GroupRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "搭配分组不存在");
    invariant(expectedVersion === undefined || row.version === expectedVersion, "VERSION_CONFLICT", "分组已在其他页面更新，请重新加载后编辑");
    return row;
  }

  private save(userId: string, id: string, config: StoredConfig) {
    this.database.db.prepare("UPDATE matching_groups SET config=?,version=version+1,updated_at=? WHERE id=? AND user_id=?")
      .run(JSON.stringify(config), Date.now(), id, userId);
  }

  private write<T>(identity: RequestIdentity, callback: () => T): T {
    return this.database.transaction(() => {
      const replay = this.idempotency.lookup(identity);
      if (replay !== undefined) return replay as T;
      const result = callback();
      this.database.bumpRevision();
      this.idempotency.persistSuccess(identity, result);
      return result;
    });
  }
}
