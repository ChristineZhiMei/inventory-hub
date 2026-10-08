import { useEffect, useRef, useState } from "react";
import { Checkbox } from "antd";
import { Sparkles, Undo2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AI_FIELDS, AI_FIELD_LABELS, type AiField, type AiRecognitionResult, type AiSettings } from "@inventory-hub/contracts";
import { api, errorMessage } from "@/lib/api";
import { aiClientId, readAiDefaults } from "@/lib/ai";
import { Alert, Button, Dialog } from "./AntUi";
import type { EditableImage } from "./ImageManager";

export function AiRecognition({ images, disabled, onBusyChange, onApply }: {
  images: EditableImage[];
  disabled: boolean | undefined;
  onBusyChange: (busy: boolean) => void;
  onApply: (result: AiRecognitionResult) => () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<AiField[]>(readAiDefaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const undo = useRef<(() => void) | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: () => api<AiSettings>("/settings/ai"), enabled: open });
  useEffect(() => () => { activeRequest.current?.abort(); activeRequest.current = null; }, []);
  const imageProblem = !images.length ? "请先添加至少一张物品图片" : images.some((image) => image.state === "failed") ? "请重试或移除上传失败的图片" : images.some((image) => image.state !== "existing" && image.state !== "ready") ? "请等待图片上传和处理完成" : "";

  function close() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setBusy(false);
    onBusyChange(false);
    setOpen(false);
  }

  async function recognize() {
    if (busy || disabled || imageProblem || !fields.length || !settings.data?.configured) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const entries = images.map((image) => {
        if (image.imageId || image.sourceImageId) return { imageId: image.imageId || image.sourceImageId! };
        if (image.uploadId) return { uploadId: image.uploadId };
        throw new Error("图片尚未就绪，请重新添加图片");
      });
      const result = await api<AiRecognitionResult>("/ai/recognize", { method: "POST", body: { fields, images: entries, clientId: aiClientId }, signal: controller.signal });
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      const count = Object.keys(result.values).length;
      if (count) undo.current = onApply(result);
      setNotice([count ? `已填充 ${count} 项，请检查后保存。` : "没有可填充的识别结果，原内容已保留。", ...result.warnings].join(" "));
      setOpen(false);
    } catch (reason) {
      if (activeRequest.current === controller && !controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return <div className="mt-5 space-y-3">
    <div className="flex flex-wrap gap-3">
      <Button variant="outline" disabled={disabled || busy} onClick={() => { setFields(readAiDefaults()); setError(""); setOpen(true); void settings.refetch(); }}><Sparkles className="size-4" />AI识别</Button>
      {undo.current && <Button variant="ghost" disabled={disabled || busy} onClick={() => { undo.current?.(); undo.current = null; setNotice("已撤销本次填充，恢复填充前的内容。"); }}><Undo2 className="size-4" />撤销本次填充</Button>}
    </div>
    {notice && <Alert title="AI 识别结果" tone="info">{notice}</Alert>}
    <Dialog open={open} onClose={close} title="AI识别" description="根据当前物品的全部图片识别，结果将覆盖勾选字段的现有内容。未勾选字段保持不变。" footer={<>
      <Button variant="outline" onClick={close}>{busy ? "取消识别" : "取消"}</Button>
      <Button loading={busy} disabled={disabled || !!imageProblem || !fields.length || !settings.data?.configured || settings.isFetching || settings.isError} onClick={() => void recognize()}>确认识别</Button>
    </>}>
      <div className="space-y-4">
        <Checkbox.Group value={fields} disabled={busy} className="grid grid-cols-2 gap-4" onChange={(values) => setFields(values as AiField[])}>
          {AI_FIELDS.map((field) => <Checkbox key={field} value={field}>{AI_FIELD_LABELS[field]}</Checkbox>)}
        </Checkbox.Group>
        <p className="text-sm text-muted-foreground">将向智谱发送 {images.length} 张图片，以及分类、规格、标签选项和说明。无法判断的字段保留原值；确定没有匹配的规格、标签会清空原选择。</p>
        {!fields.length && <p role="status" className="text-sm text-muted-foreground">请至少选择一个识别字段</p>}
        {imageProblem && <Alert title={imageProblem} tone="warning" />}
        {settings.isFetching && <p>正在检查 AI 配置…</p>}
        {settings.data && !settings.data.configured && <Alert title="尚未配置 API Key" tone="warning"><Link to="/settings/ai" onClick={close} className="underline">前往设置 → AI 识别</Link></Alert>}
        {settings.error && <Alert title="无法读取 AI 配置" tone="error">{errorMessage(settings.error)}<Button variant="ghost" onClick={() => void settings.refetch()}>重试</Button></Alert>}
        {busy && <p role="status" className="text-sm text-muted-foreground">正在识别，请稍候。取消后不会填写结果。</p>}
        {error && <Alert title="识别失败，原内容已保留" tone="error">{error}</Alert>}
      </div>
    </Dialog>
  </div>;
}
