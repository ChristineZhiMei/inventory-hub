import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Table } from "antd";
import { CheckCircle2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryNode } from "@/lib/types";
import { Alert, Badge, Button, Dialog, Input, Segmented, Select, Skeleton } from "./AntUi";
import { InventoryActionDialog } from "./InventoryActionDialog";
import { NodeCard } from "./NodeCard";

export function AddContentsDialog({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: InventoryNode;
  onClose: () => void;
}) {
  const [queryText, setQueryText] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagId, setTagId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [cursor, setCursor] = useState("");
  const [selected, setSelected] = useState<InventoryNode[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deferredQuery = useDeferredValue(queryText.trim());
  const request = useMemo(() => {
    const params = new URLSearchParams({ limit: "30" });
    if (deferredQuery) params.set("q", deferredQuery);
    if (categoryId) params.set("categoryId", categoryId);
    if (tagId) params.set("tagIds", tagId);
    if (typeFilter) params.set("types", typeFilter);
    if (locationId) {
      params.set("locationId", locationId);
    }
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }, [categoryId, cursor, deferredQuery, locationId, tagId, typeFilter]);
  const itemsQuery = useQuery({
    queryKey: ["content-candidates", target.id, request],
    queryFn: () => queries.contentCandidates(target.id, request),
    enabled: open,
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
    enabled: open,
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: queries.tags,
    enabled: open,
  });
  const locations = useQuery({
    queryKey: ["locations", "item-filter"],
    queryFn: () => queries.locations("limit=100"),
    enabled: open,
  });
  const items = pageItems(itemsQuery.data);
  const availableTypes = target.type === "BAG"
    ? ["ITEM"] as const
    : target.type === "BOX"
      ? ["BAG", "ITEM"] as const
      : ["BOX", "BAG", "ITEM"] as const;
  const candidateHint = target.type === "BAG"
    ? "显示尚未放入袋子的在库物品。"
    : target.type === "BOX"
      ? "显示尚未放入箱子的袋子，以及未装袋、未入箱的散件物品。"
      : "显示可直接放入仓库的箱子、未入箱袋子和散件物品。";

  useEffect(() => {
    if (!open) return;
    setQueryText("");
    setCategoryId("");
    setTagId("");
    setLocationId("");
    setTypeFilter("");
    setCursor("");
    setSelected([]);
    setConfirmOpen(false);
  }, [open, target.id]);

  function resetPage() {
    setCursor("");
    setSelected([]);
  }

  function close() {
    setSelected([]);
    setConfirmOpen(false);
    onClose();
  }

  return (
    <>
      <Dialog
        open={open && !confirmOpen}
        onClose={close}
        title="选择已有内容"
        description={`移动到 ${target.code} · ${target.name}`}
        footer={
          <>
            <Button variant="outline" onClick={close}>取消</Button>
            <Button disabled={!selected.length} onClick={() => setConfirmOpen(true)}>
              移动所选（{selected.length}）
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{candidateHint}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="relative sm:col-span-2">
              <Search className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={queryText}
                onChange={(event) => { setQueryText(event.target.value); resetPage(); }}
                placeholder="搜索名称、编号、分类、规格或标签"
                aria-label="搜索可添加内容"
                className="pl-9"
              />
            </div>
            {availableTypes.length > 1 && (
              <Select
                value={typeFilter}
                onChange={(event) => { setTypeFilter(event.target.value); resetPage(); }}
                aria-label="按档案类型筛选"
              >
                <option value="">全部类型</option>
                {availableTypes.map((type) => (
                  <option key={type} value={type}>{typeName[type]}</option>
                ))}
              </Select>
            )}
            <Select
              value={categoryId}
              onChange={(event) => { setCategoryId(event.target.value); resetPage(); }}
              aria-label="按分类筛选"
            >
              <option value="">全部分类</option>
              {pageItems(categories.data).map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </Select>
            <Select
              value={tagId}
              onChange={(event) => { setTagId(event.target.value); resetPage(); }}
              aria-label="按标签筛选"
            >
              <option value="">全部标签</option>
              {pageItems(tags.data).map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </Select>
            <Select
              value={locationId}
              onChange={(event) => { setLocationId(event.target.value); resetPage(); }}
              aria-label="按当前位置筛选"
              className={availableTypes.length > 1 ? "" : "sm:col-span-2"}
            >
              <option value="">全部当前位置</option>
              {pageItems(locations.data).map((location) => (
                <option key={location.id} value={location.id}>{location.code} · {location.name}</option>
              ))}
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              当前页 {items.length} 个，已选择 {selected.length} 个
            </span>
            <Segmented
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "list", label: "列表" },
                { value: "card", label: "卡片" },
              ]}
            />
          </div>
          {viewMode === "list" ? (
            <div className="overflow-x-auto">
              <Table<InventoryNode>
                rowKey="id"
                loading={itemsQuery.isLoading || itemsQuery.isFetching}
                pagination={false}
                dataSource={items}
                scroll={{ x: 620, y: 360 }}
                rowSelection={{
                  selectedRowKeys: selected.map((item) => item.id),
                  preserveSelectedRowKeys: true,
                  onSelect: (item, checked) => toggleSelected(item, checked, setSelected),
                  onSelectAll: (checked, _, changedRows) => setSelected((current) =>
                    checked
                      ? [
                          ...current.filter((entry) => !changedRows.some((row) => row.id === entry.id)),
                          ...changedRows,
                        ]
                      : current.filter((entry) => !changedRows.some((row) => row.id === entry.id)),
                  ),
                }}
                columns={[
                  { title: "名称", dataIndex: "name", key: "name", ellipsis: true },
                  {
                    title: "类型",
                    dataIndex: "type",
                    key: "type",
                    width: 84,
                    render: (type: InventoryNode["type"]) => typeName[type],
                  },
                  {
                    title: "编号",
                    dataIndex: "code",
                    key: "code",
                    width: 120,
                    render: (code: string) => <span className="font-mono text-xs">{code}</span>,
                  },
                  {
                    title: "分类",
                    key: "category",
                    width: 150,
                    render: (_, item) => (
                      <div className="flex flex-wrap gap-1">
                        {item.categories?.length
                          ? item.categories.map((category) => <Badge key={category.id} variant="outline">{category.name}</Badge>)
                          : "—"}
                      </div>
                    ),
                  },
                  {
                    title: "当前位置",
                    key: "location",
                    width: 160,
                    ellipsis: true,
                    render: (_, item) => item.path?.map((entry) => entry.name).join(" / ") || "暂存区",
                  },
                ]}
              />
            </div>
          ) : itemsQuery.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : items.length ? (
            <div className="grid max-h-[360px] gap-3 overflow-y-auto p-0.5 sm:grid-cols-2">
              {items.map((item) => {
                const isSelected = selected.some((entry) => entry.id === item.id);
                return (
                  <div key={item.id} className="relative min-w-0">
                    <NodeCard
                      node={item}
                      selectable
                      selected={isSelected}
                      onSelect={() => toggleSelected(item, !isSelected, setSelected)}
                    />
                    {isSelected && (
                      <CheckCircle2
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2 top-2 z-10 size-6 fill-primary text-primary-foreground"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-36 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
              没有符合条件的可添加内容
            </div>
          )}
          {itemsQuery.isError && (
            <Alert title="无法查询可添加内容" tone="error">
              {errorMessage(itemsQuery.error)}
            </Alert>
          )}
          {(cursor || itemsQuery.data?.nextCursor) && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={!cursor} onClick={() => setCursor("")}>
                <ChevronLeft className="size-4" />第一页
              </Button>
              <Button variant="outline" size="sm" disabled={!itemsQuery.data?.nextCursor} onClick={() => setCursor(itemsQuery.data?.nextCursor || "")}>
                下一页<ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      </Dialog>
      <InventoryActionDialog
        open={open && confirmOpen}
        action="MOVE"
        nodes={selected}
        fixedTarget={target}
        onClose={() => setConfirmOpen(false)}
        onCommitted={close}
      />
    </>
  );
}

const typeName: Record<InventoryNode["type"], string> = {
  WAREHOUSE: "仓库",
  BOX: "箱子",
  BAG: "袋子",
  ITEM: "物品",
};

function toggleSelected(
  item: InventoryNode,
  checked: boolean,
  setSelected: Dispatch<SetStateAction<InventoryNode[]>>,
) {
  setSelected((current) => checked
    ? [...current.filter((entry) => entry.id !== item.id), item]
    : current.filter((entry) => entry.id !== item.id));
}
