import { api } from "./api";
import type { InventoryNode } from "./types";

export const copyFields = [
  { value: "name", label: "名称" },
  { value: "categories", label: "分类" },
  { value: "specifications", label: "规格" },
  { value: "tags", label: "标签" },
  { value: "notes", label: "备注" },
  { value: "images", label: "图片" },
  { value: "location", label: "存放位置" },
] as const;
export type CopyField = typeof copyFields[number]["value"];
export type NodePrefill = Partial<Pick<InventoryNode, "name" | "categories" | "categoryId" | "category" | "specifications" | "specification" | "tags" | "notes" | "images">>;
const preferenceKey = "inventory-hub:copy-fields";

export function parseCopyFields(values: string[]): CopyField[] {
  return copyFields.map((field) => field.value).filter((field) => values.includes(field));
}

export function readCopyDefaults(): CopyField[] {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
    if (Array.isArray(value)) return parseCopyFields(value);
  } catch { /* Use the initial defaults if storage is unavailable or invalid. */ }
  return ["name", "categories"];
}

export function saveCopyDefaults(fields: CopyField[]) {
  localStorage.setItem(preferenceKey, JSON.stringify(fields));
}

export function copyPrefill(node: InventoryNode, fields: CopyField[]): NodePrefill {
  const selected = new Set(fields);
  return {
    ...(selected.has("name") ? { name: node.name } : {}),
    ...(selected.has("categories") ? { categories: node.categories, category: node.category, categoryId: node.categoryId } : {}),
    ...(selected.has("specifications") ? { specifications: node.specifications } : {}),
    ...(selected.has("tags") ? { tags: node.tags } : {}),
    ...(selected.has("notes") ? { notes: node.notes } : {}),
    ...(selected.has("images") ? { images: node.images } : {}),
  };
}

// Reuse the upload lifecycle so each copy owns separate files and image records.
export async function copyImageToUpload(imageId: string, clientUploadId: string): Promise<string> {
  const response = await api<Response>(`/images/${encodeURIComponent(imageId)}?variant=main`, { raw: true });
  const image = await response.blob();
  const upload = await api<{ uploadId: string; state: string }>("/uploads", {
    method: "POST", idempotent: true,
    body: { clientUploadId, filename: `copy-${imageId}.webp`, byteLength: image.size, declaredMime: "image/webp" },
  });
  let state = upload.state;
  if (["UPLOADING", "FAILED"].includes(state)) {
    state = (await api<{ state: string }>(`/uploads/${upload.uploadId}/content`, { method: "PUT", body: image })).state;
  }
  for (let attempt = 0; state === "PROCESSING" && attempt < 45; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    state = (await api<{ state: string }>(`/uploads/${upload.uploadId}`)).state;
  }
  if (!["READY", "FILES_READY", "ATTACHED"].includes(state)) throw new Error("复制图片未完成，请稍后重试");
  return upload.uploadId;
}
