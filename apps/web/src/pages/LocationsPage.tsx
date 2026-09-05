import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderTree, Plus, Warehouse } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { pageItems, queries } from "@/lib/queries";
import type { NodeType } from "@/lib/types";
import { NodeCard } from "@/components/NodeCard";
import { QueryError } from "@/components/Page";
import { Alert, EmptyState, Segmented, Skeleton } from "@/components/AntUi";

type LocationFilter = "ALL" | Exclude<NodeType, "ITEM">;
export function LocationsPage() {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<LocationFilter>("ALL");
  const stagingMode = params.get("staging") === "true";
  const query = useQuery({
    queryKey: ["locations", "root"],
    queryFn: () => queries.locations("limit=100"),
  });
  const stagingRoot = pageItems(query.data).find(
    (node) => node.isSystemStaging,
  );
  const stagingContents = useQuery({
    queryKey: ["contents", stagingRoot?.id, "recursive"],
    queryFn: () => queries.contents(stagingRoot!.id, true),
    enabled: stagingMode && !!stagingRoot,
  });
  const source = stagingMode
    ? pageItems(stagingContents.data)
    : pageItems(query.data);
  const locations = source.filter(
    (node) => filter === "ALL" || node.type === filter,
  );
  const loading =
    query.isLoading ||
    (stagingMode && !!stagingRoot && stagingContents.isLoading);
  const error = query.error || stagingContents.error;
  return (
    <div>
      <div className="page-toolbar">
        {!stagingMode && (
          <div className="page-toolbar__filters">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "ALL", label: "全部" },
                { value: "WAREHOUSE", label: "仓库" },
                { value: "BOX", label: "箱子" },
                { value: "BAG", label: "袋子" },
              ]}
            />
          </div>
        )}
        <div className="page-toolbar__actions">
        <Link
          to="/locations/new?type=WAREHOUSE"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"
        >
          <Plus className="size-4" />
          仓库
        </Link>
        <Link
          to="/locations/new?type=BOX"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"
        >
          <Plus className="size-4" />
          箱子
        </Link>
        <Link
          to="/locations/new?type=BAG"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" />
          袋子
        </Link>
        </div>
      </div>
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4].map((x) => (
            <Skeleton key={x} className="h-28" />
          ))}
        </div>
      ) : error ? (
        <QueryError
          error={error}
          onRetry={() =>
            Promise.all([query.refetch(), stagingContents.refetch()]).then(
              () => undefined,
            )
          }
        />
      ) : stagingMode && !stagingRoot ? (
        <Alert title="系统暂存区缺失" tone="error">
          服务没有返回唯一系统暂存区，已停止展示以避免把其他仓库误认为暂存区。
        </Alert>
      ) : locations.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {locations.map((node) => (
            <NodeCard key={node.id} node={node} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={params.get("staging") ? FolderTree : Warehouse}
          title={params.get("staging") ? "暂存区为空" : "没有匹配的位置"}
          description={
            params.get("staging")
              ? "新档案仅保存时会进入暂存区。"
              : "新建仓库后，再创建箱子或袋子并安排位置。"
          }
        />
      )}
    </div>
  );
}
