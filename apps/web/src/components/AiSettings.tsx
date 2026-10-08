import { useState } from "react";
import { Checkbox } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_FIELDS, AI_FIELD_LABELS, AI_NAME_PROMPT_LIMIT, type AiConnectionTestResult, type AiField, type AiSettings as Settings } from "@inventory-hub/contracts";
import { api, errorMessage } from "@/lib/api";
import { readAiDefaults, saveAiDefaults } from "@/lib/ai";
import { QueryError } from "./Page";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Textarea } from "./AntUi";

export function AiSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: () => api<Settings>("/settings/ai") });
  const [defaults, setDefaults] = useState<AiField[]>(readAiDefaults);
  const [saved, setSaved] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  return <div className="space-y-6">
    {settings.isError ? <QueryError error={settings.error} onRetry={() => settings.refetch()} /> : settings.data ?
      <ModelSettings key={settings.data.version} initial={settings.data} onSaved={(value) => { queryClient.setQueryData(["ai-settings"], value); setSaved(true); }} /> : <p>正在加载 AI 设置…</p>}
    {saved && <Alert title="AI 配置已保存" tone="success" />}
    <Card><CardHeader><CardTitle>默认识别字段</CardTitle></CardHeader><CardContent>
      <p className="mb-5 text-sm text-muted-foreground">每次打开识别弹窗时默认勾选以下字段，仍可在弹窗中调整。仅影响当前设备。</p>
      <Checkbox.Group value={defaults} className="grid grid-cols-2 gap-4" onChange={(values) => {
        try { saveAiDefaults(values as AiField[]); setDefaults(values as AiField[]); setPreferenceError(""); }
        catch { setPreferenceError("当前浏览器无法保存默认选项，请检查存储设置"); }
      }}>{AI_FIELDS.map((field) => <Checkbox key={field} value={field}>{AI_FIELD_LABELS[field]}</Checkbox>)}</Checkbox.Group>
      {preferenceError && <Alert title="保存失败" tone="error" className="mt-4">{preferenceError}</Alert>}
      {settings.data && <NamePromptSettings key={settings.data.version} initial={settings.data} onSaved={(value) => queryClient.setQueryData(["ai-settings"], value)} />}
    </CardContent></Card>
  </div>;
}

function NamePromptSettings({ initial, onSaved }: { initial: Settings; onSaved: (value: Settings) => void }) {
  const [namePrompt, setNamePrompt] = useState(initial.namePrompt);
  const save = useMutation({
    mutationFn: () => api<Settings>("/settings/ai", {
      method: "PUT", sensitive: true,
      body: { model: initial.model, namePrompt: namePrompt.trim(), expectedVersion: initial.version },
    }),
    onSuccess: onSaved,
  });
  const changed = namePrompt.trim() !== initial.namePrompt;
  return <div className="mt-6 space-y-3 border-t border-border pt-5">
    <Field label="物品名称补充提示词" hint={`可留空，最多 ${AI_NAME_PROMPT_LIMIT} 字。仅在本次识别勾选“物品名称”时生效，连接此服务的设备共用。`}>
      <Textarea aria-label="物品名称补充提示词" value={namePrompt} rows={3} maxLength={AI_NAME_PROMPT_LIMIT} disabled={save.isPending} onChange={(event) => { setNamePrompt(event.target.value); save.reset(); }} placeholder="例如：名称采用“颜色 + 材质 + 物品类型”，无法确认的部分省略，不包含规格和品牌。" />
    </Field>
    <p className="text-right text-xs text-muted-foreground">{namePrompt.length}/{AI_NAME_PROMPT_LIMIT} 字</p>
    <div className="flex flex-wrap items-center gap-3">
      <Button loading={save.isPending} disabled={!changed} onClick={() => save.mutate()}>保存名称提示词</Button>
      {!changed && <span className="text-sm text-muted-foreground">{initial.namePrompt ? "当前提示词已保存" : "当前使用默认命名规则"}</span>}
    </div>
    {save.error && <Alert title="名称提示词保存失败" tone="error">{errorMessage(save.error)}</Alert>}
  </div>;
}

function ModelSettings({ initial, onSaved }: { initial: Settings; onSaved: (value: Settings) => void }) {
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const connectionTest = useMutation({
    mutationFn: () => api<AiConnectionTestResult>("/settings/ai/test", {
      method: "POST", sensitive: true,
      body: { model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), expectedVersion: initial.version },
    }),
  });
  const save = useMutation({
    mutationFn: () => api<Settings>("/settings/ai", {
      method: "PUT", sensitive: true,
      body: { model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), clearApiKey, expectedVersion: initial.version },
    }),
    onSuccess: (value) => { setApiKey(""); onSaved(value); },
  });
  const busy = save.isPending || connectionTest.isPending;
  return <Card><CardHeader><CardTitle>AI 识别 · 智谱 BigModel</CardTitle></CardHeader><CardContent>
    <div className="space-y-5">
      <div className="flex items-center gap-3"><Badge variant={initial.configured ? "success" : "secondary"}>{initial.configured ? "API Key 已配置" : "尚未配置 API Key"}</Badge><span className="text-sm text-muted-foreground">配置保存在当前服务，连接此服务的设备共用。</span></div>
      <Field label="模型名称" required><Input aria-label="模型名称" value={model} maxLength={120} onChange={(event) => { setModel(event.target.value); connectionTest.reset(); }} placeholder="glm-4.6v-flash" disabled={busy} /></Field>
      {model.trim().toLowerCase() === "glm-4v-flash" && <Alert title="当前模型不支持本地图片上传" tone="warning">glm-4v-flash 仅支持公网图片链接。本功能通过 Base64 发送本地图片，请使用 glm-4.6v-flash 等支持 Base64 的视觉模型。</Alert>}
      <Field label="API Key"><Input aria-label="API Key" type="password" autoComplete="new-password" value={apiKey} maxLength={2048} disabled={busy || clearApiKey} onChange={(event) => { setApiKey(event.target.value); connectionTest.reset(); }} placeholder={initial.configured ? "留空保留已保存的 Key，输入新 Key 可替换" : "输入智谱 API Key"} /></Field>
      {initial.configured && <Checkbox checked={clearApiKey} disabled={busy} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); connectionTest.reset(); }}>删除已保存的 API Key</Checkbox>}
      <p className="break-all text-xs text-muted-foreground">接口：{initial.endpoint}</p>
      <p className="text-sm text-muted-foreground">点击识别后，会将当前物品图片及分类、规格、标签选项和说明发送给智谱。识别结果仅填入表单，检查后再保存物品。</p>
      <div className="flex flex-wrap gap-3">
        <Button loading={save.isPending} disabled={!model.trim() || connectionTest.isPending} onClick={() => { connectionTest.reset(); save.mutate(); }}>保存 AI 配置</Button>
        <Button variant="outline" loading={connectionTest.isPending} disabled={save.isPending || !model.trim() || clearApiKey || (!apiKey.trim() && !initial.configured)} onClick={() => connectionTest.mutate()}>测试连接</Button>
      </div>
      <p className="text-xs text-muted-foreground">测试使用当前模型和输入的 Key；Key 留空时使用已保存的 Key。会发送一张系统生成的测试图片并调用一次模型，测试不会保存配置。</p>
      {connectionTest.isPending && <p role="status" className="text-sm text-muted-foreground">正在测试图片接口，请稍候（最多等待 30 秒）…</p>}
      {connectionTest.data && <Alert title="连接测试成功" tone="success">{connectionTest.data.model} 已成功响应图片测试请求，耗时 {(connectionTest.data.elapsedMs / 1000).toFixed(1)} 秒。{(apiKey.trim() || model.trim() !== initial.model) && " 当前配置尚未保存，请点击保存 AI 配置。"}</Alert>}
      {connectionTest.error && <Alert title="连接测试失败" tone="error">{errorMessage(connectionTest.error)}</Alert>}
      {save.error && <Alert title="AI 配置保存失败" tone="error">{errorMessage(save.error)}</Alert>}
    </div>
  </CardContent></Card>;
}
