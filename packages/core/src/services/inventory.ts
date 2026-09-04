import { randomUUID } from "node:crypto";
import type { InventoryAction, OperationInput } from "@inventory-hub/contracts";
import type { InventoryDatabase } from "../db/database.js";
import { getDescendants, getNode, getPath, locationToken, snapshotNode, subtreeToken, validateParent } from "../domain/model.js";
import { invariant } from "../errors.js";
import type { IdempotencyService, RequestIdentity } from "./idempotency.js";

export class InventoryService {
  constructor(private readonly database: InventoryDatabase, private readonly idempotency: IdempotencyService) {}

  preview(input: OperationInput): any {
    const resolvedTargetId = this.resolveTarget(input.action, input.targetId);
    this.validateTargetSelection(input.targets.map((target) => target.nodeId));
    const target = resolvedTargetId ? getNode(this.database.db, resolvedTargetId) : null;
    const targets = input.targets.map(({ nodeId }) => {
      const node = getNode(this.database.db, nodeId);
      const descendants = getDescendants(this.database.db, nodeId);
      this.validateAction(input.action, node, descendants, target);
      return {
        node: snapshotNode(this.database.db, node),
        expectedLocationVersion: node.locationVersion,
        locationToken: locationToken(this.database.db, node.id),
        subtreeToken: node.type === "ITEM" ? undefined : subtreeToken(this.database.db, node.id),
        affectedNodeCount: descendants.length,
        recursiveItemCount: descendants.filter((entry) => entry.type === "ITEM").length,
        changed: !this.isNoop(input.action, node, resolvedTargetId),
      };
    });
    const roots = targets.map((entry) => ({
      ...entry.node,
      affectedCount: entry.affectedNodeCount,
      recursiveItemCount: entry.recursiveItemCount,
      expectedLocationVersion: entry.expectedLocationVersion,
      locationToken: entry.locationToken,
      subtreeToken: entry.subtreeToken,
    }));
    return {
      action: input.action,
      target: target ? snapshotNode(this.database.db, target) : null,
      targetLocationToken: target ? locationToken(this.database.db, target.id) : null,
      roots,
      targets,
      affectedCount: targets.reduce((sum, item) => sum + item.affectedNodeCount, 0),
      affectedNodeCount: targets.reduce((sum, item) => sum + item.affectedNodeCount, 0),
      valid: true,
    };
  }

  commit(identity: RequestIdentity, input: OperationInput): any {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    return this.database.transaction(() => {
      const repeated = this.idempotency.lookup(identity);
      if (repeated) return repeated;
      const resolvedTargetId = this.resolveTarget(input.action, input.targetId);
      this.validateTargetSelection(input.targets.map((target) => target.nodeId));
      const targetNode = resolvedTargetId ? getNode(this.database.db, resolvedTargetId) : null;
      if (targetNode) {
        invariant(Boolean(input.targetLocationToken), "VALIDATION_ERROR", "提交库存操作必须携带目标位置令牌");
        invariant(locationToken(this.database.db, targetNode.id) === input.targetLocationToken, "LOCATION_CHANGED", "目标位置已变化");
      }
      const prepared = input.targets.map((targetInput) => {
        const node = getNode(this.database.db, targetInput.nodeId);
        invariant(targetInput.expectedLocationVersion !== undefined && targetInput.locationToken, "VALIDATION_ERROR", "提交库存操作必须携带位置版本和令牌");
        invariant(node.locationVersion === targetInput.expectedLocationVersion && locationToken(this.database.db, node.id) === targetInput.locationToken,
          "LOCATION_CHANGED", "对象位置已变化", { nodeId: node.id, currentVersion: node.locationVersion, currentPath: getPath(this.database.db, node.id) });
        if (node.type !== "ITEM") {
          invariant(Boolean(targetInput.subtreeToken), "VALIDATION_ERROR", "容器操作必须携带子树令牌");
          invariant(subtreeToken(this.database.db, node.id) === targetInput.subtreeToken, "SUBTREE_CHANGED", "容器内容已变化", { nodeId: node.id });
        }
        const descendants = getDescendants(this.database.db, node.id);
        invariant(descendants.length <= 5000, "VALIDATION_ERROR", "单次操作展开后不能超过 5000 个节点");
        this.validateAction(input.action, node, descendants, targetNode);
        return { input: targetInput, node, descendants, before: descendants.map((entry) => snapshotNode(this.database.db, entry)) };
      });
      const changedTargets = prepared.filter(({ node }) => !this.isNoop(input.action, node, resolvedTargetId));
      if (!changedTargets.length) {
        const value = { operationId: null, changed: false, nodes: prepared.map(({ node }) => ({ id: node.id, code: node.code, locationVersion: node.locationVersion })) };
        this.idempotency.persistSuccess(identity, value);
        return value;
      }
      const now = Date.now();
      for (const item of changedTargets) this.apply(input.action, item.node, item.descendants, resolvedTargetId, now);
      const operationId = randomUUID();
      this.database.db.prepare(`INSERT INTO operation_logs(id,request_id,actor_id,client_kind,action,subject_type,subject_id,reason,reverses_operation_id,summary,created_at)
        VALUES(?,?,?,?,?,'BATCH',NULL,?,?,?,?)`).run(operationId, identity.requestId, identity.userId, "WEB", input.action,
        input.reason ?? null, input.reversesOperationId ?? null, `${input.action} ${changedTargets.length} 个直接对象`, now);
      const targetInsert = this.database.db.prepare(`INSERT INTO operation_targets(operation_id,node_id,code_snapshot,directly_operated,before_snapshot,after_snapshot)
        VALUES(?,?,?,?,?,?)`);
      for (const item of changedTargets) {
        item.descendants.forEach((previous, index) => {
          const current = getNode(this.database.db, previous.id);
          targetInsert.run(operationId, current.id, current.code, index === 0 ? 1 : 0, JSON.stringify(item.before[index]), JSON.stringify(snapshotNode(this.database.db, current)));
        });
      }
      this.database.bumpRevision();
      const value = {
        operationId,
        changed: true,
        nodes: prepared.map(({ node }) => {
          const current = getNode(this.database.db, node.id);
          return { id: current.id, code: current.code, locationVersion: current.locationVersion, locationToken: locationToken(this.database.db, current.id) };
        }),
      };
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
  }

  private resolveTarget(action: InventoryAction, targetId: string | undefined): string | null {
    if (["REMOVE", "CHECK_IN", "RESTORE"].includes(action)) return targetId ?? this.database.stagingNodeId;
    return targetId ?? null;
  }

  private validateTargetSelection(ids: string[]): void {
    invariant(new Set(ids).size === ids.length, "VALIDATION_ERROR", "批次对象不能重复");
    for (const id of ids) {
      const ancestors = new Set(getPath(this.database.db, id).slice(1).map((node) => node.id));
      invariant(!ids.some((other) => other !== id && ancestors.has(other)), "VALIDATION_ERROR", "批次不能同时选择祖先与后代");
    }
  }

  private validateAction(action: InventoryAction, node: any, descendants: any[], target: any | null): void {
    invariant(node.type !== "WAREHOUSE", "INVALID_STATE", "仓库不支持库存状态动作");
    if (["MOVE", "REMOVE"].includes(action)) {
      invariant(node.stockStatus === "IN_STOCK", "INVALID_STATE", "只有在库对象可以移位");
      invariant(Boolean(target), "VALIDATION_ERROR", "移位需要目标位置");
      validateParent(node.type, target);
    } else if (action === "CHECK_OUT") {
      invariant(node.stockStatus === "IN_STOCK", "INVALID_STATE", "只有在库对象可以出库");
    } else if (action === "CHECK_IN") {
      invariant(node.stockStatus === "OUT", "INVALID_STATE", "只有已出库对象可以入库");
      invariant(descendants.every((entry) => entry.type === "WAREHOUSE" || entry.stockStatus === "OUT"), "DATA_INTEGRITY_ERROR", "离库子树状态不一致");
      invariant(Boolean(target), "VALIDATION_ERROR", "入库需要目标位置");
      validateParent(node.type, target);
    } else if (action === "DISCARD") {
      invariant(node.stockStatus === "IN_STOCK" || node.stockStatus === "OUT", "INVALID_STATE", "当前状态不能废弃");
      invariant(node.type === "ITEM" || descendants.length === 1, "NONEMPTY_CONTAINER", "非空容器不能废弃");
    } else if (action === "RESTORE") {
      invariant(node.stockStatus === "DISCARDED", "INVALID_STATE", "只有已废弃对象可以恢复");
      invariant(Boolean(target), "VALIDATION_ERROR", "恢复需要目标位置");
      validateParent(node.type, target);
    }
    if (target) {
      invariant(target.id !== node.id && !descendants.some((entry) => entry.id === target.id), "INVALID_PARENT_TYPE", "不能把对象移入自身或后代");
    }
  }

  private isNoop(action: InventoryAction, node: any, targetId: string | null): boolean {
    return ["MOVE", "REMOVE"].includes(action) && node.parentId === targetId;
  }

  private apply(action: InventoryAction, node: any, descendants: any[], targetId: string | null, now: number): void {
    if (["MOVE", "REMOVE"].includes(action)) {
      this.database.db.prepare("UPDATE nodes SET parent_id=?,location_version=location_version+1,updated_at=? WHERE id=?").run(targetId, now, node.id);
      return;
    }
    if (action === "CHECK_OUT") {
      const previousPath = JSON.stringify(getPath(this.database.db, node.id).map((entry) => ({ id: entry.id, code: entry.code, name: entry.name, type: entry.type })));
      this.database.db.prepare("UPDATE nodes SET parent_id=NULL,stock_status='OUT',location_version=location_version+1,last_in_stock_path=?,updated_at=? WHERE id=?").run(previousPath, now, node.id);
      const update = this.database.db.prepare("UPDATE nodes SET stock_status='OUT',location_version=location_version+1,updated_at=? WHERE id=?");
      descendants.slice(1).forEach((entry) => update.run(now, entry.id));
      return;
    }
    if (action === "CHECK_IN") {
      this.database.db.prepare("UPDATE nodes SET parent_id=?,stock_status='IN_STOCK',location_version=location_version+1,updated_at=? WHERE id=?").run(targetId, now, node.id);
      const update = this.database.db.prepare("UPDATE nodes SET stock_status='IN_STOCK',location_version=location_version+1,updated_at=? WHERE id=?");
      descendants.slice(1).forEach((entry) => update.run(now, entry.id));
      return;
    }
    if (action === "DISCARD") {
      this.database.db.prepare("UPDATE nodes SET parent_id=NULL,stock_status='DISCARDED',location_version=location_version+1,updated_at=? WHERE id=?").run(now, node.id);
      return;
    }
    if (action === "RESTORE") {
      this.database.db.prepare("UPDATE nodes SET parent_id=?,stock_status='IN_STOCK',location_version=location_version+1,updated_at=? WHERE id=?").run(targetId, now, node.id);
    }
  }
}
