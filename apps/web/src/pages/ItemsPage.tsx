import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  ListFilter,
  PackagePlus,
  RotateCcw,
  Search,
  Square,
} from "lucide-react";
import { Popup } from "antd-mobile";
import { Link, useSearchParams } from "react-router-dom";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryAction, InventoryNode } from "@/lib/types";
import { InventoryActionDialog } from "@/components/InventoryActionDialog";
import { NodeCard } from "@/components/NodeCard";
import { NodeListTable } from "@/components/NodeListTable";
import { QueryError } from "@/components/Page";
import { Button, EmptyState, Input, Segmented, Select, Skeleton } from "@/components/AntUi";
import { useMediaQuery } from "@/lib/media";
import { useBodyScrollLock } from "@/lib/scrollLock";

export function ItemsPage() {
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<InventoryNode[]>([]);
  const [action, setAction] = useState<InventoryAction | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [viewMode, setViewMode] = useState<"card" | "list">("card");
  const mobile = useMediaQuery("(max-width: 767px)");
  useBodyScrollLock(mobile && filterOpen);
  const queryString = params.toString();
  const request = new URLSearchParams(params);
  request.set("limit", "30");
  if (request.get("locationId")) request.set("includeDescendants", "true");
  const query = useQuery({
    queryKey: ["items", queryString],
    queryFn: () => queries.items(request.toString()),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  const locations = useQuery({
    queryKey: ["locations", "item-filter"],
    queryFn: () => queries.locations("limit=100"),
  });
  const items = pageItems(query.data);
  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next, { replace: true });
    setSelected([]);
  }
  function toggle(node: InventoryNode) {
    setSelected((current) =>
      current.some((item) => item.id === node.id)
        ? current.filter((item) => item.id !== node.id)
        : [...current, node],
    );
  }
  const advancedFilterKeys = [
    "status",
    "categoryId",
    "tagIds",
    "locationId",
  ];
  const advancedFilterCount = advancedFilterKeys.filter((key) =>
    params.get(key),
  ).length;
  function toggleSelectionMode() {
    setSelecting((current) => {
      if (current) setSelected([]);
      return !current;
    });
  }
  function toggleAll() {
    setSelected(selected.length === items.length ? [] : items);
  }
  function resetAdvancedFilters() {
    const next = new URLSearchParams(params);
    advancedFilterKeys.forEach((key) => next.delete(key));
    next.delete("cursor");
    setParams(next, { replace: true });
    setSelected([]);
  }
  const advancedFilters = (
    <>
      <Select
        name="item-status"
        value={params.get("status") || ""}
        onChange={(event) => setFilter("status", event.target.value)}
        aria-label="库存状态"
      >
        <option value="">全部状态</option>
        <option value="IN_STOCK">在库</option>
        <option value="OUT">已出库</option>
        <option value="DISCARDED">已废弃</option>
      </Select>
      <Select
        name="item-category"
        value={params.get("categoryId") || ""}
        onChange={(event) => setFilter("categoryId", event.target.value)}
        aria-label="分类"
      >
        <option value="">全部分类</option>
        {pageItems(categories.data).map((category) => (
          <option value={category.id} key={category.id}>
            {category.name}
          </option>
        ))}
      </Select>
      <Select
        name="item-tag"
        value={params.get("tagIds") || ""}
        onChange={(event) => setFilter("tagIds", event.target.value)}
        aria-label="标签"
      >
        <option value="">全部标签</option>
        {pageItems(tags.data).map((tag) => (
          <option value={tag.id} key={tag.id}>
            {tag.name}
          </option>
        ))}
      </Select>
      <Select
        name="item-location"
        value={params.get("locationId") || ""}
        onChange={(event) => setFilter("locationId", event.target.value)}
        aria-label="所在位置"
      >
        <option value="">全部位置</option>
        {pageItems(locations.data).map((location) => (
          <option value={location.id} key={location.id}>
            {location.name} · {location.code}
          </option>
        ))}
      </Select>
    </>
  );
  const createAction = (
        <Link
          to="/archives/new?type=ITEM"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 md:min-h-8"
        >
          <PackagePlus className="size-4" />
          新建物品
        </Link>
  );
  return (
    <div>
      {mobile ? (
        <div className="mobile-item-filters mb-5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="item-query-mobile"
              value={params.get("q") || ""}
              onChange={(event) => setFilter("q", event.target.value)}
              placeholder="搜索名称、编号、分类或标签"
              className="pl-9"
              aria-label="搜索物品"
            />
          </div>
          <div className="mobile-item-filters__actions">
            {createAction}
            <Button variant="outline" onClick={() => setFilterOpen(true)}>
              <ListFilter className="size-4" />
              筛选{advancedFilterCount ? `（${advancedFilterCount}）` : ""}
            </Button>
            <Button
              variant={selecting ? "secondary" : "outline"}
              onClick={toggleSelectionMode}
              disabled={!items.length}
            >
              {selecting ? (
                <CheckSquare className="size-4" />
              ) : (
                <Square className="size-4" />
              )}
              {selecting ? "退出批量" : "批量"}
            </Button>
          </div>
          <div className="flex justify-end">
            <Segmented
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "card", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-3.5" />卡片</span> },
                { value: "list", label: <span className="inline-flex items-center gap-1"><List className="size-3.5" />列表</span> },
              ]}
            />
          </div>
        </div>
      ) : (
        <div className="surface filter-toolbar mb-5 p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="item-query"
              value={params.get("q") || ""}
              onChange={(event) => setFilter("q", event.target.value)}
              placeholder="搜索名称、编号、分类或标签"
              className="pl-9"
              aria-label="搜索物品"
            />
          </div>
          {advancedFilters}
          <Button
            variant={selecting ? "secondary" : "outline"}
            onClick={toggleSelectionMode}
            disabled={!items.length}
          >
            {selecting ? (
              <CheckSquare className="size-4" />
            ) : (
              <Square className="size-4" />
            )}
            {selecting ? "退出批量" : "批量选择"}
          </Button>
          <Segmented
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: "card", label: "卡片" },
              { value: "list", label: "列表" },
            ]}
          />
          {createAction}
        </div>
      )}
      {selecting && (
        <div className="sticky top-20 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-card/95 p-3 shadow-raised backdrop-blur">
          <span className="mr-auto text-sm font-medium">
            已选择 {selected.length} 件
          </span>
          <Button size="sm" variant="outline" onClick={toggleAll}>
            {selected.length === items.length ? "取消全选" : "全选本页"}
          </Button>
          <Button size="sm" variant="outline" disabled={!selected.length} onClick={() => setAction("MOVE")}>
            移动
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.length}
            onClick={() => setAction("REMOVE")}
          >
            移出
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.length}
            onClick={() => setAction("CHECK_OUT")}
          >
            出库
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.length}
            onClick={() => setAction("CHECK_IN")}
          >
            入库
          </Button>
        </div>
      )}
      {query.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      ) : items.length && viewMode === "card" ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selectable={selecting}
              selected={selected.some((item) => item.id === node.id)}
              onSelect={toggle}
            />
          ))}
        </div>
      ) : items.length ? (
        <NodeListTable
          nodes={items}
          selecting={selecting}
          selected={selected}
          onSelectedChange={setSelected}
        />
      ) : (
        <EmptyState
          icon={Archive}
          title={queryString ? "没有匹配物品" : "还没有物品档案"}
          description={
            queryString
              ? "调整搜索词或筛选条件后重试。"
              : "拍摄第一件物品的照片，为它创建独立编号。"
          }
          action={
            <Link
              to="/archives/new?type=ITEM"
              className="text-sm font-medium text-primary hover:underline"
            >
              新建第一件物品
            </Link>
          }
        />
      )}
      {(params.get("cursor") || query.data?.nextCursor) && (
        <div className="mt-5 flex justify-center gap-3">
          <Button
            variant="outline"
            disabled={!params.get("cursor")}
            onClick={() => setFilter("cursor", "")}
          >
            <ChevronLeft className="size-4" />
            第一页
          </Button>
          <Button
            variant="outline"
            disabled={!query.data?.nextCursor}
            onClick={() => setFilter("cursor", query.data?.nextCursor || "")}
          >
            下一页
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
      <InventoryActionDialog
        open={!!action}
        action={action || "MOVE"}
        nodes={selected}
        onClose={() => {
          setAction(null);
          setSelected([]);
          setSelecting(false);
        }}
      />
      {mobile && (
        <Popup
          visible={filterOpen}
          onMaskClick={() => setFilterOpen(false)}
          onClose={() => setFilterOpen(false)}
          bodyClassName="mobile-filter-popup"
          bodyStyle={{ maxHeight: "88dvh" }}
        >
          <div className="mobile-filter-popup__header">
            <strong>筛选物品</strong>
            <span>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "未启用筛选"}</span>
          </div>
          <div className="mobile-filter-popup__body">{advancedFilters}</div>
          <div className="mobile-filter-popup__footer">
            <Button
              variant="outline"
              onClick={resetAdvancedFilters}
              disabled={!advancedFilterCount}
            >
              <RotateCcw className="size-4" />
              重置
            </Button>
            <Button onClick={() => setFilterOpen(false)}>完成</Button>
          </div>
        </Popup>
      )}
    </div>
  );
}
