import { randomUUID } from "node:crypto";
import type { CreateNodeInput, NodeType, PatchProfileInput } from "@inventory-hub/contracts";
import type { InventoryDatabase } from "../db/database.js";
import { AppError, invariant } from "../errors.js";
import { getDescendants, getNode, getPath, locationToken, nodeSelect, normalizeName, serializeNode, snapshotNode, subtreeToken, validateParent } from "../domain/model.js";
import type { IdempotencyService, RequestIdentity } from "./idempotency.js";
import type { MediaService, PreparedImage } from "./media.js";

export class NodeService {
  constructor(private readonly database: InventoryDatabase, private readonly idempotency: IdempotencyService, private readonly media: MediaService) {}

  async create(identity: RequestIdentity, input: CreateNodeInput): Promise<any> {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    invariant(new Set(input.uploadIds).size === input.uploadIds.length, "VALIDATION_ERROR", "图片不能重复");
    const reservation = this.reserveCode(identity, input.type);
    const prepared = await this.media.prepare(identity.userId, input.uploadIds, reservation.nodeId, reservation.code, input.type);
    return this.database.transaction(() => {
      const repeated = this.idempotency.lookup(identity);
      if (repeated) return repeated;
      const now = Date.now();
      const parentId = input.type === "WAREHOUSE" ? null : input.createMode === "PLACE" ? input.targetId! : this.database.stagingNodeId;
      if (input.type !== "WAREHOUSE") {
        const parent = getNode(this.database.db, parentId!);
        validateParent(input.type, parent);
        if (input.createMode === "PLACE") {
          invariant(Boolean(input.targetLocationToken), "VALIDATION_ERROR", "放置模式必须携带目标位置令牌");
          invariant(locationToken(this.database.db, parent.id) === input.targetLocationToken, "LOCATION_CHANGED", "目标位置已变化");
        }
      }
      const categoryIds = input.categoryIds.length
        ? input.categoryIds
        : input.categoryId
          ? [input.categoryId]
          : [];
      this.validateTaxonomy(categoryIds, input.tagIds, input.specificationIds, input.type);
      this.database.db.prepare(`INSERT INTO nodes(id,code,type,parent_id,stock_status,name,notes,version,location_version,is_system_staging,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,1,0,?,?)`).run(reservation.nodeId, reservation.code, input.type, parentId,
        input.type === "WAREHOUSE" ? null : "IN_STOCK", normalizeName(input.name), input.notes ?? "", now, now);
      if (input.type === "ITEM") this.database.db.prepare("INSERT INTO item_profiles(node_id,category_id,specification) VALUES(?,?,?)")
        .run(reservation.nodeId, categoryIds[0], "");
      this.replaceCategories(reservation.nodeId, categoryIds, input.type);
      this.replaceTags(reservation.nodeId, input.tagIds);
      this.replaceSpecifications(reservation.nodeId, input.specificationIds);
      this.media.insertPrepared(reservation.nodeId, prepared);
      this.database.db.prepare("UPDATE code_reservations SET state='ACTIVE',updated_at=? WHERE code=?").run(now, reservation.code);
      const node = getNode(this.database.db, reservation.nodeId);
      const operationId = this.logOperation(identity.requestId, identity.userId, "CREATE", node, null, snapshotNode(this.database.db, node), true, undefined);
      const initialContentOperationId = input.initialContent
        ? this.placeInitialContent(
            `${identity.requestId}:initial-content`,
            identity.userId,
            node,
            input.initialContent,
            now,
          )
        : undefined;
      this.database.bumpRevision();
      const value = {
        operationId,
        ...(initialContentOperationId ? { initialContentOperationId } : {}),
        changed: true,
        node: this.detail(reservation.nodeId),
      };
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
  }

  async patch(identity: RequestIdentity, nodeId: string, input: PatchProfileInput): Promise<any> {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    const initial = getNode(this.database.db, nodeId);
    if (input.images) {
      const imageKeys = input.images.map((entry) => "imageId" in entry ? `image:${entry.imageId}` : `upload:${entry.uploadId}`);
      invariant(new Set(imageKeys).size === imageKeys.length, "VALIDATION_ERROR", "图片不能重复");
    }
    const newUploads = input.images?.flatMap((entry) => "uploadId" in entry ? [entry.uploadId] : []) ?? [];
    const prepared = newUploads.length ? await this.media.prepare(identity.userId, newUploads, nodeId, initial.code, initial.type) : [];
    return this.database.transaction(() => {
      const repeated = this.idempotency.lookup(identity);
      if (repeated) return repeated;
      const node = getNode(this.database.db, nodeId);
      invariant(node.version === input.expectedVersion, "VERSION_CONFLICT", "档案已被修改", { currentVersion: node.version });
      const before = snapshotNode(this.database.db, node);
      const now = Date.now();
      const categoryIds = input.categoryIds ?? (input.categoryId ? [input.categoryId] : []);
      const categoriesUnchanged = input.categoryIds === undefined && input.categoryId === undefined;
      this.validateTaxonomy(categoryIds, input.tagIds ?? [], input.specificationIds ?? [], node.type, categoriesUnchanged);
      this.database.db.prepare(`UPDATE nodes SET name=COALESCE(?,name),notes=COALESCE(?,notes),version=version+1,updated_at=? WHERE id=?`)
        .run(input.name === undefined ? null : normalizeName(input.name), input.notes ?? null, now, nodeId);
      if (!categoriesUnchanged) this.replaceCategories(nodeId, categoryIds, node.type);
      if (input.tagIds) this.replaceTags(nodeId, input.tagIds);
      if (input.specificationIds) this.replaceSpecifications(nodeId, input.specificationIds);
      if (input.images) this.replaceImages(node, input.images, prepared);
      const afterNode = getNode(this.database.db, nodeId);
      const operationId = this.logOperation(identity.requestId, identity.userId, "EDIT_PROFILE", afterNode, before, snapshotNode(this.database.db, afterNode), true, undefined);
      this.database.bumpRevision();
      const value = { operationId, changed: true, node: this.detail(nodeId) };
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
  }

  delete(identity: RequestIdentity, nodeId: string, input: { expectedVersion: number; expectedLocationVersion: number; locationToken: string; confirmCode: string }): any {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    return this.database.transaction(() => {
      const node = getNode(this.database.db, nodeId);
      invariant(node.code === input.confirmCode, "VALIDATION_ERROR", "确认编号不匹配");
      invariant(node.version === input.expectedVersion, "VERSION_CONFLICT", "档案已被修改");
      invariant(node.locationVersion === input.expectedLocationVersion && locationToken(this.database.db, nodeId) === input.locationToken, "LOCATION_CHANGED", "位置已变化");
      invariant(!node.isSystemStaging, "SYSTEM_NODE_PROTECTED", "暂存区不能删除");
      const child = this.database.db.prepare("SELECT id FROM nodes WHERE parent_id=? LIMIT 1").get(nodeId);
      invariant(!child, "NONEMPTY_CONTAINER", "非空容器或仓库不能删除");
      if (node.type !== "WAREHOUSE") invariant(node.stockStatus === "DISCARDED", "INVALID_STATE", "必须先废弃档案才能永久删除");
      const before = snapshotNode(this.database.db, node);
      const images = this.database.db.prepare("SELECT main_key mainKey,thumb_key thumbKey FROM images WHERE owner_node_id=?").all(nodeId) as any[];
      const cleanupJobId = this.media.queueImageCleanup(images);
      const operationId = randomUUID();
      const now = Date.now();
      this.database.db.prepare(`INSERT INTO operation_logs(id,request_id,actor_id,client_kind,action,subject_type,subject_id,before_snapshot,after_snapshot,summary,created_at)
        VALUES(?,?,?,?, 'HARD_DELETE',?,?,?,?,?,?)`).run(operationId, identity.requestId, identity.userId, "WEB", node.type, nodeId,
        JSON.stringify(before), JSON.stringify({ nodeId, code: node.code, deleted: true }), `永久删除 ${node.code}`, now);
      this.database.db.prepare(`INSERT INTO operation_targets(operation_id,node_id,code_snapshot,directly_operated,before_snapshot,after_snapshot)
        VALUES(?,?,?,?,?,?)`).run(operationId, nodeId, node.code, 1, JSON.stringify(before), JSON.stringify({ deleted: true }));
      this.database.db.prepare("DELETE FROM images WHERE owner_node_id=?").run(nodeId);
      this.database.db.prepare("DELETE FROM nodes WHERE id=?").run(nodeId);
      this.database.db.prepare("INSERT INTO node_tombstones(node_id,code,type,deleted_at,operation_id) VALUES(?,?,?,?,?)")
        .run(nodeId, node.code, node.type, now, operationId);
      this.database.db.prepare("UPDATE code_reservations SET state='DELETED',updated_at=? WHERE code=?").run(now, node.code);
      this.database.bumpRevision();
      const value = { operationId, deleted: true, cleanupPending: Boolean(cleanupJobId) };
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
  }

  detail(nodeId: string): any {
    const node = getNode(this.database.db, nodeId);
    const itemProfile = node.type === "ITEM" ? this.database.db.prepare(`SELECT p.category_id categoryId,p.specification,c.name categoryName
      FROM item_profiles p JOIN categories c ON c.id=p.category_id WHERE p.node_id=?`).get(nodeId) : null;
    const categories = this.categoriesForNode(nodeId);
    const tags = this.database.db.prepare(`SELECT t.id,t.name,t.version FROM tags t JOIN node_tags nt ON nt.tag_id=t.id WHERE nt.node_id=? ORDER BY t.name`).all(nodeId);
    const specifications = this.specificationsForNode(nodeId);
    return {
      ...serializeNode(this.database.db, node),
      itemProfile,
      categoryId: categories[0]?.id ?? null,
      category: categories[0] ?? null,
      categories,
      specification: specifications.map((item) => item.name).join(" / ") || null,
      specifications,
      tags,
      images: this.media.listForNode(nodeId),
    };
  }

  byCode(rawCode: string): any {
    const code = rawCode.trim().toUpperCase();
    invariant(/^(W|C|I)[0-9]{6,}$/.test(code), "INVALID_CODE", "编号格式无效");
    const row = this.database.db.prepare(`${nodeSelect} WHERE code=?`).get(code) as any;
    if (row) return { id: row.id, code: row.code, type: row.type, name: row.name, stockStatus: row.stockStatus };
    const tombstone = this.database.db.prepare("SELECT node_id id,code,type,deleted_at deletedAt FROM node_tombstones WHERE code=?").get(code);
    if (tombstone) throw new AppError("NODE_DELETED", "编号对应档案已删除", { details: tombstone });
    throw new AppError("NOT_FOUND", "未找到该编号");
  }

  listItems(query: Record<string, unknown>): any {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = decodeCursor(query.cursor);
    const where = ["n.type='ITEM'"];
    const params: unknown[] = [];
    if (query.q) {
      const pattern = `%${String(query.q).trim()}%`;
      where.push(`(n.code LIKE ? OR n.name LIKE ?
        OR EXISTS(SELECT 1 FROM node_tags qnt JOIN tags qt ON qt.id=qnt.tag_id WHERE qnt.node_id=n.id AND qt.name LIKE ?)
        OR EXISTS(SELECT 1 FROM node_specifications qns JOIN specifications qs ON qs.id=qns.specification_id WHERE qns.node_id=n.id AND qs.name LIKE ?)
        OR EXISTS(SELECT 1 FROM node_categories qnc JOIN categories qc ON qc.id=qnc.category_id WHERE qnc.node_id=n.id AND qc.name LIKE ?))`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (query.status) { where.push("n.stock_status=?"); params.push(String(query.status)); }
    if (query.categoryId) {
      where.push(`EXISTS(SELECT 1 FROM node_categories fnc WHERE fnc.node_id=n.id AND fnc.category_id IN
        (WITH RECURSIVE cats(id) AS (SELECT id FROM categories WHERE id=? UNION ALL SELECT c.id FROM categories c JOIN cats ON c.parent_id=cats.id) SELECT id FROM cats))`);
      params.push(String(query.categoryId));
    }
    const tagIds = queryList(query.tagIds);
    if (tagIds.length) {
      where.push(`(SELECT count(DISTINCT nt.tag_id) FROM node_tags nt WHERE nt.node_id=n.id AND nt.tag_id IN (${tagIds.map(() => "?").join(",")}))=?`);
      params.push(...tagIds, tagIds.length);
    }
    if (query.locationId) {
      if (String(query.includeDescendants) === "false") { where.push("n.parent_id=?"); params.push(String(query.locationId)); }
      else {
        where.push(`n.id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM nodes WHERE id=? UNION ALL SELECT c.id FROM nodes c JOIN tree ON c.parent_id=tree.id) SELECT id FROM tree)`);
        params.push(String(query.locationId));
      }
    }
    const rows = this.database.db.prepare(`${nodeSelect.replace(" FROM nodes", ",p.category_id categoryId,p.specification FROM nodes")} n JOIN item_profiles p ON p.node_id=n.id
      WHERE ${where.join(" AND ")} ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as any[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map((node) => {
      const specifications = this.specificationsForNode(node.id);
      const categories = this.categoriesForNode(node.id);
      return { ...serializeNode(this.database.db, node), categoryId: categories[0]?.id ?? null, category: categories[0] ?? null, categories, specification: specifications.map((item) => item.name).join(" / ") || null, specifications, tags: this.tagsForNode(node.id), images: this.media.listForNode(node.id) };
    }), nextCursor: hasMore ? encodeCursor(offset + limit) : null };
  }

  listLocations(query: Record<string, unknown>): any {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = decodeCursor(query.cursor);
    const where = ["n.type<>'ITEM'"];
    const params: unknown[] = [];
    if (query.type) { where.push("n.type=?"); params.push(String(query.type)); }
    if (query.parentId) { where.push("n.parent_id=?"); params.push(String(query.parentId)); }
    if (query.status) { where.push("n.stock_status=?"); params.push(String(query.status)); }
    if (query.q) {
      const pattern = `%${String(query.q).trim()}%`;
      where.push(`(n.code LIKE ? OR n.name LIKE ?
        OR EXISTS(SELECT 1 FROM node_tags qnt JOIN tags qt ON qt.id=qnt.tag_id WHERE qnt.node_id=n.id AND qt.name LIKE ?)
        OR EXISTS(SELECT 1 FROM node_specifications qns JOIN specifications qs ON qs.id=qns.specification_id WHERE qns.node_id=n.id AND qs.name LIKE ?)
        OR EXISTS(SELECT 1 FROM node_categories qnc JOIN categories qc ON qc.id=qnc.category_id WHERE qnc.node_id=n.id AND qc.name LIKE ?))`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (query.categoryId) {
      where.push(`EXISTS(SELECT 1 FROM node_categories fnc WHERE fnc.node_id=n.id AND fnc.category_id IN
        (WITH RECURSIVE cats(id) AS (SELECT id FROM categories WHERE id=? UNION ALL SELECT c.id FROM categories c JOIN cats ON c.parent_id=cats.id) SELECT id FROM cats))`);
      params.push(String(query.categoryId));
    }
    const tagIds = queryList(query.tagIds);
    if (tagIds.length) {
      where.push(`(SELECT count(DISTINCT nt.tag_id) FROM node_tags nt WHERE nt.node_id=n.id AND nt.tag_id IN (${tagIds.map(() => "?").join(",")}))=?`);
      params.push(...tagIds, tagIds.length);
    }
    const specificationIds = queryList(query.specificationIds);
    if (specificationIds.length) {
      where.push(`(SELECT count(DISTINCT ns.specification_id) FROM node_specifications ns WHERE ns.node_id=n.id AND ns.specification_id IN (${specificationIds.map(() => "?").join(",")}))=?`);
      params.push(...specificationIds, specificationIds.length);
    }
    if (query.locationId) {
      if (String(query.includeDescendants) === "false") {
        where.push("n.parent_id=?");
        params.push(String(query.locationId));
      } else {
        where.push(`n.id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM nodes WHERE id=? UNION ALL SELECT c.id FROM nodes c JOIN tree ON c.parent_id=tree.id) SELECT id FROM tree)`);
        params.push(String(query.locationId));
      }
    }
    const rows = this.database.db.prepare(`${nodeSelect} n WHERE ${where.join(" AND ")} ORDER BY n.is_system_staging DESC,n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit + 1, offset) as any[];
    return {
      items: rows.slice(0, limit).map((node) => {
        const specifications = this.specificationsForNode(node.id);
        const categories = this.categoriesForNode(node.id);
        return {
          ...serializeNode(this.database.db, node),
          counts: this.countContents(node.id),
          categoryId: categories[0]?.id ?? null,
          category: categories[0] ?? null,
          categories,
          specification: specifications.map((item) => item.name).join(" / ") || null,
          specifications,
          tags: this.tagsForNode(node.id),
          images: this.media.listForNode(node.id),
        };
      }),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  listContentCandidates(targetId: string, query: Record<string, unknown>): any {
    const target = getNode(this.database.db, targetId);
    invariant(target.type !== "ITEM", "INVALID_PARENT_TYPE", "物品不能包含其他档案");
    invariant(
      target.type === "WAREHOUSE" || target.stockStatus === "IN_STOCK",
      "INVALID_STATE",
      "目标位置当前不可用",
    );
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100);
    const offset = decodeCursor(query.cursor);
    const allowedTypes: NodeType[] = target.type === "BAG"
      ? ["ITEM"]
      : target.type === "BOX"
        ? ["BAG", "ITEM"]
        : ["BOX", "BAG", "ITEM"];
    const requestedTypes = queryList(query.types) as NodeType[];
    invariant(
      requestedTypes.every((type) => allowedTypes.includes(type)),
      "VALIDATION_ERROR",
      "包含目标位置不支持的档案类型",
    );
    const types = requestedTypes.length ? requestedTypes : allowedTypes;
    const where = [
      "n.stock_status='IN_STOCK'",
      `n.id NOT IN (WITH RECURSIVE target_tree(id) AS (
        SELECT id FROM nodes WHERE id=?
        UNION ALL SELECT child.id FROM nodes child JOIN target_tree parent ON child.parent_id=parent.id
      ) SELECT id FROM target_tree)`,
      `n.type IN (${types.map(() => "?").join(",")})`,
    ];
    const params: unknown[] = [target.id, ...types];
    if (query.q) {
      const pattern = `%${String(query.q).trim()}%`;
      where.push(`(n.code LIKE ? OR n.name LIKE ?
        OR EXISTS(SELECT 1 FROM node_tags qnt JOIN tags qt ON qt.id=qnt.tag_id WHERE qnt.node_id=n.id AND qt.name LIKE ?)
        OR EXISTS(SELECT 1 FROM node_specifications qns JOIN specifications qs ON qs.id=qns.specification_id WHERE qns.node_id=n.id AND qs.name LIKE ?)
        OR EXISTS(SELECT 1 FROM node_categories qnc JOIN categories qc ON qc.id=qnc.category_id WHERE qnc.node_id=n.id AND qc.name LIKE ?))`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (query.categoryId) {
      where.push(`EXISTS(SELECT 1 FROM node_categories fnc WHERE fnc.node_id=n.id AND fnc.category_id IN
        (WITH RECURSIVE cats(id) AS (SELECT id FROM categories WHERE id=? UNION ALL SELECT c.id FROM categories c JOIN cats ON c.parent_id=cats.id) SELECT id FROM cats))`);
      params.push(String(query.categoryId));
    }
    const tagIds = queryList(query.tagIds);
    if (tagIds.length) {
      where.push(`(SELECT count(DISTINCT nt.tag_id) FROM node_tags nt WHERE nt.node_id=n.id AND nt.tag_id IN (${tagIds.map(() => "?").join(",")}))=?`);
      params.push(...tagIds, tagIds.length);
    }
    if (query.locationId) {
      where.push(`n.id IN (WITH RECURSIVE tree(id) AS (
        SELECT id FROM nodes WHERE id=? UNION ALL SELECT c.id FROM nodes c JOIN tree ON c.parent_id=tree.id
      ) SELECT id FROM tree)`);
      params.push(String(query.locationId));
    }
    const rows = this.database.db.prepare(`${nodeSelect} n
      WHERE ${where.join(" AND ")} ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit + 1, offset) as any[];
    return {
      items: rows.slice(0, limit).map((node) => {
        const specifications = this.specificationsForNode(node.id);
        const categories = this.categoriesForNode(node.id);
        return {
          ...serializeNode(this.database.db, node),
          categoryId: categories[0]?.id ?? null,
          category: categories[0] ?? null,
          categories,
          specification: specifications.map((item) => item.name).join(" / ") || null,
          specifications,
          tags: this.tagsForNode(node.id),
          images: this.media.listForNode(node.id),
        };
      }),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  contents(nodeId: string, recursive = true, limit = 100, cursor?: unknown, providedTreeToken?: string): any {
    const root = getNode(this.database.db, nodeId);
    invariant(root.type !== "ITEM", "INVALID_PARENT_TYPE", "物品没有内容列表");
    const token = subtreeToken(this.database.db, nodeId);
    if (providedTreeToken) invariant(providedTreeToken === token, "SUBTREE_CHANGED", "位置内容已变化，请重新加载");
    const offset = decodeCursor(cursor);
    const all = recursive ? getDescendants(this.database.db, nodeId).slice(1) : this.database.db.prepare(`${nodeSelect} WHERE parent_id=? ORDER BY type,code`).all(nodeId) as any[];
    const page = all.slice(offset, offset + Math.min(limit, 100));
    return {
      root: {
        ...serializeNode(this.database.db, root),
        images: this.media.listForNode(root.id),
      },
      items: page.map((node: any) => {
        const categories = this.categoriesForNode(node.id);
        const specifications = this.specificationsForNode(node.id);
        return {
          ...serializeNode(this.database.db, node),
          depth: getPath(this.database.db, node.id).length - getPath(this.database.db, root.id).length,
          categoryId: categories[0]?.id ?? null,
          category: categories[0] ?? null,
          categories,
          specification: specifications.map((item) => item.name).join(" / ") || null,
          specifications,
          tags: this.tagsForNode(node.id),
          images: this.media.listForNode(node.id),
        };
      }),
      counts: this.countContents(nodeId),
      categorySummary: this.categorySummary(nodeId),
      treeToken: token,
      nextCursor: offset + page.length < all.length ? encodeCursor(offset + page.length) : null,
    };
  }

  dashboard(): any {
    const byStatus = this.database.db.prepare(`SELECT stock_status status,count(*) count FROM nodes WHERE type='ITEM' GROUP BY stock_status`).all();
    const byType = this.database.db.prepare("SELECT type,count(*) count FROM nodes GROUP BY type").all();
    const recent = this.database.db.prepare("SELECT id,action,summary,created_at createdAt FROM operation_logs ORDER BY created_at DESC LIMIT 8").all();
    const pendingPrints = (this.database.db.prepare("SELECT count(*) count FROM print_items WHERE state IN ('QUEUED','SENDING','FAILED','UNKNOWN')").get() as any).count;
    const typeCounts = Object.fromEntries((byType as any[]).map((row) => [row.type, Number(row.count)]));
    const stagingCount = Number((this.database.db.prepare("SELECT count(*) count FROM nodes WHERE parent_id=?").get(this.database.stagingNodeId) as any).count);
    const stagingItems = (this.database.db.prepare(`${nodeSelect} WHERE parent_id=? ORDER BY created_at DESC LIMIT 6`).all(this.database.stagingNodeId) as any[])
      .map((node) => ({ ...serializeNode(this.database.db, node), images: this.media.listForNode(node.id) }));
    return {
      counts: {
        items: typeCounts.ITEM ?? 0,
        bags: typeCounts.BAG ?? 0,
        boxes: typeCounts.BOX ?? 0,
        warehouses: typeCounts.WAREHOUSE ?? 0,
        staging: stagingCount,
        attention: Number(pendingPrints),
      },
      recentOperations: (recent as any[]).map(serializeTime),
      stagingItems,
      byStatus,
      byType,
      recent: (recent as any[]).map(serializeTime),
      pendingPrints,
      dataRevision: this.database.dataRevision,
    };
  }

  operations(query: Record<string, unknown>): any {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = decodeCursor(query.cursor);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.action) { where.push("o.action=?"); params.push(query.action); }
    if (query.nodeId) { where.push("EXISTS(SELECT 1 FROM operation_targets ot WHERE ot.operation_id=o.id AND ot.node_id=?)"); params.push(query.nodeId); }
    const rows = this.database.db.prepare(`SELECT o.id,o.request_id requestId,o.action,o.subject_type subjectType,o.subject_id subjectId,
      o.reason,o.reverses_operation_id reversesOperationId,o.summary,o.created_at createdAt FROM operation_logs o
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as any[];
    return { items: rows.slice(0, limit).map(serializeTime), nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null };
  }

  operationDetail(id: string): any {
    const row = this.database.db.prepare(`SELECT id,request_id requestId,action,subject_type subjectType,subject_id subjectId,before_snapshot beforeSnapshot,
      after_snapshot afterSnapshot,reason,reverses_operation_id reversesOperationId,summary,created_at createdAt FROM operation_logs WHERE id=?`).get(id) as any;
    if (!row) throw new AppError("NOT_FOUND", "操作记录不存在");
    const targets = this.database.db.prepare(`SELECT node_id nodeId,code_snapshot code,directly_operated directlyOperated,
      before_snapshot beforeSnapshot,after_snapshot afterSnapshot FROM operation_targets WHERE operation_id=?`).all(id) as any[];
    return { ...serializeTime(row), beforeSnapshot: parseJson(row.beforeSnapshot), afterSnapshot: parseJson(row.afterSnapshot), targets: targets.map((target) => ({ ...target, directlyOperated: Boolean(target.directlyOperated), beforeSnapshot: parseJson(target.beforeSnapshot), afterSnapshot: parseJson(target.afterSnapshot) })) };
  }

  private reserveCode(identity: RequestIdentity, type: NodeType): { nodeId: string; code: string } {
    return this.database.transaction(() => {
      const existing = this.database.db.prepare("SELECT node_id nodeId,code,payload_hash payloadHash FROM code_reservations WHERE user_id=? AND request_id=?")
        .get(identity.userId, identity.requestId) as any;
      const payloadHash = this.database.payloadHash(identity.payload);
      if (existing) {
        invariant(existing.payloadHash === payloadHash, "IDEMPOTENCY_CONFLICT", "相同请求编号对应了不同内容");
        return existing;
      }
      const prefix = type === "WAREHOUSE" ? "W" : type === "ITEM" ? "I" : "C";
      const code = this.database.nextCode(prefix);
      const nodeId = randomUUID();
      const now = Date.now();
      this.database.db.prepare(`INSERT INTO code_reservations(code,node_id,user_id,request_id,payload_hash,state,created_at,updated_at)
        VALUES(?,?,?,?,?,'RESERVED',?,?)`).run(code, nodeId, identity.userId, identity.requestId, payloadHash, now, now);
      return { nodeId, code };
    });
  }

  private validateTaxonomy(categoryIds: string[], tagIds: string[], specificationIds: string[], type: NodeType, categoryUnchanged = false): void {
    const uniqueCategories = [...new Set(categoryIds)];
    invariant(uniqueCategories.length === categoryIds.length, "VALIDATION_ERROR", "分类不能重复");
    invariant(uniqueCategories.length <= 3, "VALIDATION_ERROR", "每个档案最多选择三个分类");
    if (type === "ITEM" && !categoryUnchanged) invariant(uniqueCategories.length > 0, "VALIDATION_ERROR", "物品必须至少选择一个分类");
    const findCategory = this.database.db.prepare("SELECT 1 FROM categories WHERE id=?");
    invariant(uniqueCategories.every((id) => Boolean(findCategory.get(id))), "VALIDATION_ERROR", "包含不存在的分类");
    const uniqueTags = [...new Set(tagIds)];
    invariant(uniqueTags.length === tagIds.length, "VALIDATION_ERROR", "标签不能重复");
    const findTag = this.database.db.prepare("SELECT 1 FROM tags WHERE id=?");
    invariant(uniqueTags.every((id) => Boolean(findTag.get(id))), "VALIDATION_ERROR", "包含不存在的标签");
    const uniqueSpecifications = [...new Set(specificationIds)];
    invariant(uniqueSpecifications.length === specificationIds.length, "VALIDATION_ERROR", "规格不能重复");
    const findSpecification = this.database.db.prepare("SELECT 1 FROM specifications WHERE id=?");
    invariant(uniqueSpecifications.every((id) => Boolean(findSpecification.get(id))), "VALIDATION_ERROR", "包含不存在的规格");
  }

  private replaceTags(nodeId: string, tagIds: string[]): void {
    this.database.db.prepare("DELETE FROM node_tags WHERE node_id=?").run(nodeId);
    const insert = this.database.db.prepare("INSERT INTO node_tags(node_id,tag_id) VALUES(?,?)");
    [...new Set(tagIds)].forEach((tagId) => insert.run(nodeId, tagId));
  }

  private replaceCategories(nodeId: string, categoryIds: string[], type: NodeType): void {
    invariant(type !== "ITEM" || categoryIds.length > 0, "VALIDATION_ERROR", "物品必须至少选择一个分类");
    this.database.db.prepare("DELETE FROM node_categories WHERE node_id=?").run(nodeId);
    const insert = this.database.db.prepare(`INSERT INTO node_categories(node_id,category_id,sort_order)
      VALUES(?,?,?)`);
    [...new Set(categoryIds)].forEach((categoryId, index) => insert.run(nodeId, categoryId, index));
    if (type === "ITEM") {
      this.database.db.prepare("UPDATE item_profiles SET category_id=? WHERE node_id=?").run(categoryIds[0], nodeId);
    }
  }

  private categoriesForNode(nodeId: string): any[] {
    return this.database.db.prepare(`SELECT c.id,c.name,c.parent_id parentId,c.version FROM categories c
      JOIN node_categories nc ON nc.category_id=c.id
      WHERE nc.node_id=? ORDER BY nc.sort_order,c.name,c.id`).all(nodeId);
  }

  private tagsForNode(nodeId: string): any[] {
    return this.database.db.prepare(`SELECT t.id,t.name,t.version FROM tags t JOIN node_tags nt ON nt.tag_id=t.id
      WHERE nt.node_id=? ORDER BY t.name,t.id`).all(nodeId);
  }

  private replaceSpecifications(nodeId: string, specificationIds: string[]): void {
    this.database.db.prepare("DELETE FROM node_specifications WHERE node_id=?").run(nodeId);
    const insert = this.database.db.prepare(`INSERT INTO node_specifications(node_id,specification_id,sort_order)
      VALUES(?,?,?)`);
    [...new Set(specificationIds)].forEach((specificationId, index) => insert.run(nodeId, specificationId, index));
    const legacyValue = this.specificationsForNode(nodeId).map((item) => item.name).join(" / ").slice(0, 500);
    this.database.db.prepare("UPDATE item_profiles SET specification=? WHERE node_id=?").run(legacyValue, nodeId);
  }

  private specificationsForNode(nodeId: string): any[] {
    return this.database.db.prepare(`SELECT s.id,s.name,s.version FROM specifications s
      JOIN node_specifications ns ON ns.specification_id=s.id
      WHERE ns.node_id=? ORDER BY ns.sort_order,s.name,s.id`).all(nodeId);
  }

  private replaceImages(node: any, entries: NonNullable<PatchProfileInput["images"]>, prepared: PreparedImage[]): void {
    invariant(entries.length <= 5, "IMAGE_LIMIT", "每个档案最多五张图片");
    invariant(node.type !== "ITEM" || entries.length >= 1, "IMAGE_REQUIRED", "物品至少需要一张图片");
    const existingIds = entries.flatMap((entry) => "imageId" in entry ? [entry.imageId] : []);
    if (existingIds.length) {
      const placeholders = existingIds.map(() => "?").join(",");
      const count = (this.database.db.prepare(`SELECT count(*) count FROM images WHERE owner_node_id=? AND status='ACTIVE' AND id IN (${placeholders})`).get(node.id, ...existingIds) as any).count;
      invariant(count === existingIds.length, "VALIDATION_ERROR", "包含不属于当前档案的图片");
    }
    const removed = this.database.db.prepare(`SELECT main_key mainKey,thumb_key thumbKey FROM images WHERE owner_node_id=? AND status='ACTIVE'
      ${existingIds.length ? `AND id NOT IN (${existingIds.map(() => "?").join(",")})` : ""}`).all(node.id, ...existingIds) as any[];
    this.media.queueImageCleanup(removed);
    if (existingIds.length) this.database.db.prepare(`DELETE FROM images WHERE owner_node_id=? AND id NOT IN (${existingIds.map(() => "?").join(",")})`).run(node.id, ...existingIds);
    else this.database.db.prepare("DELETE FROM images WHERE owner_node_id=?").run(node.id);
    this.media.insertPrepared(node.id, prepared);
    entries.forEach((entry, index) => {
      const id = "imageId" in entry ? entry.imageId : entry.uploadId;
      this.database.db.prepare("UPDATE images SET sort_order=?,updated_at=? WHERE id=? AND owner_node_id=?").run(index, Date.now(), id, node.id);
    });
  }

  private logOperation(requestId: string, userId: string, action: string, node: any, before: unknown, after: unknown, directly: boolean, reason?: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.database.db.prepare(`INSERT INTO operation_logs(id,request_id,actor_id,client_kind,action,subject_type,subject_id,before_snapshot,after_snapshot,reason,summary,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, requestId, userId, "WEB", action, node.type, node.id,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason ?? null, `${action} ${node.code}`, now);
    this.database.db.prepare(`INSERT INTO operation_targets(operation_id,node_id,code_snapshot,directly_operated,before_snapshot,after_snapshot)
      VALUES(?,?,?,?,?,?)`).run(id, node.id, node.code, directly ? 1 : 0, JSON.stringify(before ?? {}), JSON.stringify(after ?? {}));
    return id;
  }

  private placeInitialContent(
    requestId: string,
    userId: string,
    target: ReturnType<typeof getNode>,
    input: NonNullable<CreateNodeInput["initialContent"]>,
    now: number,
  ): string {
    const source = getNode(this.database.db, input.nodeId);
    invariant(source.type !== "WAREHOUSE", "INVALID_PARENT_TYPE", "仓库不能放入其他位置");
    invariant(source.stockStatus === "IN_STOCK", "INVALID_STATE", "只有在库对象可以放入新位置");
    invariant(
      source.locationVersion === input.expectedLocationVersion &&
        locationToken(this.database.db, source.id) === input.locationToken,
      "LOCATION_CHANGED",
      "待放入对象的位置已变化",
      {
        nodeId: source.id,
        currentVersion: source.locationVersion,
        currentPath: getPath(this.database.db, source.id),
      },
    );
    const descendants = getDescendants(this.database.db, source.id);
    invariant(descendants.length <= 5000, "VALIDATION_ERROR", "单次操作展开后不能超过 5000 个节点");
    if (source.type !== "ITEM") {
      invariant(Boolean(input.subtreeToken), "VALIDATION_ERROR", "容器操作必须携带子树令牌");
      invariant(
        subtreeToken(this.database.db, source.id) === input.subtreeToken,
        "SUBTREE_CHANGED",
        "待放入容器的内容已变化",
        { nodeId: source.id },
      );
    }
    validateParent(source.type, target);

    const before = descendants.map((entry) => snapshotNode(this.database.db, entry));
    this.database.db.prepare(
      "UPDATE nodes SET parent_id=?,location_version=location_version+1,updated_at=? WHERE id=?",
    ).run(target.id, now, source.id);

    const operationId = randomUUID();
    this.database.db.prepare(`INSERT INTO operation_logs(id,request_id,actor_id,client_kind,action,subject_type,subject_id,reason,reverses_operation_id,summary,created_at)
      VALUES(?,?,?,?,?,'BATCH',NULL,NULL,NULL,?,?)`).run(
      operationId,
      requestId,
      userId,
      "WEB",
      "MOVE",
      `MOVE 1 个直接对象到 ${target.code}`,
      now,
    );
    const insertTarget = this.database.db.prepare(`INSERT INTO operation_targets(operation_id,node_id,code_snapshot,directly_operated,before_snapshot,after_snapshot)
      VALUES(?,?,?,?,?,?)`);
    descendants.forEach((previous, index) => {
      const current = getNode(this.database.db, previous.id);
      insertTarget.run(
        operationId,
        current.id,
        current.code,
        index === 0 ? 1 : 0,
        JSON.stringify(before[index]),
        JSON.stringify(snapshotNode(this.database.db, current)),
      );
    });
    return operationId;
  }

  private countContents(nodeId: string): { directContainers: number; directItems: number; recursiveItems: number } {
    const direct = this.database.db.prepare(`SELECT sum(CASE WHEN type IN ('BOX','BAG') THEN 1 ELSE 0 END) directContainers,
      sum(CASE WHEN type='ITEM' THEN 1 ELSE 0 END) directItems FROM nodes WHERE parent_id=?`).get(nodeId) as any;
    const recursiveItems = getDescendants(this.database.db, nodeId).filter((node) => node.id !== nodeId && node.type === "ITEM").length;
    return { directContainers: Number(direct.directContainers ?? 0), directItems: Number(direct.directItems ?? 0), recursiveItems };
  }

  private categorySummary(nodeId: string): any[] {
    return this.database.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM nodes WHERE parent_id=? UNION ALL SELECT n.id FROM nodes n JOIN tree t ON n.parent_id=t.id)
      SELECT c.id,c.name,count(DISTINCT nc.node_id) itemCount FROM tree t
      JOIN node_categories nc ON nc.node_id=t.id JOIN categories c ON c.id=nc.category_id
      GROUP BY c.id,c.name ORDER BY itemCount DESC,c.name`).all(nodeId);
  }
}

const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
const decodeCursor = (cursor: unknown): number => {
  if (!cursor) return 0;
  try { return Math.max(0, Number(JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")).offset) || 0); }
  catch { throw new AppError("VALIDATION_ERROR", "分页游标无效"); }
};
const parseJson = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
const serializeTime = (value: any): any => ({ ...value, createdAt: new Date(value.createdAt).toISOString() });
const queryList = (value: unknown): string[] => {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(values.flatMap((entry) => String(entry).split(",")).map((entry) => entry.trim()).filter(Boolean))];
};
