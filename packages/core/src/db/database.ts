import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { AppError } from "../errors.js";
import { SCHEMA_VERSION, schemaSql } from "./schema.js";
import type { InventoryConfig } from "../config.js";

export type SqliteDatabase = Database.Database;

export class InventoryDatabase {
  readonly db: SqliteDatabase;
  readonly sqliteVersion: string;
  private readonly releaseLock: () => void;

  constructor(readonly config: InventoryConfig) {
    mkdirSync(dirname(config.databasePath), { recursive: true });
    mkdirSync(config.dataDir, { recursive: true });
    try {
      this.releaseLock = lockfile.lockSync(config.dataDir, {
        realpath: false,
        retries: 0,
        stale: 30_000,
        update: 10_000,
        lockfilePath: join(config.dataDir, ".inventory-hub-service.lock"),
      });
    } catch {
      throw new AppError("DB_UNAVAILABLE", "数据目录正被另一个 Inventory Hub 服务使用");
    }
    try { this.db = new Database(config.databasePath); }
    catch (error) { this.releaseLock(); throw error; }
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 3000");
    this.sqliteVersion = String((this.db.prepare("SELECT sqlite_version() version").get() as { version: string }).version);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(schemaSql);
    this.migrateLegacyCategories();
    this.migrateLegacySpecifications();
    this.migrateCombinedSpecifications();
    this.migrateSystemIdentifierTaxonomies();
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO code_sequences(prefix,next_value) VALUES ('W',1),('C',1),('I',1)").run();
    const settings = this.db.prepare("SELECT singleton_id FROM system_settings WHERE singleton_id=1").get();
    if (settings) {
      this.db.prepare("UPDATE system_settings SET schema_version=? WHERE singleton_id=1").run(SCHEMA_VERSION);
      return;
    }
    const initialize = this.db.transaction(() => {
      const rootId = randomUUID();
      const rootUuid = randomUUID();
      this.db.prepare(`INSERT INTO storage_roots(id,root_uuid,absolute_path,layout_version,generation,state,last_verified_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(rootId, rootUuid, this.config.mediaRoot, 1, 1, "ONLINE", now, now, now);
      const stagingId = randomUUID();
      const code = this.nextCode("W");
      this.db.prepare(`INSERT INTO code_reservations(code,node_id,state,created_at,updated_at) VALUES(?,?,?,?,?)`)
        .run(code, stagingId, "ACTIVE", now, now);
      this.db.prepare(`INSERT INTO nodes(id,code,type,parent_id,stock_status,name,notes,version,location_version,is_system_staging,created_at,updated_at)
        VALUES(?,?, 'WAREHOUSE',NULL,NULL,'暂存区','',1,1,1,?,?)`).run(stagingId, code, now, now);
      this.db.prepare(`INSERT INTO system_settings(singleton_id,staging_node_id,active_root_id,maintenance_state,service_identity,schema_version,data_revision)
        VALUES(1,?,?, 'ONLINE',?,?,0)`).run(stagingId, rootId, randomUUID(), SCHEMA_VERSION);
    });
    initialize();
  }

  private migrateLegacySpecifications(): void {
    const rows = this.db.prepare(`SELECT node_id nodeId,trim(specification) name
      FROM item_profiles p WHERE trim(specification)<>'' AND NOT EXISTS(
        SELECT 1 FROM node_specifications ns WHERE ns.node_id=p.node_id
      ) ORDER BY node_id`).all() as Array<{ nodeId: string; name: string }>;
    if (!rows.length) return;
    const select = this.db.prepare("SELECT id FROM specifications WHERE normalized_name=?");
    const insert = this.db.prepare(`INSERT INTO specifications(id,name,normalized_name,version,created_at,updated_at)
      VALUES(?,?,?,1,?,?)`);
    const attach = this.db.prepare(`INSERT OR IGNORE INTO node_specifications(node_id,specification_id,sort_order)
      VALUES(?,?,?)`);
    this.db.transaction(() => {
      for (const row of rows) {
        for (const [index, normalizedName] of splitSpecificationNames(row.name).entries()) {
          const normalizedKey = normalizedName.toLocaleLowerCase("zh-CN");
          let specification = select.get(normalizedKey) as { id: string } | undefined;
          if (!specification) {
            const id = randomUUID();
            const now = Date.now();
            insert.run(id, normalizedName, normalizedKey, now, now);
            specification = { id };
          }
          attach.run(row.nodeId, specification.id, index);
        }
      }
    })();
  }

  private migrateCombinedSpecifications(): void {
    const combined = this.db.prepare(`SELECT id,name FROM specifications
      WHERE instr(name,'/')>0 OR instr(name,'／')>0 ORDER BY id`).all() as Array<{
      id: string;
      name: string;
    }>;
    if (!combined.length) return;
    const select = this.db.prepare("SELECT id FROM specifications WHERE normalized_name=?");
    const insert = this.db.prepare(`INSERT INTO specifications(id,name,normalized_name,version,created_at,updated_at)
      VALUES(?,?,?,1,?,?)`);
    const references = this.db.prepare(`SELECT node_id nodeId,sort_order sortOrder
      FROM node_specifications WHERE specification_id=? ORDER BY node_id,sort_order`);
    const detach = this.db.prepare(
      "DELETE FROM node_specifications WHERE node_id=? AND specification_id=?",
    );
    const attach = this.db.prepare(`INSERT OR IGNORE INTO node_specifications(node_id,specification_id,sort_order)
      VALUES(?,?,?)`);
    const remove = this.db.prepare("DELETE FROM specifications WHERE id=?");
    const itemSpecifications = this.db.prepare(`SELECT s.name FROM specifications s
      JOIN node_specifications ns ON ns.specification_id=s.id
      WHERE ns.node_id=? ORDER BY ns.sort_order,s.name,s.id`);
    const updateLegacy = this.db.prepare(
      "UPDATE item_profiles SET specification=? WHERE node_id=?",
    );
    this.db.transaction(() => {
      const affectedNodes = new Set<string>();
      for (const source of combined) {
        const names = splitSpecificationNames(source.name);
        const rows = references.all(source.id) as Array<{
          nodeId: string;
          sortOrder: number;
        }>;
        for (const row of rows) {
          detach.run(row.nodeId, source.id);
          affectedNodes.add(row.nodeId);
          for (const [index, name] of names.entries()) {
            const key = name.toLocaleLowerCase("zh-CN");
            let target = select.get(key) as { id: string } | undefined;
            if (!target) {
              const id = randomUUID();
              const now = Date.now();
              insert.run(id, name, key, now, now);
              target = { id };
            }
            attach.run(row.nodeId, target.id, row.sortOrder + index);
          }
        }
        remove.run(source.id);
      }
      for (const nodeId of affectedNodes) {
        const legacyValue = (itemSpecifications.all(nodeId) as Array<{ name: string }>)
          .map((item) => item.name)
          .join(" / ")
          .slice(0, 500);
        updateLegacy.run(legacyValue, nodeId);
      }
    })();
  }

  private migrateSystemIdentifierTaxonomies(): void {
    const invalidTags = (this.db.prepare("SELECT id,name FROM tags ORDER BY id").all() as Array<{
      id: string;
      name: string;
    }>).filter((row) => SYSTEM_ID_PATTERN.test(row.name.trim()));
    const invalidSpecifications = (
      this.db.prepare("SELECT id,name FROM specifications ORDER BY id").all() as Array<{
        id: string;
        name: string;
      }>
    ).filter((row) => SYSTEM_ID_PATTERN.test(row.name.trim()));
    if (!invalidTags.length && !invalidSpecifications.length) return;

    const referencedSpecificationNodes = this.db.prepare(
      "SELECT node_id nodeId FROM node_specifications WHERE specification_id=? ORDER BY node_id",
    );
    const removeTag = this.db.prepare("DELETE FROM tags WHERE id=?");
    const removeSpecification = this.db.prepare("DELETE FROM specifications WHERE id=?");
    const itemSpecifications = this.db.prepare(`SELECT s.name FROM specifications s
      JOIN node_specifications ns ON ns.specification_id=s.id
      WHERE ns.node_id=? ORDER BY ns.sort_order,s.name,s.id`);
    const updateLegacy = this.db.prepare(
      "UPDATE item_profiles SET specification=? WHERE node_id=?",
    );

    this.db.transaction(() => {
      const affectedNodes = new Set<string>();
      for (const tag of invalidTags) removeTag.run(tag.id);
      for (const specification of invalidSpecifications) {
        const rows = referencedSpecificationNodes.all(specification.id) as Array<{
          nodeId: string;
        }>;
        rows.forEach(({ nodeId }) => affectedNodes.add(nodeId));
        removeSpecification.run(specification.id);
      }
      for (const nodeId of affectedNodes) {
        const legacyValue = (itemSpecifications.all(nodeId) as Array<{ name: string }>)
          .map((item) => item.name)
          .join(" / ")
          .slice(0, 500);
        updateLegacy.run(legacyValue, nodeId);
      }
    })();
  }

  private migrateLegacyCategories(): void {
    this.db.prepare(`INSERT OR IGNORE INTO node_categories(node_id,category_id,sort_order)
      SELECT node_id,category_id,0 FROM item_profiles`).run();
  }

  nextCode(prefix: "W" | "C" | "I"): string {
    const row = this.db.prepare("SELECT next_value nextValue FROM code_sequences WHERE prefix=?").get(prefix) as { nextValue: number } | undefined;
    if (!row) throw new AppError("DATA_INTEGRITY_ERROR", `编号序列 ${prefix} 不存在`);
    this.db.prepare("UPDATE code_sequences SET next_value=next_value+1 WHERE prefix=?").run(prefix);
    return `${prefix}${String(row.nextValue).padStart(6, "0")}`;
  }

  get stagingNodeId(): string {
    return (this.db.prepare("SELECT staging_node_id stagingNodeId FROM system_settings WHERE singleton_id=1").get() as { stagingNodeId: string }).stagingNodeId;
  }

  get activeRoot(): { id: string; rootUuid: string; absolutePath: string; generation: number; state: string } {
    return this.db.prepare(`SELECT r.id, r.root_uuid rootUuid, r.absolute_path absolutePath, r.generation, r.state
      FROM storage_roots r JOIN system_settings s ON s.active_root_id=r.id WHERE s.singleton_id=1`).get() as any;
  }

  bumpRevision(): number {
    this.db.prepare("UPDATE system_settings SET data_revision=data_revision+1 WHERE singleton_id=1").run();
    return this.dataRevision;
  }

  get dataRevision(): number {
    return (this.db.prepare("SELECT data_revision dataRevision FROM system_settings WHERE singleton_id=1").get() as { dataRevision: number }).dataRevision;
  }

  payloadHash(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
  }

  transaction<T>(callback: () => T): T {
    return this.db.transaction(callback).immediate();
  }

  quickCheck(): string {
    return String((this.db.pragma("quick_check", { simple: true }) as string) ?? "unknown");
  }

  close(): void {
    try { this.db.close(); }
    finally { this.releaseLock(); }
  }
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const splitSpecificationNames = (value: string): string[] => [
  ...new Set(
    value
      .split(/[／/]/)
      .map((item) => item.normalize("NFKC").trim().replace(/\s+/g, " "))
      .filter(Boolean),
  ),
];

const SYSTEM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
