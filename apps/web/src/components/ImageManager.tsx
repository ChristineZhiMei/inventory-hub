import { useState, type Dispatch, type SetStateAction } from "react";
import { Upload, type UploadProps } from "antd";
import { Camera, ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Alert, Button } from "./AntUi";

export type EditableImage = { key: string; imageId?: string; uploadId?: string; preview: string; state: "existing" | "uploading" | "processing" | "ready" | "failed"; error?: string; file?: File };

export function ImageManager({ value: items, onChange, required = false, disabled = false }: { value: EditableImage[]; onChange: Dispatch<SetStateAction<EditableImage[]>>; required?: boolean; disabled?: boolean }) {
  const [selectionError, setSelectionError] = useState("");

  async function processFile(file: File) {
    const key = crypto.randomUUID();
    const preview = URL.createObjectURL(file);
    const pending: EditableImage = { key, preview, state: "uploading", file };
    onChange((current) => [...current, pending]);
    try {
      const created = await api<{ id?: string; uploadId?: string }>("/uploads", { method: "POST", body: { clientUploadId: key, filename: file.name, byteLength: file.size, declaredMime: file.type }, idempotent: true });
      const uploadId = created.uploadId || created.id;
      if (!uploadId) throw new Error("服务没有返回 uploadId");
      onChange((current) => current.map((item) => item.key === key ? { ...item, uploadId, state: "processing" } : item));
      await api(`/uploads/${uploadId}/content`, { method: "PUT", body: file });
      let result: { state: string; imageId?: string } = { state: "PROCESSING" };
      for (let attempt = 0; attempt < 45 && !["READY", "FAILED", "CANCELLED"].includes(result.state); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        result = await api(`/uploads/${uploadId}`);
      }
      if (result.state !== "READY") throw new Error(result.state === "FAILED" ? "图片处理失败，请重新选择" : "图片处理超时，可稍后重试");
      onChange((current) => current.map((item) => item.key === key ? { ...item, uploadId, state: "ready" } : item));
    } catch (error) {
      onChange((current) => current.map((item) => item.key === key ? { ...item, state: "failed", error: errorMessage(error) } : item));
    }
  }

  const beforeUpload: UploadProps["beforeUpload"] = (file, files) => {
    setSelectionError("");
    if (items.length + files.length > 5) { setSelectionError("每个档案最多保存 5 张图片"); return Upload.LIST_IGNORE; }
    if (file.size > 25 * 1024 * 1024) { setSelectionError(`${file.name} 超过 25 MiB`); return Upload.LIST_IGNORE; }
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) { setSelectionError(`${file.name} 的格式暂不支持，仅支持 JPEG、PNG、WebP`); return Upload.LIST_IGNORE; }
    void processFile(file);
    return Upload.LIST_IGNORE;
  };
  async function remove(index: number) {
    const item = items[index];
    if (item.uploadId && item.state !== "existing") void api(`/uploads/${item.uploadId}`, { method: "DELETE" }).catch(() => undefined);
    onChange((current) => current.filter((entry) => entry.key !== item.key));
  }
  function move(index: number, direction: -1 | 1) { onChange((current) => { const next = [...current]; const target = index + direction; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; }); }
  function retry(index: number) { const item = items[index]; if (!item.file) return; onChange((current) => current.filter((entry) => entry.key !== item.key)); void processFile(item.file); }
  return <div>
    {items.length > 0 && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{items.map((item, index) => <div key={item.key} className={cn("group relative aspect-square overflow-hidden rounded-md border bg-muted", item.state === "failed" && "border-destructive")}>
      <img src={item.preview} alt={`图片 ${index + 1}${index === 0 ? "，封面" : ""}`} className="size-full object-cover" />
      {item.state === "uploading" || item.state === "processing" ? <div className="absolute inset-0 grid place-items-center bg-slate-950/55 text-white"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin" /><p className="mt-2 text-xs">{item.state === "uploading" ? "上传中" : "处理中"}</p></div></div> : null}
      {item.state === "failed" && <div className="absolute inset-x-0 bottom-0 bg-red-950/85 p-2 text-xs text-white"><p className="line-clamp-2">{item.error}</p>{item.file && <Button variant="ghost" size="sm" className="mt-1 text-white underline" onClick={() => retry(index)}><RotateCcw className="size-3" />重试</Button>}</div>}
      <div className="absolute inset-x-0 top-0 flex justify-between bg-gradient-to-b from-slate-950/65 to-transparent p-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"><div className="flex"><Button variant="ghost" size="icon" disabled={index === 0} onClick={() => move(index, -1)} className="image-action" aria-label="前移"><ChevronLeft className="size-4" /></Button><Button variant="ghost" size="icon" disabled={index === items.length - 1} onClick={() => move(index, 1)} className="image-action" aria-label="后移"><ChevronRight className="size-4" /></Button></div><Button variant="ghost" size="icon" onClick={() => remove(index)} className="image-action image-action--danger" aria-label="删除图片"><Trash2 className="size-4" /></Button></div>
      {index === 0 && <span className="absolute bottom-2 left-2 rounded bg-slate-950/75 px-2 py-1 text-xs text-white">封面</span>}
    </div>)}</div>}
    {items.length < 5 && <div className={cn("grid grid-cols-2 gap-3", items.length > 0 && "mt-3")}>
      <Upload accept="image/*" capture="environment" disabled={disabled} showUploadList={false} beforeUpload={beforeUpload} className="app-image-picker">
        <Button type="button" variant="outline" className="w-full" disabled={disabled}><Camera className="size-4" />拍照</Button>
      </Upload>
      <Upload accept="image/jpeg,image/png,image/webp" multiple disabled={disabled} showUploadList={false} beforeUpload={beforeUpload} className="app-image-picker">
        <Button type="button" variant="outline" className="w-full" disabled={disabled}><ImagePlus className="size-4" />从相册选择</Button>
      </Upload>
    </div>}
    {selectionError && <Alert title="无法添加图片" tone="error" className="mt-3">{selectionError}</Alert>}
    <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground"><Camera className="mt-0.5 size-4 shrink-0" /><span>{required ? "物品至少需要一张图片。" : "图片可选。"}已添加 {items.length}/5 张；支持 JPEG、PNG、WebP，上传后将压缩并生成缩略图。</span></div>
  </div>;
}
