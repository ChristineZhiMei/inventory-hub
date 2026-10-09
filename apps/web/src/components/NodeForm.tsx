import { ITEM_CATEGORY_LIMIT, type AiRecognitionResult } from "@inventory-hub/contracts";
import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Spin } from "antd";
import { Controller, useForm } from "react-hook-form";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { api, ApiError } from "@/lib/api";
import { useRecentSelections } from "@/lib/recentSelections";
import type { NodePrefill } from "@/lib/nodeCopy";
import { useMediaQuery } from "@/lib/media";
import { pageItems, queries } from "@/lib/queries";
import { useSelectPopupScrollGuard } from "@/lib/scrollLock";
import type { Category, InventoryNode, NodeType, Specification, Tag } from "@/lib/types";
import { Button, Field, Input, Label, Select, Textarea } from "./AntUi";
import { TaxonomySelect } from "./TaxonomySelect";
import { AiRecognition } from "./AiRecognition";
import { ImageManager, type EditableImage } from "./ImageManager";

const SYSTEM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const schema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(120, "名称最多 120 个字符"),
  categoryIds: z.array(z.string()).max(ITEM_CATEGORY_LIMIT, "每个档案最多选择三个分类"),
  specificationIds: z.array(z.string()),
  notes: z.string().max(2000, "备注最多 2000 个字符").optional(),
  targetId: z.string().optional(),
  targetLocationToken: z.string().optional(),
  createMode: z.enum(["STAGE", "PLACE"]),
  nextCreateType: z.enum(["NONE", "BAG", "BOX", "WAREHOUSE"]),
  tagIds: z.array(z.string()),
});
export type NodeFormData = z.infer<typeof schema>;

export function NodeForm({
  type,
  initial,
  prefill,
  defaultTargetId: inheritedTargetId,
  submitLabel = "保存档案",
  onSubmit,
  busy,
}: {
  type: NodeType;
  initial?: InventoryNode;
  prefill?: NodePrefill;
  defaultTargetId?: string;
  submitLabel?: string;
  onSubmit: (
    payload: NodeFormData & { images: EditableImage[] },
  ) => Promise<void>;
  busy?: boolean;
}) {
  const [images, setImages] = useState<EditableImage[]>(() =>
    (initial?.images || prefill?.images || []).map((image) => ({
      key: initial ? image.id : crypto.randomUUID(),
      ...(initial ? { imageId: image.id } : { sourceImageId: image.id }),
      preview: image.url || `/api/v1/images/${image.id}?variant=main`,
      state: "existing",
    })),
  );
  const queryClient = useQueryClient();
  const [taxonomyPopupOpen, setTaxonomyPopupOpen] = useState(false);
  const recent = useRecentSelections(taxonomyPopupOpen);
  const recentSpecifications = recent.ids("specification").join(",");
  const [aiBusy, setAiBusy] = useState(false);
  const [retainedCategories, setRetainedCategories] = useState<Category[]>([]);
  const [retainedTags, setRetainedTags] = useState<Tag[]>([]);
  const [retainedSpecifications, setRetainedSpecifications] = useState<Specification[]>([]);
  const [specificationSearchInput, setSpecificationSearchInput] = useState("");
  const [specificationSearch, setSpecificationSearch] = useState("");
  const [creatingTaxonomy, setCreatingTaxonomy] = useState<"tag" | "specification" | null>(null);
  const mobile = useMediaQuery("(max-width: 767px)");
  const [searchParams] = useSearchParams();
  useSelectPopupScrollGuard(mobile && taxonomyPopupOpen);
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  const specifications = useInfiniteQuery({
    queryKey: ["specifications", "options", specificationSearch, recentSpecifications],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "30" });
      if (recentSpecifications) params.set("recentIds", recentSpecifications);
      if (specificationSearch) params.set("q", specificationSearch);
      if (pageParam) params.set("cursor", String(pageParam));
      return queries.specifications(params.toString());
    },
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
  });
  const locations = useQuery({
    queryKey: ["locations", "all"],
    queryFn: () => queries.locations("limit=100"),
    enabled: !initial && type !== "WAREHOUSE",
  });
  const defaultTargetId =
    searchParams.get("targetId") ||
    inheritedTargetId ||
    "";
  const defaultLocation = useQuery({
    queryKey: ["node", defaultTargetId],
    queryFn: () => queries.node(defaultTargetId),
    enabled: !initial && type !== "WAREHOUSE" && !!defaultTargetId,
  });
  const form = useForm<NodeFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name || prefill?.name || "",
      categoryIds:
        initial?.categories?.map((category) => category.id) ||
        (initial?.categoryId || initial?.category?.id
          ? [initial.categoryId || initial.category!.id]
          : prefill?.categories?.map((category) => category.id) ||
            (prefill?.categoryId || prefill?.category?.id
              ? [prefill.categoryId || prefill.category!.id]
              : [])),
      specificationIds:
        initial?.specifications?.map((item) => item.id) ||
        prefill?.specifications?.map((item) => item.id) ||
        [],
      notes: initial?.notes || prefill?.notes || "",
      targetId: defaultTargetId,
      createMode: defaultTargetId ? "PLACE" : "STAGE",
      nextCreateType: "NONE",
      tagIds: initial?.tags?.map((tag) => tag.id) || prefill?.tags?.map((tag) => tag.id) || [],
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
    () => mergeTaxonomyOptions(initial?.tags, prefill?.tags, pageItems(tags.data), retainedTags),
    [initial?.tags, prefill?.tags, retainedTags, tags.data],
  );
  const categoryOptions = useMemo(
    () => mergeTaxonomyOptions(initial?.categories, prefill?.categories, pageItems(categories.data), retainedCategories),
    [categories.data, initial?.categories, prefill?.categories, retainedCategories],
  );
  const specificationOptions = useMemo(
    () => mergeTaxonomyOptions(
      initial?.specifications,
      prefill?.specifications,
      specifications.data?.pages.flatMap((page) => page.items),
      retainedSpecifications,
    ),
    [
      initial?.specifications,
      prefill?.specifications,
      retainedSpecifications,
      specifications.data?.pages,
    ],
  );
  const allowedLocations = useMemo(
    () =>
      mergeTaxonomyOptions(pageItems(locations.data), defaultLocation.data ? [defaultLocation.data] : []).filter((node) => {
        if (node.isSystemStaging) return false;
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
    [locations.data, defaultLocation.data, type],
  );
  useEffect(() => {
    if (createMode === "STAGE") form.setValue("targetId", "");
  }, [createMode, form]);

  async function updateCreatableSelection(
    kind: "tag" | "specification",
    values: string[],
  ) {
    const knownOptions = kind === "tag" ? tagOptions : specificationOptions;
    const previouslySelectedIds = new Set(
      form.getValues(kind === "tag" ? "tagIds" : "specificationIds"),
    );
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
          if (kind === "tag") {
            setRetainedTags((current) =>
              mergeTaxonomyOptions(current, [existing as Tag]),
            );
          } else {
            setRetainedSpecifications((current) =>
              mergeTaxonomyOptions(current, [existing as Specification]),
            );
          }
          continue;
        }
        if (!candidate) continue;
        if (SYSTEM_ID_PATTERN.test(candidate)) {
          if (previouslySelectedIds.has(value)) {
            selectedIds.push(value);
            continue;
          }
          throw new Error(
            `${kind === "tag" ? "标签" : "规格"}名称不能使用系统标识格式`,
          );
        }
        const created = await api<Tag | Specification>(
          kind === "tag" ? "/tags" : "/specifications",
          { method: "POST", idempotent: true, body: { name: candidate } },
        );
        selectedIds.push(created.id);
        if (kind === "tag") {
          setRetainedTags((current) => mergeTaxonomyOptions(current, [created as Tag]));
        } else {
          setRetainedSpecifications((current) =>
            mergeTaxonomyOptions(current, [created as Specification]),
          );
        }
      }
      const uniqueIds = [...new Set(selectedIds)];
      recent.record(kind, uniqueIds, [...previouslySelectedIds]);
      if (kind === "tag") {
        form.setValue("tagIds", uniqueIds, {
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

  function applyRecognition(result: AiRecognitionResult) {
    const before: AiRecognitionResult["values"] = {};
    setRetainedCategories((current) => mergeTaxonomyOptions(current, result.options.categories));
    setRetainedSpecifications((current) => mergeTaxonomyOptions(current, result.options.specifications));
    setRetainedTags((current) => mergeTaxonomyOptions(current, result.options.tags));
    const options = { shouldDirty: true, shouldValidate: true };
    if (result.values.name !== undefined) {
      before.name = form.getValues("name");
      form.setValue("name", result.values.name, options);
    }
    for (const field of ["categoryIds", "specificationIds", "tagIds"] as const) {
      const value = result.values[field];
      if (value !== undefined) {
        before[field] = [...form.getValues(field)];
        const selected = field === "categoryIds" ? value.slice(0, ITEM_CATEGORY_LIMIT) : value;
        const kind = field === "categoryIds" ? "category" : field === "specificationIds" ? "specification" : "tag";
        recent.record(kind, selected, before[field]);
        form.setValue(field, selected, options);
      }
    }
    return () => {
      if (before.name !== undefined) form.setValue("name", before.name, options);
      for (const field of ["categoryIds", "specificationIds", "tagIds"] as const) {
        if (before[field] !== undefined) form.setValue(field, before[field], options);
      }
    };
  }

  async function submit(values: NodeFormData) {
    if (aiBusy) return;
    form.clearErrors();
    if (type === "ITEM" && values.categoryIds.length === 0) {
      form.setError("categoryIds", { message: "物品必须至少选择一个分类" });
      return;
    }
    const usableImages = images.filter(
      (image) => image.state === "existing" || image.state === "ready",
    );
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
    if (!initial && values.createMode === "PLACE" && type !== "WAREHOUSE" && !selectedLocation) {
      form.setError("targetId", { message: "所选位置已不可用，请重新选择" });
      return;
    }
    try {
      await onSubmit({
        ...values,
        targetLocationToken:
          values.createMode === "PLACE"
            ? selectedLocation?.locationToken
            : undefined,
        images: usableImages,
      });
      // Also count successfully saved prefills (copy/edit/AI), which may never
      // pass through a select's onChange handler.
      recent.record("category", values.categoryIds);
      recent.record("specification", values.specificationIds);
      recent.record("tag", values.tagIds);
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
      <section className="surface p-5" inert={aiBusy} aria-busy={aiBusy}>
        <h2 className="font-semibold">基本信息</h2>
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <Field
            label={`${typeName}名称`}
            htmlFor="name"
            error={form.formState.errors.name?.message}
            required
          >
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  {...field}
                  id="name"
                  value={field.value}
                  autoComplete="off"
                  aria-invalid={!!form.formState.errors.name}
                  autoFocus={!mobile}
                  placeholder={
                    type === "ITEM" ? "例如：灰色羊毛大衣" : `例如：${typeName}名称`
                  }
                />
              )}
            />
          </Field>
          <Field
            label="分类（最多 3 个）"
            error={form.formState.errors.categoryIds?.message}
            required={type === "ITEM"}
          >
            <TaxonomySelect
              id="categoryIds"
              aria-label="分类"
              mode="multiple"
              value={form.watch("categoryIds")}
              options={recent.sort("category", categoryOptions).map((category) => ({
                value: category.id,
                label: category.name,
              }))}
              placeholder="选择分类"
              size="large"
              className="w-full"
              optionFilterProp="label"
              maxCount={ITEM_CATEGORY_LIMIT}
              maxTagCount={mobile ? 1 : "responsive"}
              virtual={!mobile}
              onOpenChange={setTaxonomyPopupOpen}
              onChange={(values) => {
                recent.record("category", values, form.getValues("categoryIds"));
                form.setValue("categoryIds", values, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
              allowClear
            />
          </Field>
            <Field
              label="规格"
              error={form.formState.errors.specificationIds?.message}
            >
              <TaxonomySelect
                id="specificationIds"
                aria-label="规格"
                mode="tags"
                value={selectedSpecifications}
                options={recent.sort("specification", specificationOptions).map((item) => ({ value: item.id, label: item.name }))}
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
                virtual={!mobile}
                onOpenChange={setTaxonomyPopupOpen}
                loading={specifications.isLoading || creatingTaxonomy === "specification"}
                notFoundContent={
                  specifications.isFetching ? <Spin size="small" /> : "输入后按回车创建"
                }
                maxTagCount={mobile ? 1 : "responsive"}
                tokenSeparators={[",", "，", "/", "／"]}
                allowClear
              />
          </Field>
          <Field
            label="标签"
            error={form.formState.errors.tagIds?.message}
            className="md:col-span-2"
          >
            <TaxonomySelect
              id="tagIds"
              aria-label="标签"
              mode="tags"
              value={selectedTags}
              options={recent.sort("tag", tagOptions).map((item) => ({ value: item.id, label: item.name }))}
              placeholder="选择或创建标签"
              size="large"
              className="w-full"
              optionFilterProp="label"
              virtual={!mobile}
              onOpenChange={setTaxonomyPopupOpen}
              onChange={(values) => void updateCreatableSelection("tag", values)}
              loading={tags.isLoading || creatingTaxonomy === "tag"}
              maxTagCount={mobile ? 1 : "responsive"}
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
            <Controller
              control={form.control}
              name="notes"
              render={({ field }) => (
                <Textarea
                  {...field}
                  id="notes"
                  value={field.value || ""}
                  placeholder="记录清洗、季节或其他说明"
                />
              )}
            />
          </Field>
        </div>
      </section>
      <section className="surface p-5">
        <h2 className="mb-5 font-semibold">图片（选填，最多 5 张）</h2>
        <ImageManager
          value={images}
          onChange={setImages}
          disabled={busy || aiBusy}
        />
        {type === "ITEM" && <AiRecognition images={images} disabled={busy || !!creatingTaxonomy} onBusyChange={setAiBusy} onApply={applyRecognition} />}
      </section>
      {!initial && type !== "WAREHOUSE" && (
        <section className="surface p-5">
          <h2 className="font-semibold">保存位置</h2>
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
      {!initial && type === "ITEM" && (
        <section className="surface p-5">
          <Field
            label="创建完成后"
          >
            <Select
              value={form.watch("nextCreateType")}
              onChange={(event) =>
                form.setValue(
                  "nextCreateType",
                  event.target.value as NodeFormData["nextCreateType"],
                  { shouldDirty: true },
                )
              }
            >
              <option value="NONE">仅创建物品</option>
              <option value="BAG">继续添加袋子</option>
              <option value="BOX">继续添加箱子</option>
              <option value="WAREHOUSE">继续添加仓库</option>
            </Select>
          </Field>
        </section>
      )}
      <Button type="submit" disabled={aiBusy} loading={busy} className="node-form-submit">
        {!initial && type === "ITEM" && form.watch("nextCreateType") !== "NONE"
          ? `创建物品并添加${typeLabel[form.watch("nextCreateType") as Exclude<NodeFormData["nextCreateType"], "NONE">]}`
          : submitLabel}
      </Button>
    </form>
  );
}

const typeLabel: Record<Exclude<NodeFormData["nextCreateType"], "NONE">, string> = {
  BAG: "袋子",
  BOX: "箱子",
  WAREHOUSE: "仓库",
};

function mergeTaxonomyOptions<T extends { id: string; name: string }>(
  ...groups: Array<readonly T[] | undefined>
): T[] {
  const merged = new Map<string, T>();
  for (const item of groups.flatMap((group) => group ?? [])) merged.set(item.id, item);
  return [...merged.values()];
}
