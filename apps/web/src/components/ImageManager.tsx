import { useState, type Dispatch, type SetStateAction } from "react";
import { Upload, type UploadProps } from "antd";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Alert, Button } from "./AntUi";

type UploadStage = "converting" | "registering" | "uploading" | "processing";

export type EditableImage = {
  key: string;
  imageId?: string;
  uploadId?: string;
  preview: string;
  state: "existing" | "uploading" | "processing" | "ready" | "failed";
  stage?: UploadStage;
  error?: string;
  errorCode?: string;
  requestId?: string;
  file?: File;
};

const stageLabel: Record<UploadStage, string> = {
  converting: "正在转换手机照片",
  registering: "正在创建上传任务",
  uploading: "正在上传原图",
  processing: "正在压缩并生成缩略图",
};
const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const inferredMimeTypes: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function ImageManager({
  value: items,
  onChange,
  required = false,
  disabled = false,
}: {
  value: EditableImage[];
  onChange: Dispatch<SetStateAction<EditableImage[]>>;
  required?: boolean;
  disabled?: boolean;
}) {
  const [selectionError, setSelectionError] = useState("");
  const activeItems = items.filter(
    (item) => item.state === "uploading" || item.state === "processing",
  );
  const failedItems = items.filter((item) => item.state === "failed");
  const completedItems = items.filter(
    (item) => item.state === "existing" || item.state === "ready",
  );

  function updateImage(key: string, patch: Partial<EditableImage>) {
    onChange((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  async function processFile(sourceFile: File) {
    const key = crypto.randomUUID();
    let preview = URL.createObjectURL(sourceFile);
    let currentStage: UploadStage = isHeic(sourceFile) ? "converting" : "registering";
    onChange((current) => [
      ...current,
      {
        key,
        preview,
        state: "uploading",
        stage: currentStage,
        file: sourceFile,
      },
    ]);
    try {
      const file = await normalizeImageFile(sourceFile);
      if (file !== sourceFile) {
        const convertedPreview = URL.createObjectURL(file);
        updateImage(key, { preview: convertedPreview });
        URL.revokeObjectURL(preview);
        preview = convertedPreview;
      }
      currentStage = "registering";
      updateImage(key, { stage: currentStage });
      const created = await api<{ id?: string; uploadId?: string }>("/uploads", {
        method: "POST",
        body: {
          clientUploadId: key,
          filename: file.name,
          byteLength: file.size,
          declaredMime: file.type,
        },
        idempotent: true,
      });
      const uploadId = created.uploadId || created.id;
      if (!uploadId) throw new Error("服务没有返回 uploadId");

      currentStage = "uploading";
      updateImage(key, { uploadId, stage: currentStage, state: "uploading" });
      const accepted = await api<{ state: string }>(`/uploads/${uploadId}/content`, {
        method: "PUT",
        body: file,
      });
      if (accepted.state === "READY") {
        updateImage(key, { uploadId, state: "ready", stage: undefined });
        return;
      }

      currentStage = "processing";
      updateImage(key, { uploadId, stage: currentStage, state: "processing" });
      let result: { state: string; imageId?: string; errorCode?: string | null } = {
        state: accepted.state || "PROCESSING",
      };
      for (
        let attempt = 0;
        attempt < 45 && !["READY", "FAILED", "CANCELLED"].includes(result.state);
        attempt += 1
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        result = await api(`/uploads/${uploadId}`);
      }
      if (result.state !== "READY") {
        if (result.state === "FAILED")
          throw new Error(
            `图片处理失败${result.errorCode ? `（${result.errorCode}）` : ""}`,
          );
        if (result.state === "CANCELLED") throw new Error("上传任务已取消");
        throw new Error("图片处理超时，请稍后重试");
      }
      updateImage(key, { uploadId, state: "ready", stage: undefined });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      updateImage(key, {
        state: "failed",
        stage: currentStage,
        error: `${stageLabel[currentStage]}失败：${errorMessage(error)}`,
        errorCode: apiError?.code,
        requestId: apiError?.requestId,
      });
    }
  }

  const beforeUpload: UploadProps["beforeUpload"] = (file, files) => {
    setSelectionError("");
    if (items.length + files.length > 5) {
      setSelectionError("每个档案最多保存 5 张图片");
      return Upload.LIST_IGNORE;
    }
    if (file.size > 25 * 1024 * 1024) {
      setSelectionError(`${file.name} 超过 25 MiB，未开始上传`);
      return Upload.LIST_IGNORE;
    }
    if (!isSupportedOrConvertibleImage(file)) {
      setSelectionError(
        `${file.name} 的格式为 ${file.type || "未知格式"}，仅支持 JPEG、PNG、WebP、HEIC 和 HEIF`,
      );
      return Upload.LIST_IGNORE;
    }
    void processFile(file);
    return Upload.LIST_IGNORE;
  };

  function remove(index: number) {
    const item = items[index];
    if (item.uploadId && item.state !== "existing")
      void api(`/uploads/${item.uploadId}`, { method: "DELETE" }).catch(() => undefined);
    if (item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    onChange((current) => current.filter((entry) => entry.key !== item.key));
  }

  function move(index: number, direction: -1 | 1) {
    onChange((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function retry(index: number) {
    const file = items[index].file;
    if (!file) return;
    remove(index);
    void processFile(file);
  }

  return (
    <div>
      {activeItems.length > 0 && (
        <div
          className="mb-3 rounded-md border border-primary/30 bg-accent p-3"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {activeItems.length} 张图片正在上传或处理
              </p>
              {activeItems.map((item) => (
                <p key={item.key} className="mt-1 truncate text-xs text-muted-foreground">
                  {item.file?.name || "手机照片"}：
                  {item.stage ? stageLabel[item.stage] : "正在处理"}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {items.map((item, index) => (
            <div
              key={item.key}
              className={cn(
                "group relative aspect-square overflow-hidden rounded-md border bg-muted",
                item.state === "failed" && "border-destructive",
              )}
            >
              <img
                src={item.preview}
                alt={`图片 ${index + 1}${index === 0 ? "，封面" : ""}`}
                className="size-full object-cover"
              />
              {(item.state === "uploading" || item.state === "processing") && (
                <div className="absolute inset-0 grid place-items-center bg-slate-950/60 p-3 text-white">
                  <div className="text-center">
                    <LoaderCircle className="mx-auto size-6 animate-spin" />
                    <p className="mt-2 text-xs">
                      {item.stage ? stageLabel[item.stage] : "正在处理"}
                    </p>
                  </div>
                </div>
              )}
              {item.state === "failed" && (
                <div className="absolute inset-x-0 bottom-0 bg-red-950/90 p-2 text-xs text-white">
                  <p className="font-medium">上传失败</p>
                  {item.file && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1 text-white underline"
                      onClick={() => retry(index)}
                    >
                      <RotateCcw className="size-3" />
                      重试
                    </Button>
                  )}
                </div>
              )}
              {item.state === "ready" && (
                <span className="absolute bottom-2 right-2 rounded bg-emerald-700/90 px-2 py-1 text-xs text-white">
                  上传完成
                </span>
              )}
              <div className="absolute inset-x-0 top-0 flex justify-between bg-gradient-to-b from-slate-950/65 to-transparent p-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <div className="flex">
                  <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => move(index, -1)} className="image-action" aria-label="前移"><ChevronLeft className="size-4" /></Button>
                  <Button variant="ghost" size="icon" disabled={index === items.length - 1} onClick={() => move(index, 1)} className="image-action" aria-label="后移"><ChevronRight className="size-4" /></Button>
                </div>
                <Button variant="ghost" size="icon" onClick={() => remove(index)} className="image-action image-action--danger" aria-label="删除图片"><Trash2 className="size-4" /></Button>
              </div>
              {index === 0 && <span className="absolute bottom-2 left-2 rounded bg-slate-950/75 px-2 py-1 text-xs text-white">封面</span>}
            </div>
          ))}
        </div>
      )}

      {items.length < 5 && (
        <div className={cn("grid grid-cols-2 gap-3", items.length > 0 && "mt-3")}>
          <Upload accept="image/*,.heic,.heif" capture="environment" disabled={disabled} showUploadList={false} beforeUpload={beforeUpload} className="app-image-picker">
            <Button type="button" variant="outline" className="w-full" disabled={disabled}><Camera className="size-4" />拍照</Button>
          </Upload>
          <Upload accept="image/*,.heic,.heif" multiple disabled={disabled} showUploadList={false} beforeUpload={beforeUpload} className="app-image-picker">
            <Button type="button" variant="outline" className="w-full" disabled={disabled}><ImagePlus className="size-4" />从相册选择</Button>
          </Upload>
        </div>
      )}

      {selectionError && <Alert title="图片未开始上传" tone="error" className="mt-3">{selectionError}</Alert>}
      {failedItems.length > 0 && (
        <Alert title={`图片上传失败（${failedItems.length}）`} tone="error" className="mt-3">
          <ul className="space-y-2">
            {failedItems.map((item) => (
              <li key={item.key}>
                <p>{item.file?.name || "手机照片"}：{item.error || "未知错误"}</p>
                {(item.errorCode || item.requestId) && (
                  <p className="mt-1 font-mono text-xs opacity-80">
                    {item.errorCode ? `错误代码 ${item.errorCode}` : ""}
                    {item.errorCode && item.requestId ? " · " : ""}
                    {item.requestId ? `请求 ${item.requestId}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Camera className="mt-0.5 size-4 shrink-0" />
        <span>
          {required ? "物品至少需要一张图片。" : "图片可选。"}
          已完成 {completedItems.length} 张
          {activeItems.length > 0 ? `，处理中 ${activeItems.length} 张` : ""}
          {failedItems.length > 0 ? `，失败 ${failedItems.length} 张` : ""}
          ，最多 5 张；支持 JPEG、PNG、WebP、HEIC、HEIF。
        </span>
      </div>
    </div>
  );
}

function fileExtension(file: File) {
  const match = /\.[^.]+$/.exec(file.name.toLowerCase());
  return match?.[0] || "";
}

function isHeic(file: File) {
  return file.type === "image/heic" || file.type === "image/heif" || [".heic", ".heif"].includes(fileExtension(file));
}

function isSupportedOrConvertibleImage(file: File) {
  return supportedMimeTypes.has(file.type) || isHeic(file) || Boolean(inferredMimeTypes[fileExtension(file)]);
}

async function normalizeImageFile(file: File): Promise<File> {
  if (isHeic(file)) return convertHeicToJpeg(file);
  if (supportedMimeTypes.has(file.type)) return file;
  const inferredMime = inferredMimeTypes[fileExtension(file)];
  if (inferredMime) return new File([file], file.name, { type: inferredMime, lastModified: file.lastModified });
  throw new Error(`不支持 ${file.type || "未知"} 图片格式`);
}

async function convertHeicToJpeg(file: File): Promise<File> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("当前浏览器无法读取 HEIC/HEIF 照片"));
      element.src = sourceUrl;
    });
    const maxDimension = 4096;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图片转换画布");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("HEIC/HEIF 转换 JPEG 失败")), "image/jpeg", 0.88),
    );
    if (jpeg.size > 25 * 1024 * 1024) throw new Error("照片转换为 JPEG 后超过 25 MiB，请降低拍摄分辨率后重试");
    const jpegName = file.name.replace(/\.(heic|heif)$/i, "") || "手机照片";
    return new File([jpeg], `${jpegName}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "HEIC/HEIF 转换失败";
    throw new Error(`${reason}。可在 iPhone“设置 → 相机 → 格式”中选择“兼容性最佳”后重新拍照`);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
