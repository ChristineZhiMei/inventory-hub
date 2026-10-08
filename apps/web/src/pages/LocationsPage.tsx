import { useRecentSelections } from "@/lib/recentSelections";
import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "antd";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, FolderTree, LayoutGrid, List, ListFilter, Plus, Search, Square, Warehouse } from "lucide-react";
import { Popup } from "antd-mobile";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMediaQuery } from "@/lib/media";
import { useBodyScrollLock } from "@/lib/scrollLock";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryAction, InventoryNode, NodeType } from "@/lib/types";
import { InventoryActionDialog } from "@/components/InventoryActionDialog";
import { NodeCard } from "@/components/NodeCard";
import { NodeListTable } from "@/components/NodeListTable";
import { QueryError } from "@/components/Page";
import { Alert, Button, EmptyState, Input, Segmented, Select, Skeleton } from "@/components/AntUi";

type LocationFilter = "ALL" | NodeType;
export function LocationsPage({ forcedType, staging = false }: { forcedType?: Exclude<NodeType, "ITEM">; staging?: boolean }) {
  const mobile = useMediaQuery("(max-width: 767px)");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const recent = useRecentSelections();
  const [filter, setFilter] = useState<LocationFilter>(forcedType || "ALL");
  const [viewMode, setViewMode] = useState<"card" | "list">("card");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<InventoryNode[]>([]);
  const [action, setAction] = useState<InventoryAction | null>(null);
  const stagingMode = staging || params.get("staging") === "true";
  useBodyScrollLock(mobile && filterOpen);
  const request = useMemo(() => {
    const next = new URLSearchParams(params);
    next.set("limit", "30");
    next.delete("view");
    next.delete("staging");
    next.delete("type");
    if (forcedType || filter !== "ALL") next.set("type", forcedType || filter);
    if (next.get("locationId")) next.set("includeDescendants", "true");
    return next.toString();
  }, [filter, forcedType, params]);
  const query = useQuery({
    queryKey: ["locations", "archive", request],
    queryFn: () => queries.locations(request),
  });
  const stagingRootQuery = useQuery({
    queryKey: ["locations", "staging-root"],
    queryFn: () => queries.locations("limit=100"),
    enabled: stagingMode,
  });
  const stagingRoot = pageItems(stagingRootQuery.data).find(
    (node) => node.isSystemStaging,
  );
  const stagingContents = useQuery({
    queryKey: ["contents", stagingRoot?.id, "recursive"],
    queryFn: () => queries.contents(stagingRoot!.id, false),
    enabled: stagingMode && !!stagingRoot,
  });
  const source = stagingMode
    ? pageItems(stagingContents.data)
    : pageItems(query.data);
  const locations = source.filter((node) => {
    const activeType = forcedType || filter;
    if (activeType !== "ALL" && node.type !== activeType) return false;
    const queryText = (params.get("q") || "").trim().toLocaleLowerCase("zh-CN");
    if (stagingMode) {
      const searchText = [
        node.name,
        node.code,
        ...(node.categories || []).map((entry) => entry.name),
        ...(node.specifications || []).map((entry) => entry.name),
        ...(node.tags || []).map((entry) => entry.name),
      ].join(" ").toLocaleLowerCase("zh-CN");
      if (queryText && !searchText.includes(queryText)) return false;
      if (params.get("status") && node.stockStatus !== params.get("status")) return false;
      if (params.get("categoryId") && !node.categories?.some((entry) => entry.id === params.get("categoryId"))) return false;
      if (params.get("tagIds") && !node.tags?.some((entry) => entry.id === params.get("tagIds"))) return false;
      if (params.get("specificationIds") && !node.specifications?.some((entry) => entry.id === params.get("specificationIds"))) return false;
    }
    return true;
  });
  const loading =
    (stagingMode ? stagingRootQuery.isLoading : query.isLoading) ||
    (stagingMode && !!stagingRoot && stagingContents.isLoading);
  const error = stagingMode
    ? stagingRootQuery.error || stagingContents.error
    : query.error;
  const canBatchMove = (node: InventoryNode) =>
    node.type !== "WAREHOUSE" && node.stockStatus === "IN_STOCK";
  const movableLocations = locations.filter(canBatchMove);
  const selectableLocations = rootNodes(movableLocations);
  const canSelectLocation = (node: InventoryNode) =>
    canBatchMove(node) && selected.every((current) =>
      current.id === node.id || (
        !node.path?.some((entry) => entry.id === current.id) &&
        !current.path?.some((entry) => entry.id === node.id)
      ),
    );
  function changeFilter(next: LocationFilter) {
    setFilter(next);
    setSelected([]);
  }
  function setFilterParam(name: string, value: string) {
    if (name === "categoryId") recent.record("category", [value]);
    if (name === "tagIds") recent.record("tag", [value]);
    if (name === "specificationIds") recent.record("specification", [value]);
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("cursor");
    setParams(next, { replace: true });
    setSelected([]);
  }
  const categories = useQuery({ queryKey: ["categories"], queryFn: queries.categories });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  const specifications = useQuery({
    queryKey: ["specifications", "location-filter", recent.ids("specification").join(",")],
    queryFn: () => queries.specifications(new URLSearchParams({ limit: "100", recentIds: recent.ids("specification").join(",") }).toString()),
  });
  const parentLocations = useQuery({
    queryKey: ["locations", "location-filter"],
    queryFn: () => queries.locations("limit=100"),
  });
  const advancedFilterKeys = ["status", "categoryId", "tagIds", "specificationIds", "locationId"];
  const advancedFilterCount = advancedFilterKeys.filter((key) => params.get(key)).length;
  useEffect(() => {
    setSelected([]);
    setSelecting(false);
  }, [forcedType, stagingMode]);
  function resetAdvancedFilters() {
    const next = new URLSearchParams(params);
    advancedFilterKeys.forEach((key) => next.delete(key));
    next.delete("cursor");
    setParams(next, { replace: true });
    setSelected([]);
  }
  const advancedFilters = (
    <>
      <Select value={params.get("status") || ""} onChange={(event) => setFilterParam("status", event.target.value)} aria-label="状态">
        <option value="">全部状态</option>
        <option value="IN_STOCK">在库</option>
        <option value="OUT">已出库</option>
        <option value="DISCARDED">已废弃</option>
      </Select>
      <Select value={params.get("categoryId") || ""} onChange={(event) => setFilterParam("categoryId", event.target.value)} aria-label="分类">
        <option value="">全部分类</option>
        {recent.sort("category", pageItems(categories.data)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Select value={params.get("tagIds") || ""} onChange={(event) => setFilterParam("tagIds", event.target.value)} aria-label="标签">
        <option value="">全部标签</option>
        {recent.sort("tag", pageItems(tags.data)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Select value={params.get("specificationIds") || ""} onChange={(event) => setFilterParam("specificationIds", event.target.value)} aria-label="规格">
        <option value="">全部规格</option>
        {recent.sort("specification", pageItems(specifications.data)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Select value={params.get("locationId") || ""} onChange={(event) => setFilterParam("locationId", event.target.value)} aria-label="所在位置">
        <option value="">全部位置</option>
        {pageItems(parentLocations.data).filter((entry) => !entry.isSystemStaging).map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.code}</option>)}
      </Select>
    </>
  );
  function toggleSelectionMode() {
    setSelecting((current) => {
      if (current) setSelected([]);
      return !current;
    });
  }
  function toggleAll() {
    setSelected(
      selected.length === selectableLocations.length ? [] : selectableLocations,
    );
  }
  function toggle(node: InventoryNode) {
    setSelected((current) =>
      current.some((item) => item.id === node.id)
        ? current.filter((item) => item.id !== node.id)
        : [...current, node],
    );
  }
  const typeOptions: Array<{ value: LocationFilter; label: string }> = [
    { value: "ALL", label: "全部" },
    ...(stagingMode
      ? [{ value: "ITEM" as const, label: "物品" }]
      : [{ value: "WAREHOUSE" as const, label: "仓库" }]),
    { value: "BOX", label: "箱子" },
    { value: "BAG", label: "袋子" },
  ];
  const createTypes: Array<Exclude<NodeType, "ITEM">> = forcedType
    ? [forcedType]
    : ["WAREHOUSE", "BOX", "BAG"];
  const createLabel: Record<Exclude<NodeType, "ITEM">, string> = {
    WAREHOUSE: "仓库",
    BOX: "箱子",
    BAG: "袋子",
  };
  const createLocation = (type: Exclude<NodeType, "ITEM">) =>
    navigate(`/archives/new?type=${type}`);
  return (
    <div>
      <div className="page-toolbar location-toolbar">
        <div className="page-toolbar__search relative">
          <Search className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={params.get("q") || ""} onChange={(event) => setFilterParam("q", event.target.value)} placeholder="搜索名称、编号、分类、规格或标签" className="pl-9" aria-label="搜索档案" />
        </div>
        {!forcedType && (
          <div className="page-toolbar__filters">
            <Segmented
              value={filter}
              onChange={changeFilter}
              options={typeOptions}
            />
          </div>
        )}
        <div className="page-toolbar__actions">
          <Button variant="outline" onClick={() => setFilterOpen(true)}>
            <ListFilter className="size-4" />筛选{advancedFilterCount ? `（${advancedFilterCount}）` : ""}
          </Button>
          <Segmented value={viewMode} onChange={setViewMode} options={[
            { value: "card", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-3.5" />卡片</span> },
            { value: "list", label: <span className="inline-flex items-center gap-1"><List className="size-3.5" />列表</span> },
          ]} />
          <Button
            variant={selecting ? "secondary" : "outline"}
            onClick={toggleSelectionMode}
            disabled={!selectableLocations.length}
            aria-label={selecting ? "退出批量移动" : "批量移动"}
          >
            {selecting ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
            {mobile ? (selecting ? "退出" : "批量") : (selecting ? "退出批量" : "批量移动")}
          </Button>
          {!stagingMode && (mobile && createTypes.length > 1 ? (
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: createTypes.map((type) => ({
                  key: type,
                  label: `新建${createLabel[type]}`,
                })),
                onClick: ({ key }) =>
                  createLocation(key as Exclude<NodeType, "ITEM">),
              }}
            >
              <Button aria-label="添加位置" aria-haspopup="menu">
                <Plus className="size-4" />新建
              </Button>
            </Dropdown>
          ) : (
            createTypes.map((type, index) => (
              <Link
                key={type}
                to={`/archives/new?type=${type}`}
                aria-label={`新建${createLabel[type]}`}
                className={`${index === createTypes.length - 1
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border bg-card hover:bg-muted"} inline-flex min-h-10 items-center justify-center gap-2 rounded-md text-sm font-medium md:min-h-8 ${mobile ? "px-3" : "px-4"}`}
              >
                <Plus className="size-4" />
                {mobile ? "新建" : `新建${createLabel[type]}`}
              </Link>
            ))
          ))}
        </div>
      </div>
      <Popup visible={filterOpen} position="bottom" onMaskClick={() => setFilterOpen(false)} onClose={() => setFilterOpen(false)} bodyClassName="app-mobile-dialog" bodyStyle={{ maxHeight: "82dvh" }}>
        <div className="app-mobile-dialog__header"><strong>筛选档案</strong></div>
        <div className="app-mobile-dialog__body grid gap-3">{advancedFilters}</div>
        <div className="app-mobile-dialog__footer"><Button variant="outline" onClick={resetAdvancedFilters}>重置</Button><Button onClick={() => setFilterOpen(false)}>完成</Button></div>
      </Popup>
      {selecting && (
        <div className="sticky top-20 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-card/95 p-3 shadow-raised backdrop-blur">
          <span className="mr-auto text-sm font-medium">
            已选择 {selected.length} 个位置
          </span>
          <Button size="sm" variant="outline" onClick={toggleAll}>
            {selected.length === selectableLocations.length ? "取消全选" : "全选本页"}
          </Button>
          <Button size="sm" disabled={!selected.length} onClick={() => setAction("MOVE")}>
            移动位置
          </Button>
        </div>
      )}
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
            (stagingMode
              ? Promise.all([stagingRootQuery.refetch(), stagingContents.refetch()])
              : query.refetch()
            ).then(() => undefined)
          }
        />
      ) : stagingMode && !stagingRoot ? (
        <Alert title="系统暂存区缺失" tone="error">
          服务没有返回唯一系统暂存区，已停止展示以避免把其他仓库误认为暂存区。
        </Alert>
      ) : locations.length && viewMode === "card" ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {locations.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selectable={selecting}
              selectionDisabled={!canSelectLocation(node)}
              selected={selected.some((item) => item.id === node.id)}
              onSelect={toggle}
            />
          ))}
        </div>
      ) : locations.length ? (
        <NodeListTable
          nodes={locations}
          selecting={selecting}
          selected={selected}
          onSelectedChange={(nodes) => setSelected(rootNodes(nodes))}
          canSelect={canSelectLocation}
        />
      ) : (
        <EmptyState
          icon={stagingMode ? FolderTree : Warehouse}
          title={stagingMode ? "暂存区为空" : "没有匹配的位置"}
          description={
            stagingMode
              ? "新档案仅保存时会进入暂存区。"
              : "新建仓库后，再创建箱子或袋子并安排位置。"
          }
        />
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
    </div>
  );
}

function rootNodes(nodes: InventoryNode[]): InventoryNode[] {
  const selectedIds = new Set(nodes.map((node) => node.id));
  return nodes.filter(
    (node) => !node.path?.slice(1).some((entry) => selectedIds.has(entry.id)),
  );
}
