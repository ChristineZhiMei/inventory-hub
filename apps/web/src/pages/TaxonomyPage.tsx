import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit3, Plus, Ruler, Search, Shapes, Tag as TagIcon, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { Category, Specification, Tag } from "@/lib/types";
import { QueryError } from "@/components/Page";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  Input,
  Segmented,
  Select,
} from "@/components/AntUi";

type Tab = "categories" | "tags" | "specifications";
type EditTarget =
  | { kind: "category"; item?: Category }
  | { kind: "tag"; item?: Tag }
  | { kind: "specification"; item?: Specification };

const kindLabel = (kind: EditTarget["kind"] | Tab) =>
  kind === "category" || kind === "categories"
    ? "分类"
    : kind === "tag" || kind === "tags"
      ? "标签"
      : "规格";
const queryKeyForKind = (kind: EditTarget["kind"]) =>
  kind === "category" ? ["categories"] : kind === "tag" ? ["tags"] : ["specifications"];

export function TaxonomyPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("categories");
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [deleting, setDeleting] = useState<EditTarget | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reassignTargetId, setReassignTargetId] = useState("");
  const [specificationSearchInput, setSpecificationSearchInput] = useState("");
  const [specificationSearch, setSpecificationSearch] = useState("");
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  useEffect(() => {
    const timer = window.setTimeout(() => setSpecificationSearch(specificationSearchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [specificationSearchInput]);
  const specifications = useInfiniteQuery({
    queryKey: ["specifications", "manager", specificationSearch],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (specificationSearch) params.set("q", specificationSearch);
      if (pageParam) params.set("cursor", String(pageParam));
      return queries.specifications(params.toString());
    },
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
  });
  const list =
    tab === "categories"
      ? pageItems(categories.data)
      : tab === "tags"
        ? pageItems(tags.data)
        : specifications.data?.pages.flatMap((page) => page.items) ?? [];
  const currentQuery = tab === "categories" ? categories : tab === "tags" ? tags : specifications;
  const save = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error("缺少编辑对象");
      const endpoint =
        editing.kind === "category"
          ? "/categories"
          : editing.kind === "tag"
            ? "/tags"
            : "/specifications";
      const body =
        editing.kind === "category"
          ? editing.item
            ? {
                name,
                parentId: parentId || null,
                expectedVersion: editing.item.version,
              }
            : { name, ...(parentId ? { parentId } : {}) }
          : {
              name,
              ...(editing.item
                ? { expectedVersion: editing.item.version }
                : {}),
            };
      return api(`${endpoint}${editing.item ? `/${editing.item.id}` : ""}`, {
        method: editing.item ? "PATCH" : "POST",
        body,
        idempotent: true,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: editing ? queryKeyForKind(editing.kind) : [],
      });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!deleting?.item) throw new Error("缺少删除对象");
      return api(
        `/${deleting.kind === "category" ? "categories" : deleting.kind === "tag" ? "tags" : "specifications"}/${deleting.item.id}`,
        {
          method: "DELETE",
          idempotent: true,
          body:
            deleting.kind === "category"
              ? { expectedVersion: deleting.item.version }
              : {
                  expectedVersion: deleting.item.version,
                  confirmName: confirm,
                  referenceToken: deleting.item.referenceToken,
                },
        },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: deleting ? queryKeyForKind(deleting.kind) : [],
      });
      setDeleting(null);
      setConfirm("");
    },
  });
  const reassign = useMutation({
    mutationFn: () => {
      if (deleting?.kind !== "category" || !deleting.item || !reassignTargetId)
        throw new Error("请选择目标分类");
      return api(`/categories/${deleting.item.id}/reassign`, {
        method: "POST",
        idempotent: true,
        body: {
          targetCategoryId: reassignTargetId,
          expectedVersion: deleting.item.version,
          previewCount: deleting.item.referenceCount || 0,
          referenceToken: deleting.item.referenceToken,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["categories"] });
      setDeleting(null);
      setReassignTargetId("");
    },
  });
  function openEdit(target: EditTarget) {
    setEditing(target);
    setName(target.item?.name || "");
    setParentId(target.kind === "category" ? target.item?.parentId || "" : "");
  }
  const editingExcluded =
    editing?.kind === "category" && editing.item
      ? descendantIds(editing.item.id, pageItems(categories.data))
      : new Set<string>();
  const deletingExcluded =
    deleting?.kind === "category" && deleting.item
      ? descendantIds(deleting.item.id, pageItems(categories.data))
      : new Set<string>();
  return (
    <div>
      <div className="page-toolbar">
        <div className="page-toolbar__filters">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "categories", label: "分类树" },
              { value: "tags", label: "标签" },
              { value: "specifications", label: "规格记录" },
            ]}
          />
          {tab === "specifications" && (
            <Input
              value={specificationSearchInput}
              onChange={(event) => setSpecificationSearchInput(event.target.value)}
              placeholder="搜索历史规格"
              prefix={<Search className="size-4" />}
              className="taxonomy-search"
            />
          )}
        </div>
        <div className="page-toolbar__actions">
        <Button
          onClick={() =>
            openEdit({
              kind:
                tab === "categories"
                  ? "category"
                  : tab === "tags"
                    ? "tag"
                    : "specification",
            })
          }
        >
          <Plus className="size-4" />
          新建{kindLabel(tab)}
        </Button>
        </div>
      </div>
      {currentQuery.isLoading ? (
        <p>加载中…</p>
      ) : currentQuery.isError ? (
        <QueryError
          error={currentQuery.error}
          onRetry={() => currentQuery.refetch()}
        />
      ) : list.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {tab === "categories" ? (
                <Shapes className="size-5" />
              ) : tab === "tags" ? (
                <TagIcon className="size-5" />
              ) : (
                <Ruler className="size-5" />
              )}
              {kindLabel(tab)}
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {list.map((item) => (
              <div
                key={item.id}
                className="flex min-h-16 items-center gap-3 py-2"
                style={{
                  paddingLeft:
                    tab === "categories"
                      ? getCategoryDepth(
                          item as Category,
                          pageItems(categories.data),
                        ) * 20
                      : 0,
                }}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    直接引用 {item.referenceCount ?? 0} 个档案
                  </p>
                </div>
                <Badge variant="outline">v{item.version}</Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    openEdit({
                      kind:
                        tab === "categories"
                          ? "category"
                          : tab === "tags"
                            ? "tag"
                            : "specification",
                      item,
                    } as EditTarget)
                  }
                  aria-label={`编辑 ${item.name}`}
                >
                  <Edit3 className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setDeleting({
                      kind:
                        tab === "categories"
                          ? "category"
                          : tab === "tags"
                            ? "tag"
                            : "specification",
                      item,
                    } as EditTarget)
                  }
                  aria-label={`删除 ${item.name}`}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            ))}
            {tab === "specifications" && specifications.hasNextPage && (
              <div className="flex justify-center py-4">
                <Button
                  variant="outline"
                  loading={specifications.isFetchingNextPage}
                  onClick={() => specifications.fetchNextPage()}
                >
                  加载更多
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={tab === "categories" ? Shapes : tab === "tags" ? TagIcon : Ruler}
          title={`还没有${kindLabel(tab)}`}
          description={
            tab === "categories"
              ? "物品建档必须选择一个分类，可以建立最多 5 层分类树。"
              : tab === "tags"
                ? "标签可关联物品、袋子、箱子和仓库，每个档案最多 20 个。"
                : "创建过的规格会保留在这里，之后建档时可以搜索并复用。"
          }
        />
      )}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`${editing?.item ? "编辑" : "新建"}${editing ? kindLabel(editing.kind) : "记录"}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              loading={save.isPending}
              disabled={!name.trim()}
              onClick={() => save.mutate()}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="名称" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </Field>
          {editing?.kind === "category" && (
            <Field label="上级分类">
              <Select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">顶级分类</option>
                {pageItems(categories.data)
                  .filter(
                    (item) =>
                      item.id !== editing.item?.id &&
                      !editingExcluded.has(item.id),
                  )
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {save.error && (
            <Alert title="保存失败" tone="error">
              {errorMessage(save.error)}
            </Alert>
          )}
        </div>
      </Dialog>
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`删除${deleting ? kindLabel(deleting.kind) : "记录"}`}
        description={
          deleting?.kind === "category"
            ? "有子分类或物品引用时会拒绝删除。"
            : `删除会解除所有档案中的${deleting ? kindLabel(deleting.kind) : "记录"}关联并写入操作记录。`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              disabled={
                (deleting?.kind !== "category" && confirm !== deleting?.item?.name) ||
                (deleting?.kind === "category" &&
                  ((deleting.item?.referenceCount || 0) > 0 ||
                    (deleting.item?.childCount || 0) > 0))
              }
              onClick={() => remove.mutate()}
            >
              确认删除
            </Button>
          </>
        }
      >
        <Alert title="删除不会改变任何物品位置" tone="warning">
          {deleting?.kind === "category"
            ? "分类被引用时先迁移直接引用；有子分类时先处理子类。"
            : `删除后，所有档案会解除该${deleting ? kindLabel(deleting.kind) : "记录"}关联。`}
        </Alert>
        {deleting?.kind === "category" &&
          (deleting.item?.referenceCount || 0) > 0 && (
            <div className="mt-4 rounded-md border p-4">
              <Field
                label={`将 ${deleting.item?.referenceCount} 个直接引用迁移到`}
              >
                <Select
                  value={reassignTargetId}
                  onChange={(event) => setReassignTargetId(event.target.value)}
                >
                  <option value="">选择目标分类</option>
                  {pageItems(categories.data)
                    .filter(
                      (category) =>
                        category.id !== deleting.item?.id &&
                        !deletingExcluded.has(category.id),
                    )
                    .map((category) => (
                      <option value={category.id} key={category.id}>
                        {category.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Button
                variant="outline"
                className="mt-3"
                loading={reassign.isPending}
                disabled={!reassignTargetId}
                onClick={() => reassign.mutate()}
              >
                迁移直接引用
              </Button>
              {reassign.error && (
                <p className="mt-2 text-sm text-destructive">
                  {errorMessage(reassign.error)}
                </p>
              )}
            </div>
          )}
        {deleting?.kind !== "category" && deleting?.item && (
          <Field label={`输入“${deleting.item?.name}”确认`}>
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        )}
        {remove.error && (
          <Alert title="删除失败" tone="error" className="mt-4">
            {errorMessage(remove.error)}
          </Alert>
        )}
      </Dialog>
    </div>
  );
}

function getCategoryDepth(category: Category, all: Category[]) {
  let depth = 0;
  let current = category;
  const visited = new Set<string>();
  while (current.parentId && depth < 5 && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = all.find((item) => item.id === current.parentId);
    if (!parent) break;
    current = parent;
    depth += 1;
  }
  return depth;
}
function descendantIds(categoryId: string, all: Category[]) {
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const category of all)
      if (category.parentId === id && !found.has(category.id)) {
        found.add(category.id);
        visit(category.id);
      }
  };
  visit(categoryId);
  return found;
}
