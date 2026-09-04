import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryAction, InventoryNode } from "@/lib/types";
import {
  formatDate,
  formatOperationSummary,
  operationActionLabels,
} from "@/lib/utils";
import { InventoryActionDialog } from "@/components/InventoryActionDialog";
import { PageHeader, QueryError } from "@/components/Page";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Select,
  Skeleton,
} from "@/components/AntUi";

export function OperationsPage() {
  const [params, setParams] = useSearchParams();
  const query = useQuery({
    queryKey: ["operations", params.toString()],
    queryFn: () =>
      queries.operations(
        new URLSearchParams([...params.entries(), ["limit", "30"]]).toString(),
      ),
  });
  const items = pageItems(query.data);
  return (
    <div>
      <div className="mb-5 max-w-xs">
        <Select
          value={params.get("action") || ""}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            e.target.value
              ? next.set("action", e.target.value)
              : next.delete("action");
            next.delete("cursor");
            setParams(next, { replace: true });
          }}
        >
          <option value="">全部动作</option>
          {Object.entries(operationActionLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      {query.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((x) => (
            <Skeleton key={x} className="h-20" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      ) : items.length ? (
        <ol className="relative ml-3 border-l pl-7">
          {items.map((operation) => (
            <li key={operation.id} className="relative pb-6">
              <span className="absolute -left-[34px] top-5 size-3 rounded-full border-2 border-background bg-primary" />
              <Link
                to={`/operations/${operation.id}`}
                className="surface block p-4 transition hover:shadow-raised"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {operationActionLabels[operation.action] || operation.action}
                  </Badge>
                  {operation.reversesOperationId && (
                    <Badge variant="outline">反向操作</Badge>
                  )}
                  <span className="min-w-0 flex-1 font-medium">
                    {formatOperationSummary(operation.action, operation.summary)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(operation.createdAt)}
                  </span>
                </div>
                {operation.reason && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    原因：{operation.reason}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState
          icon={History}
          title="还没有操作记录"
          description="建档、移动、出入库和编辑等成功动作会显示在这里。"
        />
      )}
      {(params.get("cursor") || query.data?.nextCursor) && (
        <div className="mt-5 flex justify-center gap-3">
          <Button
            variant="outline"
            disabled={!params.get("cursor")}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("cursor");
              setParams(next, { replace: true });
            }}
          >
            <ChevronLeft className="size-4" />
            第一页
          </Button>
          <Button
            variant="outline"
            disabled={!query.data?.nextCursor}
            onClick={() => {
              const next = new URLSearchParams(params);
              if (query.data?.nextCursor)
                next.set("cursor", query.data.nextCursor);
              setParams(next, { replace: true });
            }}
          >
            下一页
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function OperationDetailPage() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ["operation", id],
    queryFn: () => queries.operation(id!),
    enabled: !!id,
  });
  const [reverseAction, setReverseAction] = useState<InventoryAction | null>(
    null,
  );
  const [reverseNodes, setReverseNodes] = useState<InventoryNode[]>([]);
  if (query.isLoading)
    return (
      <>
        <PageHeader title="操作详情" back />
        <Skeleton className="h-72" />
      </>
    );
  if (query.isError || !query.data)
    return (
      <>
        <PageHeader title="操作详情" back />
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  const operation = query.data;
  const reverseMap: Partial<Record<string, InventoryAction>> = {
    MOVE: "MOVE",
    REMOVE: "MOVE",
    CHECK_OUT: "CHECK_IN",
    CHECK_IN: "CHECK_OUT",
    DISCARD: "RESTORE",
    RESTORE: "DISCARD",
  };
  async function reverse() {
    const action = reverseMap[operation.action];
    if (!action) return;
    const targets = (operation.targets || []).filter(
      (target) => target.directlyOperated,
    );
    const nodes = await Promise.all(
      targets.map((target) => queries.node(target.nodeId)),
    );
    setReverseNodes(nodes);
    setReverseAction(action);
  }
  return (
    <div>
      <PageHeader
        title={operationActionLabels[operation.action] || operation.action}
        description={formatDate(operation.createdAt)}
        back
        actions={
          operation.canReverse && reverseMap[operation.action] ? (
            <Button variant="outline" onClick={reverse}>
              预览反向操作
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card>
          <CardContent className="p-5">
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">摘要</dt>
                <dd className="mt-1 font-medium">
                  {formatOperationSummary(operation.action, operation.summary)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">操作 ID</dt>
                <dd className="mt-1 break-all font-mono text-xs">
                  {operation.id}
                </dd>
              </div>
              {operation.requestId && (
                <div>
                  <dt className="text-muted-foreground">请求 ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {operation.requestId}
                  </dd>
                </div>
              )}
              {operation.reason && (
                <div>
                  <dt className="text-muted-foreground">原因</dt>
                  <dd className="mt-1">{operation.reason}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
        <div>
          <h2 className="mb-3 text-lg font-semibold">受影响对象</h2>
          {operation.targets?.length ? (
            <div className="space-y-3">
              {operation.targets.map((target) => (
                <Card key={target.nodeId}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm">{target.code}</span>
                      {target.name && (
                        <span className="font-medium">{target.name}</span>
                      )}
                      <Badge
                        variant={
                          target.directlyOperated ? "default" : "outline"
                        }
                      >
                        {target.directlyOperated ? "直接操作" : "继承影响"}
                      </Badge>
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-primary">
                        查看前后快照
                      </summary>
                      <div className="mt-3 grid gap-3 xl:grid-cols-2">
                        <Snapshot title="操作前" value={target.before} />
                        <Snapshot title="操作后" value={target.after} />
                      </div>
                    </details>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              此维护操作没有物品节点目标。
            </p>
          )}
        </div>
      </div>
      <InventoryActionDialog
        open={!!reverseAction}
        action={reverseAction || "MOVE"}
        nodes={reverseNodes}
        reversesOperationId={operation.id}
        onClose={() => {
          setReverseAction(null);
          setReverseNodes([]);
        }}
      />
    </div>
  );
}

function Snapshot({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md bg-muted p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
