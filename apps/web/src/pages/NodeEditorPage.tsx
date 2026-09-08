import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "@/lib/api";
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
  const type =
    forcedType ||
    (params.get("type") as NodeType | null) ||
    detail.data?.type ||
    "ITEM";
  const sourceItemId = mode === "create" && type !== "ITEM"
    ? params.get("sourceItemId")
    : null;
  const sourceItem = useQuery({
    queryKey: ["node", sourceItemId],
    queryFn: () => queries.node(sourceItemId!),
    enabled: Boolean(sourceItemId),
  });
  const inheritedTargetId = sourceItem.data
    ? closestAllowedParentId(sourceItem.data.path, type)
    : undefined;
  const mutation = useMutation({
    mutationFn: async (values: NodeFormData & { images: EditableImage[] }) => {
      if (mode === "create")
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
            uploadIds: values.images
              .map((image) => image.uploadId)
              .filter(Boolean),
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
        title={mode === "create" ? `新建${typeName}` : `编辑${typeName}`}
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
      {sourceItem.data && (
        <Alert title="创建后自动装入" tone="info" className="mb-4">
          创建{typeName}成功后，{sourceItem.data.name}（{sourceItem.data.code}）会自动移动到该{typeName}中。
        </Alert>
      )}
      <NodeForm
        key={mode === "edit" ? `${id}:${detail.data?.version}` : `create:${type}:${sourceItem.data?.version || "empty"}`}
        type={type}
        initial={detail.data}
        prefill={sourceItem.data}
        defaultTargetId={inheritedTargetId}
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

function closestAllowedParentId(
  path: Array<{ id: string; type: NodeType }> | undefined,
  childType: NodeType,
): string | undefined {
  const allowedParents: Record<NodeType, NodeType[]> = {
    WAREHOUSE: [],
    BOX: ["WAREHOUSE"],
    BAG: ["BOX", "WAREHOUSE"],
    ITEM: ["BAG", "BOX", "WAREHOUSE"],
  };
  return path
    ?.slice(1)
    .find((entry) => allowedParents[childType].includes(entry.type))
    ?.id;
}
