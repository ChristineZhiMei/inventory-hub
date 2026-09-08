import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Box,
  ChevronRight,
  CircleAlert,
  Clock3,
  Package,
  PackagePlus,
  Search,
  Warehouse,
} from "lucide-react";
import { Link } from "react-router-dom";
import { queries } from "@/lib/queries";
import {
  formatDate,
  formatOperationSummary,
  operationActionLabels,
} from "@/lib/utils";
import { NodeCard } from "@/components/NodeCard";
import { QueryError } from "@/components/Page";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@/components/AntUi";

export function DashboardPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: queries.dashboard,
  });
  if (query.isError)
    return <QueryError error={query.error} onRetry={() => query.refetch()} />;
  const data = query.data;
  const stats = [
    {
      label: "物品",
      value: data?.counts.items,
      icon: Archive,
      tone: "bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400",
    },
    {
      label: "袋子",
      value: data?.counts.bags,
      icon: Package,
      tone: "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400",
    },
    {
      label: "箱子",
      value: data?.counts.boxes,
      icon: Box,
      tone: "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400",
    },
    {
      label: "仓库",
      value: data?.counts.warehouses,
      icon: Warehouse,
      tone: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400",
    },
  ];
  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <Link
          to="/items/new"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <PackagePlus className="size-4" />
          新建物品
        </Link>
        <Link
          to="/scan"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"
        >
          <Search className="size-4" />
          扫码查找
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4 p-5">
              <div
                className={`grid size-12 place-items-center rounded-lg ${tone}`}
              >
                <Icon className="size-6" />
              </div>
              <div>
                <div className="stat-number">
                  {query.isLoading ? (
                    <Skeleton className="h-8 w-14" />
                  ) : (
                    (value ?? 0)
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {(data?.counts.staging ?? 0) > 0 && (
        <Link
          to="/staging"
          className="mt-4 flex min-h-14 items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 text-amber-950 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-100"
        >
          <CircleAlert className="size-5" />
          <span className="flex-1 text-sm">
            <strong>{data?.counts.staging}</strong> 个档案仍在暂存区，等待整理
          </span>
          <ChevronRight className="size-5" />
        </Link>
      )}
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
        <section>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold">待整理</h2>
              <p className="text-sm text-muted-foreground">
                系统暂存区中的最近档案
              </p>
            </div>
            <Link
              to="/staging"
              className="text-sm font-medium text-primary hover:underline"
            >
              查看全部
            </Link>
          </div>
          {query.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          ) : data?.stagingItems?.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {data.stagingItems.slice(0, 6).map((node) => (
                <NodeCard key={node.id} node={node} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="grid min-h-48 place-items-center text-center">
                <div>
                  <PackagePlus className="mx-auto size-8 text-muted-foreground/60" />
                  <p className="mt-3 font-medium">暂存区已经整理完毕</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    仅建档但未归位的对象会显示在这里。
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </section>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="size-5" />
              最近操作
            </CardTitle>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((x) => (
                  <Skeleton key={x} className="h-14" />
                ))}
              </div>
            ) : data?.recentOperations?.length ? (
              <ol className="space-y-1">
                {data.recentOperations.slice(0, 8).map((operation) => (
                  <li key={operation.id}>
                    <Link
                      to={`/operations/${operation.id}`}
                      className="block rounded-md px-2 py-3 hover:bg-muted"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">
                          {operationActionLabels[operation.action] || operation.action}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {formatOperationSummary(operation.action, operation.summary)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDate(operation.createdAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                还没有操作记录
              </p>
            )}
            <Link
              to="/operations"
              className="mt-3 flex min-h-11 items-center justify-center rounded-md text-sm font-medium text-primary hover:bg-muted"
            >
              查看完整记录
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
