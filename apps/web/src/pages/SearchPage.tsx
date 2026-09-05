import { useQuery } from "@tanstack/react-query";
import { SearchX } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryNode } from "@/lib/types";
import { normalizeCode } from "@/lib/utils";
import { NodeCard } from "@/components/NodeCard";
import { PageHeader, QueryError } from "@/components/Page";
import { EmptyState, Skeleton } from "@/components/AntUi";

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() || "";
  const isCode = /^(W|C|I)[0-9]{6,}$/i.test(q);
  const query = useQuery({ queryKey: ["search", q], enabled: !!q, queryFn: async () => {
    if (isCode) {
      try { const match = await api<{ id?: string; node?: InventoryNode }>(`/codes/${normalizeCode(q)}`); return match.node ? [match.node] : match.id ? [await queries.node(match.id)] : []; }
      catch (error) { if (error instanceof ApiError && [404, 410].includes(error.status)) return []; throw error; }
    }
    const result = await queries.search(q);
    return [...result.items, ...result.locations];
  }});
  return <div><PageHeader title={`搜索“${q}”`} description={isCode ? "按编号精确匹配" : "匹配名称、编号和标签"} />{query.isLoading ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[1,2,3,4].map((x) => <Skeleton key={x} className="h-28" />)}</div> : query.isError ? <QueryError error={query.error} onRetry={() => query.refetch()} /> : query.data?.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{query.data.map((node) => <NodeCard key={node.id} node={node} />)}</div> : <EmptyState icon={SearchX} title="没有找到匹配档案" description="请检查编号，或尝试名称、分类和标签中的其他关键词。" />}</div>;
}
