import { createHash, randomUUID } from "node:crypto";
import type { InventoryDatabase } from "../db/database.js";
import { normalizedKey, normalizeName } from "../domain/model.js";
import { AppError, invariant } from "../errors.js";
import type { IdempotencyService, RequestIdentity } from "./idempotency.js";

export class TaxonomyService {
  constructor(private readonly database: InventoryDatabase, private readonly idempotency: IdempotencyService) {}

  categories(): any[] {
    const rows = this.database.db.prepare(`SELECT c.id,c.parent_id parentId,c.name,c.version,c.created_at createdAt,c.updated_at updatedAt,
      (SELECT count(*) FROM node_categories nc WHERE nc.category_id=c.id) referenceCount,
      (SELECT count(*) FROM categories child WHERE child.parent_id=c.id) childCount FROM categories c ORDER BY c.parent_scope_key,c.name`).all() as any[];
    return rows.map((row) => ({ ...row, referenceToken: this.categoryReferenceToken(row.id), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() }));
  }

  createCategory(identity: RequestIdentity, input: { name: string; parentId?: string | undefined }): any {
    return this.write(identity, () => {
      const id = randomUUID();
      const now = Date.now();
      const parentScope = input.parentId ?? "ROOT";
      if (input.parentId) { this.categoryDepth(input.parentId); }
      this.database.db.prepare(`INSERT INTO categories(id,parent_id,name,normalized_name,parent_scope_key,version,created_at,updated_at)
        VALUES(?,?,?,?,?,1,?,?)`).run(id, input.parentId ?? null, normalizeName(input.name), normalizedKey(input.name), parentScope, now, now);
      this.log(identity, "CATEGORY_CREATE", "CATEGORY", id, null, { id, ...input });
      return { id, parentId: input.parentId ?? null, name: normalizeName(input.name), version: 1 };
    });
  }

  patchCategory(identity: RequestIdentity, id: string, input: { expectedVersion: number; name?: string | undefined; parentId?: string | null | undefined }): any {
    return this.write(identity, () => {
      const current = this.getCategory(id);
      invariant(current.version === input.expectedVersion, "VERSION_CONFLICT", "分类已被修改");
      const parentId = input.parentId === undefined ? current.parentId : input.parentId;
      invariant(parentId !== id, "REFERENCE_CONFLICT", "分类不能成为自己的父级");
      if (parentId) {
        let cursor: string | null = parentId;
        let depth = 1;
        while (cursor) {
          invariant(cursor !== id, "REFERENCE_CONFLICT", "分类移动会形成循环");
          const parent: { parentId: string | null } = this.getCategory(cursor);
          cursor = parent.parentId;
          depth += 1;
          invariant(depth <= 5, "REFERENCE_CONFLICT", "分类最多五层");
        }
      }
      const name = input.name === undefined ? current.name : normalizeName(input.name);
      this.database.db.prepare(`UPDATE categories SET parent_id=?,parent_scope_key=?,name=?,normalized_name=?,version=version+1,updated_at=? WHERE id=?`)
        .run(parentId, parentId ?? "ROOT", name, normalizedKey(name), Date.now(), id);
      const updated = this.getCategory(id);
      this.log(identity, "CATEGORY_EDIT", "CATEGORY", id, current, updated);
      return updated;
    });
  }

  deleteCategory(identity: RequestIdentity, id: string, expectedVersion: number): any {
    return this.write(identity, () => {
      const current = this.getCategory(id);
      invariant(current.version === expectedVersion, "VERSION_CONFLICT", "分类已被修改");
      const children = (this.database.db.prepare("SELECT count(*) count FROM categories WHERE parent_id=?").get(id) as any).count;
      const references = (this.database.db.prepare("SELECT count(*) count FROM node_categories WHERE category_id=?").get(id) as any).count;
      invariant(children === 0 && references === 0, "REFERENCE_CONFLICT", "分类仍有子分类或物品引用", { childCount: children, referenceCount: references });
      this.database.db.prepare("DELETE FROM categories WHERE id=?").run(id);
      this.log(identity, "CATEGORY_DELETE", "CATEGORY", id, current, { deleted: true });
      return { id, deleted: true };
    });
  }

  reassignCategory(identity: RequestIdentity, sourceId: string, input: { targetCategoryId: string; expectedVersion: number; previewCount: number; referenceToken: string }): any {
    return this.write(identity, () => {
      const source = this.getCategory(sourceId);
      this.getCategory(input.targetCategoryId);
      invariant(source.version === input.expectedVersion, "VERSION_CONFLICT", "分类已被修改");
      const nodes = this.database.db.prepare(`SELECT node_id nodeId,sort_order sortOrder FROM node_categories
        WHERE category_id=? ORDER BY node_id`).all(sourceId) as Array<{ nodeId: string; sortOrder: number }>;
      invariant(nodes.length <= 5000, "REFERENCE_CONFLICT", "引用数量超过单次迁移上限");
      invariant(nodes.length === input.previewCount && this.categoryReferenceToken(sourceId) === input.referenceToken, "REFERENCE_CONFLICT", "分类引用已变化");
      const attach = this.database.db.prepare(`INSERT OR IGNORE INTO node_categories(node_id,category_id,sort_order)
        VALUES(?,?,?)`);
      const detach = this.database.db.prepare("DELETE FROM node_categories WHERE node_id=? AND category_id=?");
      const updateLegacy = this.database.db.prepare(`UPDATE item_profiles SET category_id=?
        WHERE node_id=? AND category_id=?`);
      nodes.forEach(({ nodeId, sortOrder }) => {
        attach.run(nodeId, input.targetCategoryId, sortOrder);
        detach.run(nodeId, sourceId);
        updateLegacy.run(input.targetCategoryId, nodeId, sourceId);
      });
      if (nodes.length) {
        const update = this.database.db.prepare("UPDATE nodes SET version=version+1,updated_at=? WHERE id=?");
        nodes.forEach(({ nodeId }) => update.run(Date.now(), nodeId));
      }
      this.log(identity, "CATEGORY_REASSIGN", "CATEGORY", sourceId, { sourceId, nodes }, { targetCategoryId: input.targetCategoryId, nodes });
      return { sourceId, targetCategoryId: input.targetCategoryId, reassignedCount: nodes.length };
    });
  }

  tags(): any[] {
    const rows = this.database.db.prepare(`SELECT t.id,t.name,t.version,t.created_at createdAt,t.updated_at updatedAt,
      (SELECT count(*) FROM node_tags nt WHERE nt.tag_id=t.id) referenceCount FROM tags t ORDER BY t.name`).all() as any[];
    return rows.map((row) => ({ ...row, referenceToken: this.tagReferenceToken(row.id), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() }));
  }

  createTag(identity: RequestIdentity, name: string): any {
    return this.write(identity, () => {
      const id = randomUUID();
      const now = Date.now();
      this.database.db.prepare("INSERT INTO tags(id,name,normalized_name,version,created_at,updated_at) VALUES(?,?,?,1,?,?)")
        .run(id, normalizeName(name), normalizedKey(name), now, now);
      const value = { id, name: normalizeName(name), version: 1 };
      this.log(identity, "TAG_CREATE", "TAG", id, null, value);
      return value;
    });
  }

  patchTag(identity: RequestIdentity, id: string, input: { name: string; expectedVersion: number }): any {
    return this.write(identity, () => {
      const current = this.getTag(id);
      invariant(current.version === input.expectedVersion, "VERSION_CONFLICT", "标签已被修改");
      this.database.db.prepare("UPDATE tags SET name=?,normalized_name=?,version=version+1,updated_at=? WHERE id=?")
        .run(normalizeName(input.name), normalizedKey(input.name), Date.now(), id);
      const updated = this.getTag(id);
      this.log(identity, "TAG_EDIT", "TAG", id, current, updated);
      return updated;
    });
  }

  deleteTag(identity: RequestIdentity, id: string, input: { expectedVersion: number; confirmName: string; referenceToken: string }): any {
    return this.write(identity, () => {
      const current = this.getTag(id);
      invariant(current.version === input.expectedVersion && current.name === input.confirmName, "VERSION_CONFLICT", "标签信息已变化");
      invariant(this.tagReferenceToken(id) === input.referenceToken, "REFERENCE_CONFLICT", "标签引用已变化");
      const nodeIds = this.database.db.prepare("SELECT node_id nodeId FROM node_tags WHERE tag_id=? ORDER BY node_id").all(id) as any[];
      this.database.db.prepare("DELETE FROM node_tags WHERE tag_id=?").run(id);
      this.database.db.prepare("DELETE FROM tags WHERE id=?").run(id);
      const update = this.database.db.prepare("UPDATE nodes SET version=version+1,updated_at=? WHERE id=?");
      nodeIds.forEach(({ nodeId }) => update.run(Date.now(), nodeId));
      this.log(identity, "TAG_DELETE", "TAG", id, { ...current, nodeIds }, { deleted: true });
      return { id, deleted: true, detachedCount: nodeIds.length };
    });
  }

  specifications(query: Record<string, unknown>): { items: any[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const offset = decodeCursor(query.cursor);
    const search = String(query.q ?? "").normalize("NFKC").trim();
    invariant(search.length <= 120, "VALIDATION_ERROR", "规格搜索内容最多 120 个字符");
    const where = search ? "WHERE s.name LIKE ? ESCAPE '\\'" : "";
    const params = search ? [`%${escapeLike(search)}%`] : [];
    const rows = this.database.db.prepare(`SELECT s.id,s.name,s.version,s.created_at createdAt,s.updated_at updatedAt,
      (SELECT count(*) FROM node_specifications ns WHERE ns.specification_id=s.id) referenceCount
      FROM specifications s ${where} ORDER BY s.name,s.id LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as any[];
    const items = rows.slice(0, limit).map((row) => ({
      ...row,
      referenceToken: this.specificationReferenceToken(row.id),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
    return { items, nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null };
  }

  createSpecification(identity: RequestIdentity, name: string): any {
    return this.write(identity, () => {
      const normalizedName = normalizeName(name);
      invariant(
        !this.database.db.prepare("SELECT 1 FROM specifications WHERE normalized_name=?").get(normalizedKey(normalizedName)),
        "REFERENCE_CONFLICT",
        "该规格已经存在",
      );
      const id = randomUUID();
      const now = Date.now();
      this.database.db.prepare(`INSERT INTO specifications(id,name,normalized_name,version,created_at,updated_at)
        VALUES(?,?,?,1,?,?)`).run(id, normalizedName, normalizedKey(normalizedName), now, now);
      const value = { id, name: normalizedName, version: 1, referenceCount: 0 };
      this.log(identity, "SPECIFICATION_CREATE", "SPECIFICATION", id, null, value);
      return value;
    });
  }

  patchSpecification(identity: RequestIdentity, id: string, input: { name: string; expectedVersion: number }): any {
    return this.write(identity, () => {
      const current = this.getSpecification(id);
      invariant(current.version === input.expectedVersion, "VERSION_CONFLICT", "规格已被修改");
      const name = normalizeName(input.name);
      const duplicate = this.database.db.prepare("SELECT id FROM specifications WHERE normalized_name=? AND id<>?")
        .get(normalizedKey(name), id);
      invariant(!duplicate, "REFERENCE_CONFLICT", "该规格已经存在");
      this.database.db.prepare(`UPDATE specifications SET name=?,normalized_name=?,version=version+1,updated_at=? WHERE id=?`)
        .run(name, normalizedKey(name), Date.now(), id);
      const updated = this.getSpecification(id);
      this.log(identity, "SPECIFICATION_EDIT", "SPECIFICATION", id, current, updated);
      return updated;
    });
  }

  deleteSpecification(identity: RequestIdentity, id: string, input: { expectedVersion: number; confirmName: string; referenceToken: string }): any {
    return this.write(identity, () => {
      const current = this.getSpecification(id);
      invariant(current.version === input.expectedVersion && current.name === input.confirmName, "VERSION_CONFLICT", "规格信息已变化");
      invariant(this.specificationReferenceToken(id) === input.referenceToken, "REFERENCE_CONFLICT", "规格引用已变化");
      const nodeIds = this.database.db.prepare(`SELECT node_id nodeId FROM node_specifications
        WHERE specification_id=? ORDER BY node_id`).all(id) as any[];
      this.database.db.prepare("DELETE FROM node_specifications WHERE specification_id=?").run(id);
      this.database.db.prepare("DELETE FROM specifications WHERE id=?").run(id);
      const update = this.database.db.prepare("UPDATE nodes SET version=version+1,updated_at=? WHERE id=?");
      nodeIds.forEach(({ nodeId }) => update.run(Date.now(), nodeId));
      this.log(identity, "SPECIFICATION_DELETE", "SPECIFICATION", id, { ...current, nodeIds }, { deleted: true });
      return { id, deleted: true, detachedCount: nodeIds.length };
    });
  }

  private write(identity: RequestIdentity, callback: () => unknown): any {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    return this.database.transaction(() => {
      const repeated = this.idempotency.lookup(identity);
      if (repeated) return repeated;
      const value = callback();
      this.database.bumpRevision();
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
  }

  private getCategory(id: string): any {
    const row = this.database.db.prepare("SELECT id,parent_id parentId,name,version FROM categories WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "分类不存在");
    return row;
  }

  private categoryDepth(id: string): number {
    let depth = 1;
    let current: string | null = id;
    while (current) { const row: { parentId: string | null } = this.getCategory(current); current = row.parentId; depth += 1; invariant(depth <= 5, "REFERENCE_CONFLICT", "分类最多五层"); }
    return depth;
  }

  private getTag(id: string): any {
    const row = this.database.db.prepare("SELECT id,name,version FROM tags WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "标签不存在");
    return row;
  }

  private getSpecification(id: string): any {
    const row = this.database.db.prepare("SELECT id,name,version FROM specifications WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "规格不存在");
    return row;
  }

  private categoryReferenceToken(id: string): string {
    const ids = this.database.db.prepare("SELECT node_id nodeId FROM node_categories WHERE category_id=? ORDER BY node_id").all(id);
    return hash(ids);
  }

  private tagReferenceToken(id: string): string {
    const ids = this.database.db.prepare("SELECT node_id nodeId FROM node_tags WHERE tag_id=? ORDER BY node_id").all(id);
    return hash(ids);
  }

  private specificationReferenceToken(id: string): string {
    const ids = this.database.db.prepare(`SELECT node_id nodeId FROM node_specifications
      WHERE specification_id=? ORDER BY node_id`).all(id);
    return hash(ids);
  }

  private log(identity: RequestIdentity, action: string, subjectType: string, subjectId: string, before: unknown, after: unknown): void {
    this.database.db.prepare(`INSERT INTO operation_logs(id,request_id,actor_id,client_kind,action,subject_type,subject_id,before_snapshot,after_snapshot,summary,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), identity.requestId, identity.userId, "WEB", action, subjectType, subjectId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, `${action} ${subjectId}`, Date.now());
  }
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
const decodeCursor = (cursor: unknown): number => {
  if (!cursor) return 0;
  try { return Math.max(0, Number(JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")).offset) || 0); }
  catch { throw new AppError("VALIDATION_ERROR", "分页游标无效"); }
};
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);
