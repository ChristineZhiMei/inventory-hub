import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Select as AntSelect, Spin } from "antd";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api, ApiError } from "@/lib/api";
import { pageItems, queries } from "@/lib/queries";
import type { InventoryNode, NodeType, Specification, Tag } from "@/lib/types";
import { Button, Field, Input, Label, Select, Textarea } from "./AntUi";
import { ImageManager, type EditableImage } from "./ImageManager";

const schema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(120, "名称最多 120 个字符"),
  categoryId: z.string().optional(),
  specificationIds: z.array(z.string()),
  notes: z.string().max(2000, "备注最多 2000 个字符").optional(),
  targetId: z.string().optional(),
  targetLocationToken: z.string().optional(),
  createMode: z.enum(["STAGE", "PLACE"]),
  tagIds: z.array(z.string()).max(20),
});
export type NodeFormData = z.infer<typeof schema>;

export function NodeForm({
  type,
  initial,
  submitLabel = "保存档案",
  onSubmit,
  busy,
}: {
  type: NodeType;
  initial?: InventoryNode;
  submitLabel?: string;
  onSubmit: (
    payload: NodeFormData & { images: EditableImage[] },
  ) => Promise<void>;
  busy?: boolean;
}) {
  const [images, setImages] = useState<EditableImage[]>(() =>
    (initial?.images || []).map((image) => ({
      key: image.id,
      imageId: image.id,
      preview: image.url || `/api/v1/images/${image.id}?variant=main`,
      state: "existing",
    })),
  );
  const queryClient = useQueryClient();
  const [createdTags, setCreatedTags] = useState<Tag[]>([]);
  const [createdSpecifications, setCreatedSpecifications] = useState<Specification[]>([]);
  const [specificationSearchInput, setSpecificationSearchInput] = useState("");
  const [specificationSearch, setSpecificationSearch] = useState("");
  const [creatingTaxonomy, setCreatingTaxonomy] = useState<"tag" | "specification" | null>(null);
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
    enabled: type === "ITEM",
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  const specifications = useInfiniteQuery({
    queryKey: ["specifications", "options", specificationSearch],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "30" });
      if (specificationSearch) params.set("q", specificationSearch);
      if (pageParam) params.set("cursor", String(pageParam));
      return queries.specifications(params.toString());
    },
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    enabled: type === "ITEM",
  });
  const locations = useQuery({
    queryKey: ["locations", "all"],
    queryFn: () => queries.locations("limit=100"),
    enabled: !initial && type !== "WAREHOUSE",
  });
  const defaultTargetId =
    new URLSearchParams(location.search).get("targetId") || "";
  const form = useForm<NodeFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name || "",
      categoryId: initial?.categoryId || initial?.category?.id || "",
      specificationIds: initial?.specifications?.map((item) => item.id) || [],
      notes: initial?.notes || "",
      targetId: defaultTargetId,
      createMode: defaultTargetId ? "PLACE" : "STAGE",
      tagIds: initial?.tags?.map((tag) => tag.id) || [],
    },
  });
  const createMode = form.watch("createMode");
  const selectedTags = form.watch("tagIds");
  const selectedSpecifications = form.watch("specificationIds");
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSpecificationSearch(specificationSearchInput.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [specificationSearchInput]);
  const tagOptions = useMemo(
    () => mergeTaxonomyOptions(initial?.tags, pageItems(tags.data), createdTags),
    [createdTags, initial?.tags, tags.data],
  );
  const specificationOptions = useMemo(
    () => mergeTaxonomyOptions(
      initial?.specifications,
      specifications.data?.pages.flatMap((page) => page.items),
      createdSpecifications,
    ),
    [createdSpecifications, initial?.specifications, specifications.data?.pages],
  );
  const allowedLocations = useMemo(
    () =>
      pageItems(locations.data).filter((node) => {
        if (node.stockStatus && node.stockStatus !== "IN_STOCK") return false;
        if (type === "BOX") return node.type === "WAREHOUSE";
        if (type === "BAG")
          return node.type === "WAREHOUSE" || node.type === "BOX";
        return (
          node.type === "WAREHOUSE" ||
          node.type === "BOX" ||
          node.type === "BAG"
        );
      }),
    [locations.data, type],
  );
  useEffect(() => {
    if (createMode === "STAGE") form.setValue("targetId", "");
  }, [createMode, form]);

  async function updateCreatableSelection(
    kind: "tag" | "specification",
    values: string[],
  ) {
    const knownOptions = kind === "tag" ? tagOptions : specificationOptions;
    const selectedIds: string[] = [];
    try {
      setCreatingTaxonomy(kind);
      for (const value of values) {
        const candidate = value.normalize("NFKC").trim().replace(/\s+/g, " ");
        const existing = knownOptions.find(
          (item) =>
            item.id === value ||
            item.name.localeCompare(candidate, "zh-CN", { sensitivity: "base" }) === 0,
        );
        if (existing) {
          selectedIds.push(existing.id);
          continue;
        }
        if (!candidate) continue;
        const created = await api<Tag | Specification>(
          kind === "tag" ? "/tags" : "/specifications",
          { method: "POST", idempotent: true, body: { name: candidate } },
        );
        selectedIds.push(created.id);
        if (kind === "tag") {
          setCreatedTags((current) => mergeTaxonomyOptions(current, [created as Tag]));
        } else {
          setCreatedSpecifications((current) => mergeTaxonomyOptions(current, [created as Specification]));
        }
      }
      const uniqueIds = [...new Set(selectedIds)];
      if (kind === "tag") {
        form.setValue("tagIds", uniqueIds.slice(0, 20), {
          shouldDirty: true,
          shouldValidate: true,
        });
        form.clearErrors("tagIds");
        await queryClient.invalidateQueries({ queryKey: ["tags"] });
      } else {
        form.setValue("specificationIds", uniqueIds, {
          shouldDirty: true,
          shouldValidate: true,
        });
        form.clearErrors("specificationIds");
        setSpecificationSearchInput("");
        setSpecificationSearch("");
        await queryClient.invalidateQueries({ queryKey: ["specifications"] });
      }
    } catch (error) {
      form.setError(kind === "tag" ? "tagIds" : "specificationIds", {
        message:
          error instanceof Error
            ? error.message
            : `${kind === "tag" ? "标签" : "规格"}创建失败`,
      });
    } finally {
      setCreatingTaxonomy(null);
    }
  }

  async function submit(values: NodeFormData) {
    form.clearErrors();
    if (type === "ITEM" && !values.categoryId) {
      form.setError("categoryId", { message: "物品必须选择分类" });
      return;
    }
    const usableImages = images.filter(
      (image) => image.state === "existing" || image.state === "ready",
    );
    if (type === "ITEM" && usableImages.length === 0) {
      form.setError("root", { message: "物品至少需要一张已处理完成的图片" });
      return;
    }
    if (
      images.some(
        (image) => image.state === "uploading" || image.state === "processing",
      )
    ) {
      form.setError("root", { message: "请等待图片处理完成" });
      return;
    }
    if (images.some((image) => image.state === "failed")) {
      form.setError("root", { message: "请重试或移除上传失败的图片" });
      return;
    }
    if (
      !initial &&
      values.createMode === "PLACE" &&
      type !== "WAREHOUSE" &&
      !values.targetId
    ) {
      form.setError("targetId", { message: "请选择实际放入的位置" });
      return;
    }
    const selectedLocation = allowedLocations.find(
      (location) => location.id === values.targetId,
    );
    try {
      await onSubmit({
        ...values,
        targetLocationToken:
          values.createMode === "PLACE"
            ? selectedLocation?.locationToken
            : undefined,
        images: usableImages,
      });
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length)
        for (const [name, message] of Object.entries(error.fields))
          form.setError(name as keyof NodeFormData, { message });
      else
        form.setError("root", {
          message: error instanceof Error ? error.message : "保存失败",
        });
    }
  }
  const typeName = {
    ITEM: "物品",
    BAG: "袋子",
    BOX: "箱子",
    WAREHOUSE: "仓库",
  }[type];
  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-6" noValidate>
      <section className="surface p-5">
        <h2 className="font-semibold">基本信息</h2>
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <Field
            label={`${typeName}名称`}
            htmlFor="name"
            error={form.formState.errors.name?.message}
            required
          >
            <Input
              id="name"
              aria-invalid={!!form.formState.errors.name}
              autoFocus
              {...form.register("name")}
              placeholder={
                type === "ITEM" ? "例如：灰色羊毛大衣" : `例如：${typeName}名称`
              }
            />
          </Field>
          {type === "ITEM" && (
            <Field
              label="主分类"
              htmlFor="categoryId"
              error={form.formState.errors.categoryId?.message}
              required
            >
              <Select
                id="categoryId"
                name="categoryId"
                value={form.watch("categoryId") || ""}
                aria-invalid={!!form.formState.errors.categoryId}
                onChange={(event) =>
                  form.setValue("categoryId", event.target.value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              >
                <option value="">选择分类</option>
                {pageItems(categories.data).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {type === "ITEM" && (
            <Field
              label="规格"
              error={form.formState.errors.specificationIds?.message}
              hint="可选择历史规格；输入新规格后按回车即可创建并添加"
            >
              <AntSelect
                mode="tags"
                value={selectedSpecifications}
                options={specificationOptions.map((item) => ({ value: item.id, label: item.name }))}
                placeholder="搜索或创建规格"
                size="large"
                className="w-full"
                filterOption={false}
                searchValue={specificationSearchInput}
                onSearch={setSpecificationSearchInput}
                onChange={(values) => void updateCreatableSelection("specification", values)}
                onPopupScroll={(event) => {
                  const target = event.currentTarget;
                  if (
                    target.scrollTop + target.clientHeight >= target.scrollHeight - 24 &&
                    specifications.hasNextPage &&
                    !specifications.isFetchingNextPage
                  ) {
                    void specifications.fetchNextPage();
                  }
                }}
                loading={specifications.isLoading || creatingTaxonomy === "specification"}
                notFoundContent={
                  specifications.isFetching ? <Spin size="small" /> : "输入后按回车创建"
                }
                maxTagCount="responsive"
                tokenSeparators={[",", "，"]}
                allowClear
              />
            </Field>
          )}
          <Field
            label="标签"
            error={form.formState.errors.tagIds?.message}
            hint="输入新标签后按回车即可创建并添加，最多选择 20 个"
            className={type === "ITEM" ? "" : "md:col-span-2"}
          >
            <AntSelect
              mode="tags"
              value={selectedTags}
              options={tagOptions.map((item) => ({ value: item.id, label: item.name }))}
              placeholder="选择或创建标签"
              size="large"
              className="w-full"
              optionFilterProp="label"
              onChange={(values) => void updateCreatableSelection("tag", values)}
              loading={tags.isLoading || creatingTaxonomy === "tag"}
              maxCount={20}
              maxTagCount="responsive"
              tokenSeparators={[",", "，"]}
              allowClear
            />
          </Field>
          <Field
            label="备注"
            htmlFor="notes"
            error={form.formState.errors.notes?.message}
            className="md:col-span-2"
          >
            <Textarea
              id="notes"
              {...form.register("notes")}
              placeholder="记录清洗、季节或其他说明"
            />
          </Field>
        </div>
      </section>
      <section className="surface p-5">
        <div className="mb-5">
          <h2 className="font-semibold">图片</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            第一张作为封面，可调整顺序；最多 5 张。
          </p>
        </div>
        <ImageManager
          value={images}
          onChange={setImages}
          required={type === "ITEM"}
          disabled={busy}
        />
      </section>
      {!initial && type !== "WAREHOUSE" && (
        <section className="surface p-5">
          <h2 className="font-semibold">保存位置</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            “仅建档”会放入系统暂存区；只有确认已经实际收纳时才选择位置。
          </p>
          <Radio.Group
            value={createMode}
            onChange={(event) =>
              form.setValue("createMode", event.target.value, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
            className="app-location-mode"
          >
            <Radio value="STAGE" className="app-location-mode__option">
              <span>
                <span className="block text-sm font-medium">仅建档</span>
                <span className="text-xs text-muted-foreground">放入暂存区</span>
              </span>
            </Radio>
            <Radio value="PLACE" className="app-location-mode__option">
              <span>
                <span className="block text-sm font-medium">保存并放入</span>
                <span className="text-xs text-muted-foreground">记录实际收纳位置</span>
              </span>
            </Radio>
          </Radio.Group>
          {createMode === "PLACE" && (
            <Field
              label="目标位置"
              htmlFor="targetId"
              error={form.formState.errors.targetId?.message}
              required
              className="mt-4"
            >
              <Select
                id="targetId"
                name="targetId"
                value={form.watch("targetId") || ""}
                onChange={(event) =>
                  form.setValue("targetId", event.target.value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              >
                <option value="">选择合法位置</option>
                {allowedLocations.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.code} · {node.name}
                    {node.path?.length
                      ? ` / ${node.path.map((item) => item.name).join(" / ")}`
                      : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </section>
      )}
      {form.formState.errors.root?.message && (
        <p
          className="rounded-md border border-destructive/40 bg-red-50 p-4 text-sm text-destructive"
          role="alert"
        >
          {form.formState.errors.root.message}
        </p>
      )}
      <div className="safe-bottom sticky bottom-20 z-10 flex justify-end gap-3 border-t bg-background/95 py-4 backdrop-blur lg:bottom-0">
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function mergeTaxonomyOptions<T extends { id: string; name: string }>(
  ...groups: Array<readonly T[] | undefined>
): T[] {
  const merged = new Map<string, T>();
  for (const item of groups.flatMap((group) => group ?? [])) merged.set(item.id, item);
  return [...merged.values()];
}
