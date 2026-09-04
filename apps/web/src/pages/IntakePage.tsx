import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardList,
  PackagePlus,
  ScanLine,
  Target,
  Trash2,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryAction, InventoryNode } from "@/lib/types";
import type { EditableImage } from "@/components/ImageManager";
import { NodeForm, type NodeFormData } from "@/components/NodeForm";
import { NodeCard } from "@/components/NodeCard";
import { QueryError } from "@/components/Page";
import { ScannerInput } from "@/components/ScannerInput";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Segmented,
  Select,
} from "@/components/AntUi";

type Mode = "new" | "existing" | "batch";
type Completed = { id: string; code: string; name: string; message: string };

async function lookup(code: string) {
  const match = await api<{ id?: string; node?: InventoryNode }>(
    `/codes/${code}`,
  );
  return (
    match.node ||
    (match.id
      ? queries.node(match.id)
      : Promise.reject(new Error("编号未返回有效档案")))
  );
}

function accepts(target: InventoryNode, child: InventoryNode) {
  if (target.type === "WAREHOUSE") return child.type !== "WAREHOUSE";
  if (target.type === "BOX")
    return child.type === "BAG" || child.type === "ITEM";
  return target.type === "BAG" && child.type === "ITEM";
}

export function IntakePage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const targetId = params.get("targetId") || "";
  const [mode, setMode] = useState<Mode>("new");
  const [candidate, setCandidate] = useState<InventoryNode | null>(null);
  const [pending, setPending] = useState<InventoryNode[]>([]);
  const [completed, setCompleted] = useState<Completed[]>([]);
  const [formKey, setFormKey] = useState(0);
  const [batchAction, setBatchAction] = useState<InventoryAction>("MOVE");
  const target = useQuery({
    queryKey: ["node", targetId],
    queryFn: () => queries.node(targetId),
    enabled: !!targetId,
  });
  const locations = useQuery({
    queryKey: ["locations", "intake"],
    queryFn: () => queries.locations("limit=100"),
    enabled: !targetId,
  });
  const createMutation = useMutation({
    mutationFn: (values: NodeFormData & { images: EditableImage[] }) =>
      api<{ node?: InventoryNode; id?: string; code?: string }>("/nodes", {
        method: "POST",
        idempotent: true,
        body: {
          type: "ITEM",
          name: values.name,
          categoryId: values.categoryId,
          specification: values.specification || undefined,
          notes: values.notes || undefined,
          tagIds: values.tagIds,
          uploadIds: values.images
            .map((image) => image.uploadId)
            .filter(Boolean),
          createMode: "PLACE",
          targetId,
          targetLocationToken: target.data?.locationToken,
        },
      }),
    onSuccess: async (data, values) => {
      const id = data.node?.id || data.id || crypto.randomUUID();
      const code = data.node?.code || data.code || "已创建";
      setCompleted((current) => [
        { id, code, name: values.name, message: `已放入 ${target.data?.name}` },
        ...current,
      ]);
      setFormKey((current) => current + 1);
      await queryClient.invalidateQueries();
    },
  });
  const operationMutation = useMutation({
    mutationFn: async ({
      nodes,
      action,
    }: {
      nodes: InventoryNode[];
      action: InventoryAction;
    }) => {
      const preview = await api<{
        valid: boolean;
        targetLocationToken?: string;
        errors?: Array<{ message: string }>;
      }>("/inventory/preview", {
        method: "POST",
        body: {
          action,
          targets: nodes.map((node) => ({ nodeId: node.id })),
          targetId,
        },
      });
      if (!preview.valid)
        throw new Error(
          preview.errors?.map((error) => error.message).join("；") ||
            "操作预览未通过",
        );
      return api("/inventory/operations", {
        method: "POST",
        idempotent: true,
        body: {
          action,
          targetId,
          targetLocationToken: preview.targetLocationToken,
          targets: nodes.map((node) => ({
            nodeId: node.id,
            expectedLocationVersion: node.locationVersion,
            locationToken: node.locationToken,
            subtreeToken: node.subtreeToken,
          })),
        },
      });
    },
    onSuccess: async (_, variables) => {
      setCompleted((current) =>
        variables.nodes
          .map((node) => ({
            id: node.id,
            code: node.code,
            name: node.name,
            message: `已放入 ${target.data?.name}`,
          }))
          .concat(current),
      );
      setCandidate(null);
      setPending([]);
      await queryClient.invalidateQueries();
    },
  });
  const allowedTargets = useMemo(
    () =>
      pageItems(locations.data).filter(
        (node) =>
          !node.isSystemStaging &&
          node.type !== "ITEM" &&
          (!node.stockStatus || node.stockStatus === "IN_STOCK"),
      ),
    [locations.data],
  );
  function chooseTarget(id: string) {
    setParams({ targetId: id }, { replace: true });
  }
  async function scanSingle(code: string) {
    const node = await lookup(code);
    if (!accepts(target.data!, node))
      throw new Error(
        `不能把${node.type === "BOX" ? "箱子" : node.type === "BAG" ? "袋子" : node.type === "ITEM" ? "物品" : "仓库"}放入当前目标`,
      );
    if (node.parentId === targetId && node.stockStatus === "IN_STOCK") {
      setCompleted((current) => [
        {
          id: node.id,
          code: node.code,
          name: node.name,
          message: "已经在目标位置（未重复记录）",
        },
        ...current,
      ]);
      return;
    }
    setCandidate(node);
  }
  async function scanBatch(code: string) {
    const node = await lookup(code);
    if (!accepts(target.data!, node))
      throw new Error("扫描对象不能放入当前目标");
    if (pending.some((item) => item.id === node.id)) return;
    if (
      pending.some(
        (item) =>
          node.ancestorIds?.includes(item.id) ||
          item.ancestorIds?.includes(node.id),
      )
    )
      throw new Error("批次不能同时包含祖先和后代对象");
    setPending((current) => [...current, node]);
  }
  if (!targetId)
    return (
      <div>
        {locations.isError ? (
          <QueryError
            error={locations.error}
            onRetry={() => locations.refetch()}
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {allowedTargets.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selectable
                onSelect={() => chooseTarget(node.id)}
              />
            ))}
          </div>
        )}
        {!locations.isLoading && !allowedTargets.length && (
          <EmptyState
            icon={Target}
            title="没有可用目标位置"
            description="请先创建仓库、箱子或袋子。"
            action={
              <Link
                to="/locations/new?type=WAREHOUSE"
                className="text-sm font-medium text-primary hover:underline"
              >
                新建仓库
              </Link>
            }
          />
        )}
      </div>
    );
  if (target.isLoading) return <p>加载目标位置…</p>;
  if (target.isError || !target.data)
    return <QueryError error={target.error} onRetry={() => target.refetch()} />;
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button
          variant="outline"
          onClick={() => {
            setParams({}, { replace: true });
            setCandidate(null);
            setPending([]);
          }}
        >
          切换目标
        </Button>
      </div>
      <Card className="mb-5 border-primary/30 bg-accent/30">
        <CardContent className="flex items-center gap-4 p-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Target className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-primary">本轮计划目标</p>
            <p className="truncate font-semibold">
              {target.data.code} · {target.data.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {target.data.path?.map((entry) => entry.name).join(" / ") ||
                "根位置"}
            </p>
          </div>
          <Badge variant="success">已锁定</Badge>
        </CardContent>
      </Card>
      <div className="mb-5 overflow-x-auto">
        <Segmented
          value={mode}
          onChange={(value) => {
            setMode(value);
            setCandidate(null);
          }}
          options={[
            { value: "new", label: "拍照建档" },
            { value: "existing", label: "已有档案" },
            { value: "batch", label: "批量扫码" },
          ]}
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section>
          {mode === "new" && (
            <NodeForm
              key={formKey}
              type="ITEM"
              submitLabel={`创建并放入 ${target.data.name}`}
              busy={createMutation.isPending}
              onSubmit={(values) =>
                createMutation.mutateAsync(values).then(() => undefined)
              }
            />
          )}
          {mode === "existing" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ScanLine className="size-5" />
                  扫描已有档案
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <ScannerInput
                  onCode={scanSingle}
                  paused={!!candidate || operationMutation.isPending}
                />
                {candidate && (
                  <div>
                    <NodeCard node={candidate} />
                    <Alert
                      title={
                        candidate.stockStatus === "OUT"
                          ? "该档案已出库"
                          : candidate.stockStatus === "DISCARDED"
                            ? "该档案已废弃"
                            : "将从原位置移入目标"
                      }
                      tone="warning"
                      className="mt-3"
                    >
                      确认后会执行{" "}
                      {candidate.stockStatus === "OUT"
                        ? "重新入库"
                        : candidate.stockStatus === "DISCARDED"
                          ? "恢复"
                          : "移动"}
                      ，容器将连同内部内容一起处理。
                    </Alert>
                    <div className="mt-4 flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setCandidate(null)}
                      >
                        取消
                      </Button>
                      <Button
                        loading={operationMutation.isPending}
                        onClick={() =>
                          operationMutation.mutate({
                            nodes: [candidate],
                            action:
                              candidate.stockStatus === "OUT"
                                ? "CHECK_IN"
                                : candidate.stockStatus === "DISCARDED"
                                  ? "RESTORE"
                                  : "MOVE",
                          })
                        }
                      >
                        确认放入
                      </Button>
                    </div>
                  </div>
                )}
                {operationMutation.error && (
                  <Alert title="本件未完成" tone="error">
                    {errorMessage(operationMutation.error)}
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}
          {mode === "batch" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ClipboardList className="size-5" />
                  显式批量清单
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <Alert title="扫描不会立即修改库存" tone="info">
                  确认整批执行后才原子提交；任一对象冲突时整批不生效。
                </Alert>
                <Select
                  value={batchAction}
                  onChange={(event) =>
                    setBatchAction(event.target.value as InventoryAction)
                  }
                >
                  <option value="MOVE">在库对象移动到目标</option>
                  <option value="CHECK_IN">已出库对象重新入库</option>
                  <option value="RESTORE">已废弃对象恢复</option>
                </Select>
                <ScannerInput
                  onCode={scanBatch}
                  paused={operationMutation.isPending || pending.length >= 100}
                />
                {pending.length > 0 && (
                  <div className="space-y-2">
                    {pending.map((node) => (
                      <div
                        key={node.id}
                        className="flex min-h-12 items-center gap-3 rounded-md border px-3"
                      >
                        <span className="font-mono text-sm">{node.code}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {node.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setPending((current) =>
                              current.filter((item) => item.id !== node.id),
                            )
                          }
                          aria-label={`移除 ${node.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      className="w-full"
                      loading={operationMutation.isPending}
                      onClick={() =>
                        operationMutation.mutate({
                          nodes: pending,
                          action: batchAction,
                        })
                      }
                    >
                      预览并执行 {pending.length} 个对象
                    </Button>
                  </div>
                )}
                {operationMutation.error && (
                  <Alert title="批次未执行" tone="error">
                    {errorMessage(operationMutation.error)}
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}
        </section>
        <aside>
          <Card className="sticky top-20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-emerald-600" />
                本轮已完成 <Badge variant="secondary">{completed.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {completed.length ? (
                <ol className="space-y-2">
                  {completed.map((item) => (
                    <li
                      key={`${item.id}-${item.message}`}
                      className="rounded-md bg-muted/60 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{item.code}</span>
                        <span className="truncate text-sm font-medium">
                          {item.name}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.message}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="py-10 text-center">
                  <PackagePlus className="mx-auto size-8 text-muted-foreground/50" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    成功档案会保留在这里
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
