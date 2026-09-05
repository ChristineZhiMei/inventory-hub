import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table } from "antd";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryNode } from "@/lib/types";
import { Alert, Badge, Button, Dialog, Input, Select } from "./AntUi";
import { InventoryActionDialog } from "./InventoryActionDialog";

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
  const [cursor, setCursor] = useState("");
  const [selected, setSelected] = useState<InventoryNode[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deferredQuery = useDeferredValue(queryText.trim());
  const request = useMemo(() => {
    const params = new URLSearchParams({ limit: "30", status: "IN_STOCK" });
    if (deferredQuery) params.set("q", deferredQuery);
    if (categoryId) params.set("categoryId", categoryId);
    if (tagId) params.set("tagIds", tagId);
    if (locationId) {
      params.set("locationId", locationId);
      params.set("includeDescendants", "true");
    }
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }, [categoryId, cursor, deferredQuery, locationId, tagId]);
  const itemsQuery = useQuery({
    queryKey: ["items", "add-to", target.id, request],
    queryFn: () => queries.items(request),
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
  const items = pageItems(itemsQuery.data).filter((item) => item.parentId !== target.id);

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
        title="添加已有物品"
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
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="relative sm:col-span-2">
              <Search className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={queryText}
                onChange={(event) => { setQueryText(event.target.value); resetPage(); }}
                placeholder="搜索名称、编号、分类或标签"
                aria-label="搜索可添加物品"
                className="pl-9"
              />
            </div>
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
              className="sm:col-span-2"
            >
              <option value="">全部当前位置</option>
              {pageItems(locations.data).map((location) => (
                <option key={location.id} value={location.id}>{location.code} · {location.name}</option>
              ))}
            </Select>
          </div>
          <div className="overflow-x-auto">
            <Table<InventoryNode>
              rowKey="id"
              loading={itemsQuery.isLoading || itemsQuery.isFetching}
              pagination={false}
              dataSource={items}
              scroll={{ x: 620, y: 360 }}
              rowSelection={{
                selectedRowKeys: selected.map((item) => item.id),
                onChange: (_, rows) => setSelected(rows),
              }}
              columns={[
                { title: "名称", dataIndex: "name", key: "name", ellipsis: true },
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
          {itemsQuery.isError && (
            <Alert title="无法查询物品" tone="error">
              {errorMessage(itemsQuery.error)}
            </Alert>
          )}
          {(cursor || itemsQuery.data?.nextCursor) && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={!cursor} onClick={() => { setCursor(""); setSelected([]); }}>
                <ChevronLeft className="size-4" />第一页
              </Button>
              <Button variant="outline" size="sm" disabled={!itemsQuery.data?.nextCursor} onClick={() => { setCursor(itemsQuery.data?.nextCursor || ""); setSelected([]); }}>
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
