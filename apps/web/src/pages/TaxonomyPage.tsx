import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit3, Plus, Shapes, Tag as TagIcon, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { Category, Tag } from "@/lib/types";
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
} from "@/components/ui";

type Tab = "categories" | "tags";
type EditTarget =
  | { kind: "category"; item?: Category }
  | { kind: "tag"; item?: Tag };

export function TaxonomyPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("categories");
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [deleting, setDeleting] = useState<EditTarget | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reassignTargetId, setReassignTargetId] = useState("");
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  const list =
    tab === "categories" ? pageItems(categories.data) : pageItems(tags.data);
  const currentQuery = tab === "categories" ? categories : tags;
  const save = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error("缺少编辑对象");
      const endpoint = editing.kind === "category" ? "/categories" : "/tags";
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
        queryKey: editing?.kind === "category" ? ["categories"] : ["tags"],
      });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!deleting?.item) throw new Error("缺少删除对象");
      return api(
        `/${deleting.kind === "category" ? "categories" : "tags"}/${deleting.item.id}`,
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
        queryKey: deleting?.kind === "category" ? ["categories"] : ["tags"],
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
      <div className="mb-3 flex justify-end">
        <Button
          onClick={() =>
            openEdit({ kind: tab === "categories" ? "category" : "tag" })
          }
        >
          <Plus className="size-4" />
          新建{tab === "categories" ? "分类" : "标签"}
        </Button>
      </div>
      <div className="mb-5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "categories", label: "分类树" },
            { value: "tags", label: "标签" },
          ]}
        />
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
              ) : (
                <TagIcon className="size-5" />
              )}
              {tab === "categories" ? "分类" : "标签"}
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
                      kind: tab === "categories" ? "category" : "tag",
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
                      kind: tab === "categories" ? "category" : "tag",
                      item,
                    } as EditTarget)
                  }
                  aria-label={`删除 ${item.name}`}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={tab === "categories" ? Shapes : TagIcon}
          title={`还没有${tab === "categories" ? "分类" : "标签"}`}
          description={
            tab === "categories"
              ? "物品建档必须选择一个分类，可以建立最多 5 层分类树。"
              : "标签可关联物品、袋子、箱子和仓库，最多 20 个。"
          }
        />
      )}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`${editing?.item ? "编辑" : "新建"}${editing?.kind === "category" ? "分类" : "标签"}`}
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
        title={`删除${deleting?.kind === "category" ? "分类" : "标签"}`}
        description={
          deleting?.kind === "category"
            ? "有子分类或物品引用时会拒绝删除。"
            : "删除会解除所有档案关联并写入操作记录。"
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
                (deleting?.kind === "tag" && confirm !== deleting.item?.name) ||
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
          分类被引用时先迁移直接引用；有子分类时先处理子类。
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
        {deleting?.kind === "tag" && (
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
