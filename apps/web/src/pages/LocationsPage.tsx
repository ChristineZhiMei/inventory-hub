import { useState } from "react";
import { Dropdown } from "antd";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, FolderTree, LayoutGrid, List, Plus, Square, Warehouse } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMediaQuery } from "@/lib/media";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryAction, InventoryNode, NodeType } from "@/lib/types";
import { InventoryActionDialog } from "@/components/InventoryActionDialog";
import { NodeCard } from "@/components/NodeCard";
import { NodeListTable } from "@/components/NodeListTable";
import { QueryError } from "@/components/Page";
import { Alert, Button, EmptyState, Segmented, Skeleton } from "@/components/AntUi";

type LocationFilter = "ALL" | Exclude<NodeType, "ITEM">;
export function LocationsPage() {
  const mobile = useMediaQuery("(max-width: 767px)");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<LocationFilter>("ALL");
  const [viewMode, setViewMode] = useState<"card" | "list">("card");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<InventoryNode[]>([]);
  const [action, setAction] = useState<InventoryAction | null>(null);
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
  const canBatchMove = (node: InventoryNode) =>
    (node.type === "BOX" || node.type === "BAG") &&
    node.stockStatus === "IN_STOCK";
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
  return (
    <div>
      <div className="page-toolbar location-toolbar">
        {!stagingMode && (
          <div className="page-toolbar__filters">
            <Segmented
              value={filter}
              onChange={changeFilter}
              options={[
                { value: "ALL", label: "全部" },
                { value: "WAREHOUSE", label: "仓库" },
                { value: "BOX", label: "箱子" },
                { value: "BAG", label: "袋子" },
              ]}
            />
            <Segmented
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "card", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-3.5" />卡片</span> },
                { value: "list", label: <span className="inline-flex items-center gap-1"><List className="size-3.5" />列表</span> },
              ]}
            />
          </div>
        )}
        {stagingMode && (
          <div className="page-toolbar__filters">
            <Segmented
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "card", label: "卡片" },
                { value: "list", label: "列表" },
              ]}
            />
          </div>
        )}
        <div className="page-toolbar__actions">
          <Button
            variant={selecting ? "secondary" : "outline"}
            onClick={toggleSelectionMode}
            disabled={!selectableLocations.length}
          >
            {selecting ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
            {selecting ? "退出批量" : "批量移动"}
          </Button>
          {mobile ? (
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: [
                  { key: "WAREHOUSE", label: "添加仓库" },
                  { key: "BOX", label: "添加箱子" },
                  { key: "BAG", label: "添加袋子" },
                ],
                onClick: ({ key }) => navigate(`/locations/new?type=${key}`),
              }}
            >
              <Button aria-label="添加位置" aria-haspopup="menu">
                <Plus className="size-4" />添加
              </Button>
            </Dropdown>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
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
            Promise.all([query.refetch(), stagingContents.refetch()]).then(
              () => undefined,
            )
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
          icon={params.get("staging") ? FolderTree : Warehouse}
          title={params.get("staging") ? "暂存区为空" : "没有匹配的位置"}
          description={
            params.get("staging")
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
