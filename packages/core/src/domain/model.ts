import { createHash } from "node:crypto";
import type { NodeType, StockStatus } from "@inventory-hub/contracts";
import type { SqliteDatabase } from "../db/database.js";
import { AppError, invariant } from "../errors.js";

export interface NodeRow {
  id: string;
  code: string;
  type: NodeType;
  parentId: string | null;
  stockStatus: StockStatus | null;
  name: string;
  notes: string;
  version: number;
  locationVersion: number;
  isSystemStaging: number;
  lastInStockPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export const nodeSelect = `SELECT id,code,type,parent_id parentId,stock_status stockStatus,name,notes,version,
  location_version locationVersion,is_system_staging isSystemStaging,last_in_stock_path lastInStockPath,
  created_at createdAt,updated_at updatedAt FROM nodes`;

export const getNode = (db: SqliteDatabase, id: string): NodeRow => {
  const row = db.prepare(`${nodeSelect} WHERE id=?`).get(id) as NodeRow | undefined;
  if (!row) {
    const tombstone = db.prepare("SELECT code,type,deleted_at deletedAt FROM node_tombstones WHERE node_id=?").get(id);
    if (tombstone) throw new AppError("NODE_DELETED", "档案已永久删除", { details: tombstone });
    throw new AppError("NOT_FOUND", "档案不存在");
  }
  return row;
};

export const getPath = (db: SqliteDatabase, nodeId: string): NodeRow[] => {
  const path: NodeRow[] = [];
  const seen = new Set<string>();
  let current: string | null = nodeId;
  while (current) {
    if (seen.has(current) || path.length >= 4) throw new AppError("DATA_INTEGRITY_ERROR", "位置树存在循环或深度异常");
    seen.add(current);
    const node = getNode(db, current);
    path.push(node);
    current = node.parentId;
  }
  return path;
};

export const getDescendants = (db: SqliteDatabase, rootId: string): NodeRow[] => {
  const rows = db.prepare(`WITH RECURSIVE tree(id,depth) AS (
    SELECT id,0 FROM nodes WHERE id=?
    UNION ALL SELECT n.id,tree.depth+1 FROM nodes n JOIN tree ON n.parent_id=tree.id WHERE tree.depth < 8
  ) SELECT n.id,n.code,n.type,n.parent_id parentId,n.stock_status stockStatus,n.name,n.notes,n.version,
    n.location_version locationVersion,n.is_system_staging isSystemStaging,n.last_in_stock_path lastInStockPath,
    n.created_at createdAt,n.updated_at updatedAt,tree.depth FROM tree JOIN nodes n ON n.id=tree.id ORDER BY tree.depth,n.code`).all(rootId) as (NodeRow & { depth: number })[];
  if (!rows.length) throw new AppError("NOT_FOUND", "档案不存在");
  if (rows.some((row) => row.depth > 3)) throw new AppError("DATA_INTEGRITY_ERROR", "位置树深度异常");
  return rows;
};

const topologyHash = (nodes: NodeRow[]): string => createHash("sha256").update(JSON.stringify(nodes
  .map((node) => [node.id, node.parentId, node.locationVersion, node.stockStatus])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");

export const locationToken = (db: SqliteDatabase, nodeId: string): string => topologyHash(getPath(db, nodeId));
export const subtreeToken = (db: SqliteDatabase, nodeId: string): string => topologyHash(getDescendants(db, nodeId));

export const snapshotNode = (db: SqliteDatabase, node: NodeRow) => ({
  id: node.id,
  code: node.code,
  type: node.type,
  name: node.name,
  parentId: node.parentId,
  stockStatus: node.stockStatus,
  version: node.version,
  locationVersion: node.locationVersion,
  path: getPath(db, node.id).map((entry) => ({ id: entry.id, code: entry.code, type: entry.type, name: entry.name })),
});

export const validateParent = (childType: NodeType, parent: NodeRow): void => {
  invariant(parent.stockStatus !== "OUT" && parent.stockStatus !== "DISCARDED", "INVALID_STATE", "目标位置不可用");
  const allowed = childType === "BOX"
    ? parent.type === "WAREHOUSE"
    : childType === "BAG"
      ? parent.type === "WAREHOUSE" || parent.type === "BOX"
      : childType === "ITEM"
        ? parent.type === "WAREHOUSE" || parent.type === "BOX" || parent.type === "BAG"
        : false;
  invariant(allowed, "INVALID_PARENT_TYPE", `${childType} 不能放入 ${parent.type}`);
};

export const normalizeName = (value: string): string => value.normalize("NFC").trim();
export const normalizedKey = (value: string): string => normalizeName(value).toLocaleLowerCase("zh-CN");

export const serializeNode = (db: SqliteDatabase, node: NodeRow) => {
  const path = getPath(db, node.id);
  return {
    id: node.id,
    code: node.code,
    type: node.type,
    parentId: node.parentId,
    stockStatus: node.stockStatus,
    name: node.name,
    notes: node.notes,
    version: node.version,
    locationVersion: node.locationVersion,
    isSystemStaging: Boolean(node.isSystemStaging),
    locationToken: locationToken(db, node.id),
    subtreeToken: node.type === "ITEM" ? undefined : subtreeToken(db, node.id),
    path: path.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name, type: entry.type })),
    createdAt: new Date(node.createdAt).toISOString(),
    updatedAt: new Date(node.updatedAt).toISOString(),
  };
};
