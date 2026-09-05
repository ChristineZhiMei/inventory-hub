import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Select as AntSelect, Spin } from "antd";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { api, ApiError } from "@/lib/api";
import { useMediaQuery } from "@/lib/media";
import { pageItems, queries } from "@/lib/queries";
import { useBodyScrollLock } from "@/lib/scrollLock";
import type { InventoryNode, NodeType, Specification, Tag } from "@/lib/types";
import { Button, Field, Input, Label, Select, Textarea } from "./AntUi";
import { ImageManager, type EditableImage } from "./ImageManager";

const SYSTEM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const schema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(120, "名称最多 120 个字符"),
  categoryIds: z.array(z.string()).max(3, "每个档案最多选择三个分类"),
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
  submitLabel = "保存档案",
  onSubmit,
  busy,
}: {
  type: NodeType;
  initial?: InventoryNode;
  prefill?: Pick<
    InventoryNode,
    | "name"
    | "categories"
    | "categoryId"
    | "category"
    | "specifications"
    | "specification"
    | "tags"
  >;
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
  const [retainedTags, setRetainedTags] = useState<Tag[]>([]);
  const [retainedSpecifications, setRetainedSpecifications] = useState<Specification[]>([]);
  const [specificationSearchInput, setSpecificationSearchInput] = useState("");
  const [specificationSearch, setSpecificationSearch] = useState("");
  const [creatingTaxonomy, setCreatingTaxonomy] = useState<"tag" | "specification" | null>(null);
  const [taxonomyPopupOpen, setTaxonomyPopupOpen] = useState(false);
  const mobile = useMediaQuery("(max-width: 767px)");
  useBodyScrollLock(mobile && taxonomyPopupOpen);
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: queries.categories,
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
      notes: initial?.notes || "",
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
    () => mergeTaxonomyOptions(initial?.categories, prefill?.categories, pageItems(categories.data)),
    [categories.data, initial?.categories, prefill?.categories],
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

  async function submit(values: NodeFormData) {
    form.clearErrors();
    if (type === "ITEM" && values.categoryIds.length === 0) {
      form.setError("categoryIds", { message: "物品必须至少选择一个分类" });
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
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  {...field}
                  id="name"
                  value={field.value}
                  aria-invalid={!!form.formState.errors.name}
                  autoFocus
                  placeholder={
                    type === "ITEM" ? "例如：灰色羊毛大衣" : `例如：${typeName}名称`
                  }
                />
              )}
            />
          </Field>
          <Field
            label="分类"
            error={form.formState.errors.categoryIds?.message}
            hint="最多选择三个分类"
            required={type === "ITEM"}
          >
            <AntSelect
              mode="multiple"
              value={form.watch("categoryIds")}
              options={categoryOptions.map((category) => ({
                value: category.id,
                label: category.name,
              }))}
              placeholder="选择分类"
              size="large"
              className="w-full"
              optionFilterProp="label"
              maxCount={3}
              maxTagCount="responsive"
              virtual={!mobile}
              onOpenChange={setTaxonomyPopupOpen}
              onChange={(values) =>
                form.setValue("categoryIds", values, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
              allowClear
            />
          </Field>
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
                virtual={!mobile}
                onOpenChange={setTaxonomyPopupOpen}
                loading={specifications.isLoading || creatingTaxonomy === "specification"}
                notFoundContent={
                  specifications.isFetching ? <Spin size="small" /> : "输入后按回车创建"
                }
                maxTagCount="responsive"
                tokenSeparators={[",", "，", "/", "／"]}
                allowClear
              />
          </Field>
          <Field
            label="标签"
            error={form.formState.errors.tagIds?.message}
            hint="输入新标签后按回车即可创建并添加"
            className="md:col-span-2"
          >
            <AntSelect
              mode="tags"
              value={selectedTags}
              options={tagOptions.map((item) => ({ value: item.id, label: item.name }))}
              placeholder="选择或创建标签"
              size="large"
              className="w-full"
              optionFilterProp="label"
              virtual={!mobile}
              onOpenChange={setTaxonomyPopupOpen}
              onChange={(values) => void updateCreatableSelection("tag", values)}
              loading={tags.isLoading || creatingTaxonomy === "tag"}
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
      {!initial && type === "ITEM" && (
        <section className="surface p-5">
          <Field
            label="创建完成后"
            hint="可继续创建同信息的收纳位置，并自动把刚创建的物品移入其中"
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
      <div className="safe-bottom sticky bottom-20 z-10 flex justify-end gap-3 border-t bg-background/95 py-4 backdrop-blur lg:bottom-0">
        <Button type="submit" loading={busy}>
          {!initial && type === "ITEM" && form.watch("nextCreateType") !== "NONE"
            ? `创建物品并添加${typeLabel[form.watch("nextCreateType") as Exclude<NodeFormData["nextCreateType"], "NONE">]}`
            : submitLabel}
        </Button>
      </div>
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
