import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "@/lib/api";
import { copyImageToUpload, copyPrefill, parseCopyFields } from "@/lib/nodeCopy";
import { queries } from "@/lib/queries";
import type { NodeType } from "@/lib/types";
import { NodeForm, type NodeFormData } from "@/components/NodeForm";
import { PageHeader, QueryError } from "@/components/Page";
import { Alert, Skeleton } from "@/components/AntUi";
import type { EditableImage } from "@/components/ImageManager";

export function NodeEditorPage({
  mode,
  forcedType,
}: {
  mode: "create" | "edit";
  forcedType?: NodeType;
}) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["node", id],
    queryFn: () => queries.node(id!),
    enabled: mode === "edit" && !!id,
  });
  const copyFrom = mode === "create" ? params.get("copyFrom") : null;
  const copyFields = parseCopyFields((params.get("fields") ?? "").split(","));
  const copySource = useQuery({
    queryKey: ["node", copyFrom],
    queryFn: () => queries.node(copyFrom!),
    enabled: !!copyFrom,
  });
  const copiedUploads = useRef(new Map<string, Promise<string>>());
  const type =
    copySource.data?.type ||
    forcedType ||
    (params.get("type") as NodeType | null) ||
    detail.data?.type ||
    "ITEM";
  const sourceItemId = mode === "create" && !copyFrom && type !== "ITEM"
    ? params.get("sourceItemId")
    : null;
  const sourceItem = useQuery({
    queryKey: ["node", sourceItemId],
    queryFn: () => queries.node(sourceItemId!),
    enabled: Boolean(sourceItemId),
  });
  const mutation = useMutation({
    mutationFn: async (values: NodeFormData & { images: EditableImage[] }) => {
      if (mode === "create") {
        const uploadIds: string[] = [];
        for (const image of values.images) {
          if (image.sourceImageId) {
            let upload = copiedUploads.current.get(image.key);
            if (!upload) {
              upload = copyImageToUpload(image.sourceImageId, image.key).catch((error) => {
                copiedUploads.current.delete(image.key);
                throw error;
              });
              copiedUploads.current.set(image.key, upload);
            }
            uploadIds.push(await upload);
          } else if (image.uploadId) uploadIds.push(image.uploadId);
        }
        return api<{ id?: string; node?: { id: string } }>("/nodes", {
          method: "POST",
          idempotent: true,
          body: {
            type,
            name: values.name,
            notes: values.notes || undefined,
            categoryIds: values.categoryIds,
            specificationIds: values.specificationIds,
            tagIds: values.tagIds,
            uploadIds,
            createMode: type === "WAREHOUSE" ? "STAGE" : values.createMode,
            targetId:
              values.createMode === "PLACE" ? values.targetId : undefined,
            targetLocationToken:
              values.createMode === "PLACE"
                ? values.targetLocationToken
                : undefined,
            initialContent: sourceItem.data
              ? {
                  nodeId: sourceItem.data.id,
                  expectedLocationVersion: sourceItem.data.locationVersion,
                  locationToken: sourceItem.data.locationToken,
                  subtreeToken: sourceItem.data.subtreeToken,
                }
              : undefined,
          },
        });
      }
      return api<{ id?: string; node?: { id: string } }>(`/nodes/${id}`, {
        method: "PATCH",
        idempotent: true,
        body: {
          expectedVersion: detail.data!.version,
          name: values.name,
          notes: values.notes || "",
          categoryIds: values.categoryIds,
          specificationIds: values.specificationIds,
          tagIds: values.tagIds,
          images: values.images.map((image) =>
            image.imageId
              ? { imageId: image.imageId }
              : { uploadId: image.uploadId },
          ),
        },
      });
    },
    onSuccess: async (result, values) => {
      await queryClient.invalidateQueries();
      const resultId = result.node?.id || result.id || id;
      if (
        mode === "create" &&
        type === "ITEM" &&
        resultId &&
        values.nextCreateType !== "NONE"
      ) {
        navigate(
          `/archives/new?type=${values.nextCreateType}&sourceItemId=${encodeURIComponent(resultId)}`,
          { replace: true },
        );
        return;
      }
      navigate(
        `/archives/${resultId}`,
        { replace: true },
      );
    },
  });
  const typeName = {
    ITEM: "物品",
    BAG: "袋子",
    BOX: "箱子",
    WAREHOUSE: "仓库",
  }[type];
  if (copyFrom && copySource.isError) return <><PageHeader title="复制档案" back /><QueryError error={copySource.error} onRetry={() => copySource.refetch()} /></>;
  if (copyFrom && !copySource.data) return <><PageHeader title="加载复制来源…" back /><Skeleton className="h-96" /></>;
  if (copySource.data?.isSystemStaging) return <Alert title="系统暂存区不能复制" tone="error" />;
  const copiedParent = copySource.data?.path?.[1];
  const copyTargetId = copyFields.includes("location") && type !== "WAREHOUSE" && !copiedParent?.isSystemStaging
    ? copySource.data?.parentId ?? undefined
    : undefined;
  if (mode === "edit" && detail.isError)
    return (
      <>
        <PageHeader title="档案编辑" back />
        <QueryError error={detail.error} onRetry={() => detail.refetch()} />
      </>
    );
  if (mode === "edit" && !detail.data)
    return (
      <>
        <PageHeader title="加载档案…" back />
        <Skeleton className="h-96" />
      </>
    );
  if (sourceItemId && sourceItem.isError)
    return (
      <>
        <PageHeader title={`新建${typeName}`} back />
        <QueryError error={sourceItem.error} onRetry={() => sourceItem.refetch()} />
      </>
    );
  if (sourceItemId && !sourceItem.data)
    return (
      <>
        <PageHeader title={`新建${typeName}`} back />
        <Skeleton className="h-96" />
      </>
    );
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={mode === "create" ? `${copyFrom ? "复制" : "新建"}${typeName}` : `编辑${typeName}`}
        description={
          mode === "create"
            ? "保存后系统会分配唯一编号；编号不会因改名或移动而改变。"
            : `${detail.data?.code} · 编号、类型、位置和状态不可在档案编辑中修改。`
        }
        back
      />
      {mutation.error && (
        <Alert title="保存失败" tone="error" className="mb-4">
          {errorMessage(mutation.error)}
        </Alert>
      )}
      {copySource.data && <Alert title={`复制自 ${copySource.data.name}`} tone="info" className="mb-4">仅预填所选基本信息，保存后生成新编号，不包含下级内容。未勾选的必填信息需补齐。</Alert>}
      {sourceItem.data && (
        <Alert title="创建后自动装入" tone="info" className="mb-4">
          创建{typeName}成功后，{sourceItem.data.name}（{sourceItem.data.code}）会自动移动到该{typeName}中。
        </Alert>
      )}
      <NodeForm
        key={mode === "edit" ? `${id}:${detail.data?.version}` : `create:${type}:${copyFrom || sourceItemId || "empty"}:${params.get("fields") || ""}`}
        type={type}
        initial={detail.data}
        prefill={copySource.data
          ? copyPrefill(copySource.data, copyFields)
          : sourceItem.data ? copyPrefill(sourceItem.data, ["name", "categories", "specifications", "tags"]) : undefined}
        defaultTargetId={copyTargetId}
        onSubmit={(payload) =>
          mutation.mutateAsync(payload).then(() => undefined)
        }
        busy={mutation.isPending}
        submitLabel={
          mode === "create" && sourceItem.data
            ? `创建${typeName}并装入物品`
            : mode === "create"
              ? `创建${typeName}`
              : "保存修改"
        }
      />
    </div>
  );
}
