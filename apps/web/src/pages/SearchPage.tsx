import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List, SearchX } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { queries } from "@/lib/queries";
import type { InventoryNode } from "@/lib/types";
import { normalizeCode } from "@/lib/utils";
import { NodeCard } from "@/components/NodeCard";
import { NodeListTable } from "@/components/NodeListTable";
import { PageHeader, QueryError } from "@/components/Page";
import { EmptyState, Segmented, Skeleton } from "@/components/AntUi";

export function SearchPage() {
  const [params] = useSearchParams();
  const [viewMode, setViewMode] = useState<"card" | "list">("card");
  const q = params.get("q")?.trim() || "";
  const isCode = /^(W|C|I)[0-9]{6,}$/i.test(q);
  const query = useQuery({
    queryKey: ["search", q],
    enabled: !!q,
    queryFn: async () => {
      if (isCode) {
        try {
          const match = await api<{ id?: string; node?: InventoryNode }>(
            `/codes/${normalizeCode(q)}`,
          );
          return match.node
            ? [match.node]
            : match.id
              ? [await queries.node(match.id)]
              : [];
        } catch (error) {
          if (error instanceof ApiError && [404, 410].includes(error.status))
            return [];
          throw error;
        }
      }
      const result = await queries.search(q);
      return [...result.items, ...result.locations];
    },
  });
  const nodes = query.data || [];

  return (
    <div>
      <PageHeader
        title={`搜索“${q}”`}
        actions={
          <Segmented
            value={viewMode}
            onChange={setViewMode}
            options={[
              {
                value: "card",
                label: (
                  <span className="inline-flex items-center gap-1">
                    <LayoutGrid className="size-3.5" />卡片
                  </span>
                ),
              },
              {
                value: "list",
                label: (
                  <span className="inline-flex items-center gap-1">
                    <List className="size-3.5" />列表
                  </span>
                ),
              },
            ]}
          />
        }
      />
      {query.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4].map((item) => (
            <Skeleton key={item} className="h-28" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      ) : nodes.length && viewMode === "card" ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {nodes.map((node) => <NodeCard key={node.id} node={node} />)}
        </div>
      ) : nodes.length ? (
        <NodeListTable nodes={nodes} />
      ) : (
        <EmptyState
          icon={SearchX}
          title="没有找到匹配档案"
          description="请调整关键词后重试"
        />
      )}
    </div>
  );
}
