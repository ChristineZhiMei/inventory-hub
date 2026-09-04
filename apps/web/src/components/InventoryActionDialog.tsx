import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type {
  InventoryAction,
  InventoryNode,
  OperationPreview,
} from "@/lib/types";
import { Alert, Button, Dialog, Field, Select, Textarea } from "./AntUi";

const labels: Record<
  InventoryAction,
  { title: string; confirm: string; description: string }
> = {
  MOVE: {
    title: "移动到新位置",
    confirm: "确认移动",
    description: "对象仍保持在库，容器中的内容会随容器一起移动。",
  },
  REMOVE: {
    title: "移出到暂存区",
    confirm: "确认移出",
    description: "对象仍保持在库，不是出库；容器内部关系保持不变。",
  },
  CHECK_OUT: {
    title: "办理出库",
    confirm: "确认出库",
    description: "对象会离开仓库。容器出库时，全部后代会一同变为已出库。",
  },
  CHECK_IN: {
    title: "重新入库",
    confirm: "确认入库",
    description: "请确认已经实际放入目标位置；未选择时将进入暂存区。",
  },
  DISCARD: {
    title: "废弃档案",
    confirm: "确认废弃",
    description: "物品或空容器才能废弃，图片与编号会继续保留并可恢复。",
  },
  RESTORE: {
    title: "恢复档案",
    confirm: "确认恢复",
    description: "恢复后进入所选位置；未选择时进入暂存区。",
  },
};

export function InventoryActionDialog({
  open,
  action,
  nodes,
  onClose,
  reversesOperationId,
}: {
  open: boolean;
  action: InventoryAction;
  nodes: InventoryNode[];
  onClose: () => void;
  reversesOperationId?: string;
}) {
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const requiresTarget = action === "MOVE";
  const optionalTarget = action === "CHECK_IN" || action === "RESTORE";
  const locations = useQuery({
    queryKey: ["locations", "action-target", action],
    queryFn: () => queries.locations("limit=100"),
    enabled: open && (requiresTarget || optionalTarget),
  });
  const allowed = useMemo(() => {
    const parentTypes: Record<InventoryNode["type"], InventoryNode["type"][]> =
      {
        WAREHOUSE: [],
        BOX: ["WAREHOUSE"],
        BAG: ["WAREHOUSE", "BOX"],
        ITEM: ["WAREHOUSE", "BOX", "BAG"],
      };
    return pageItems(locations.data).filter(
      (target) =>
        !target.isSystemStaging &&
        !nodes.some(
          (node) =>
            node.id === target.id ||
            target.ancestorIds?.includes(node.id) ||
            target.path?.some((entry) => entry.id === node.id),
        ) &&
        nodes.every((node) => parentTypes[node.type].includes(target.type)) &&
        (!target.stockStatus || target.stockStatus === "IN_STOCK"),
    );
  }, [locations.data, nodes]);
  const previewMutation = useMutation({
    mutationFn: () =>
      api<OperationPreview>("/inventory/preview", {
        method: "POST",
        body: {
          action,
          targets: nodes.map((node) => ({ nodeId: node.id })),
          targetId: targetId || undefined,
          reason: reason || undefined,
          reversesOperationId,
        },
      }),
    onSuccess: setPreview,
  });
  const commitMutation = useMutation({
    mutationFn: () =>
      api("/inventory/operations", {
        method: "POST",
        idempotent: true,
        body: {
          action,
          targets: nodes.map((node) => ({
            nodeId: node.id,
            expectedLocationVersion: node.locationVersion,
            locationToken: node.locationToken,
            subtreeToken: node.subtreeToken,
          })),
          targetId: targetId || undefined,
          targetLocationToken: preview?.targetLocationToken,
          reason: reason || undefined,
          reversesOperationId,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onClose();
    },
  });
  useEffect(() => {
    if (open) {
      setPreview(null);
      setTargetId("");
      setReason("");
    }
  }, [open, action]);
  useEffect(() => setPreview(null), [targetId, reason]);
  const copy = labels[action];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={copy.title}
      description={`${nodes.length} 个直接对象`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          {preview ? (
            <Button
              variant={
                action === "DISCARD" || action === "CHECK_OUT"
                  ? "destructive"
                  : "default"
              }
              onClick={() => commitMutation.mutate()}
              loading={commitMutation.isPending}
              disabled={!preview.valid}
            >
              {copy.confirm}
            </Button>
          ) : (
            <Button
              onClick={() => previewMutation.mutate()}
              loading={previewMutation.isPending}
              disabled={requiresTarget && !targetId}
            >
              预览影响
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Alert
          title={copy.description}
          tone={
            action === "DISCARD" || action === "CHECK_OUT" ? "warning" : "info"
          }
        >
          {nodes.length > 1
            ? "这是原子批次：任一对象冲突时整批不会生效。"
            : "提交前服务会重新检查位置、状态和内容变化。"}
        </Alert>
        {(requiresTarget || optionalTarget) && (
          <Field
            label={requiresTarget ? "目标位置" : "目标位置（不选则为暂存区）"}
            required={requiresTarget}
          >
            <Select
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">
                {requiresTarget ? "选择目标" : "系统暂存区"}
              </option>
              {allowed.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.code} · {target.name}（{target.type}）
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="操作原因（可选）">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="记录本次调整原因"
          />
        </Field>
        {(previewMutation.error || commitMutation.error) && (
          <Alert title="操作未完成" tone="error">
            {errorMessage(previewMutation.error || commitMutation.error)}
          </Alert>
        )}
        {preview && (
          <div className="rounded-md border bg-muted/50 p-4">
            <p className="font-medium">影响预览</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">直接对象</dt>
                <dd className="mt-1 font-medium">{nodes.length}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">影响节点</dt>
                <dd className="mt-1 font-medium">
                  {preview.affectedCount ??
                    preview.roots?.reduce(
                      (sum, node) => sum + (node.affectedCount || 1),
                      0,
                    )}
                </dd>
              </div>
            </dl>
            {preview.errors?.length ? (
              <ul className="mt-3 space-y-1 text-sm text-destructive">
                {preview.errors.map((error, index) => (
                  <li key={`${error.code}-${index}`}>{error.message}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-emerald-700">
                检查通过，可以提交。
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
