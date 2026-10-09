import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Segmented, Tabs, Tooltip } from "antd";
import { ArrowLeft, Check, Image, List, LockKeyhole, Pencil, Plus, Shuffle, Trash2, UnlockKeyhole } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import type { MatchingSlotConfig } from "@inventory-hub/contracts";
import { Alert, Button, Dialog, EmptyState, Field, Input, Textarea } from "@/components/AntUi";
import { PageHeader, QueryError } from "@/components/Page";
import { StatusBadge, TypeIcon, nodeLocationLabel } from "@/components/NodeCard";
import { TaxonomySelect } from "@/components/TaxonomySelect";
import { api, errorMessage, imageUrl } from "@/lib/api";
import { queries, pageItems } from "@/lib/queries";
import { buildCategoryTreeRows } from "@/lib/categoryTree";
import { matchingSpecifications, newMatchingSlot, useMatchingGroup, type MatchingGroup, type MatchingGroupSummary, type MatchingSlot } from "@/lib/matching";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const typeTabs: Array<{ key: MatchingSlotConfig["type"]; label: string }> = [{ key: "ITEM", label: "物品" }, { key: "BAG", label: "袋子" }, { key: "BOX", label: "箱子" }, { key: "WAREHOUSE", label: "柜子" }];
const modeTabs: Array<{ key: MatchingSlotConfig["mode"]; label: string }> = [{ key: "CONTAINS", label: "包含" }, { key: "EXACT", label: "符合" }, { key: "ANY", label: "存在" }];
const displayOptions: Array<{ value: MatchingSlotConfig["display"]; label: string }> = [{ value: "LARGE", label: "大图 + 简洁详情" }, { value: "DETAIL", label: "小图 + 详情" }];
const modeHelp = {
  CONTAINS: "档案必须包含全部已选分类、标签和规格，允许有其他选项。",
  EXACT: "已选择的每个维度必须与档案选项完全一致，不能多选或少选。",
  ANY: "档案的分类、标签或规格命中任意一个已选选项即可。",
};

export function MatchingPage() {
  const client = useQueryClient();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const groupsQuery = useQuery({ queryKey: ["matching-groups"], queryFn: () => api<MatchingGroupSummary[]>("/matching-groups") });
  const groups = groupsQuery.data ?? [];
  const requested = params.get("group");
  const selected = groups.find((group) => group.id === requested)?.id ?? groups[0]?.id;
  const groupQuery = useQuery({ queryKey: ["matching-group", selected], queryFn: () => api<MatchingGroup>(`/matching-groups/${selected}`), enabled: Boolean(selected) });
  const select = (id: string) => setParams({ group: id }, { replace: true });
  const saved = (group: MatchingGroup) => {
    client.setQueryData(["matching-group", group.id], group);
    client.setQueryData<MatchingGroupSummary[]>(["matching-groups"], (current = []) => current.map((item) => item.id === group.id ? { ...item, name: group.name, version: group.version, slotCount: group.slots.length } : item));
  };

  const create = async () => {
    setCreating(true);
    try {
      const slot = newMatchingSlot();
      const { id, name, notes, type, mode, categoryIds, tagIds, specificationIds, display, locked } = slot;
      const group = await api<MatchingGroup>("/matching-groups", {
        method: "POST", idempotent: true,
        body: { name: `搭配分组 ${groups.length + 1}`, notes: "", slots: [{ id, name, notes, type, mode, categoryIds, tagIds, specificationIds, display, locked }] },
      });
      client.setQueryData(["matching-group", group.id], group);
      await groupsQuery.refetch();
      select(group.id);
    } catch (error) { toast("创建分组失败", { description: errorMessage(error), tone: "error" }); }
    finally { setCreating(false); }
  };

  if (groupsQuery.error) return <QueryError error={groupsQuery.error} onRetry={() => void groupsQuery.refetch()} />;
  if (groupsQuery.isPending) return <p className="py-20 text-center text-muted-foreground">正在加载搭配分组…</p>;
  if (!selected) return <>
    <PageHeader title="搭配" actions={<Button onClick={() => void create()} loading={creating}><Plus className="size-4" />创建分组</Button>} />
    <div className="surface p-8"><EmptyState icon={Shuffle} title="开始你的第一组搭配" description="添加多个列表项，按分类、标签和规格随机组合；满意的结果可以锁定。" action={<Button onClick={() => void create()} loading={creating}>创建分组</Button>} /></div>
  </>;
  if (groupQuery.error) return <QueryError error={groupQuery.error} onRetry={() => void groupQuery.refetch()} />;
  if (!groupQuery.data || groupQuery.data.id !== selected) return <p className="py-20 text-center text-muted-foreground">正在加载搭配…</p>;
  return <MatchingWorkspace key={selected} initial={groupQuery.data} groups={groups} onSaved={saved} onSelect={select} onCreate={create} creating={creating} onDeleted={async () => {
    client.removeQueries({ queryKey: ["matching-group", selected] });
    await groupsQuery.refetch();
    setParams({}, { replace: true });
  }} />;
}

function MatchingWorkspace({ initial, groups, onSaved, onSelect, onCreate, creating, onDeleted }: {
  initial: MatchingGroup; groups: MatchingGroupSummary[]; onSaved: (group: MatchingGroup) => void;
  onSelect: (id: string) => void; onCreate: () => Promise<void>; creating: boolean; onDeleted: () => Promise<void>;
}) {
  const { group, edit, act, busy, saveState, error, flush, reload, getVersion } = useMatchingGroup(initial, onSaved);
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const disabled = busy || creating || deleting;
  const slot = group.slots.find((item) => item.id === slotId);
  const updateSlot = (id: string, patch: Partial<MatchingSlotConfig>) => edit((current) => ({ ...current, slots: current.slots.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const afterSave = async (callback: () => void | Promise<void>) => {
    try { await flush(); await callback(); }
    catch (failure) { toast("分组尚未保存", { description: errorMessage(failure), tone: "error" }); }
  };
  const removeGroup = async () => {
    setDeleting(true);
    try {
      await flush();
      await api(`/matching-groups/${group.id}`, { method: "DELETE", idempotent: true, body: { expectedVersion: getVersion() } });
      setDeleteOpen(false);
      await onDeleted();
    } catch (failure) { toast("删除失败", { description: errorMessage(failure), tone: "error" }); }
    finally { setDeleting(false); }
  };

  return <>
    <PageHeader title="搭配" actions={<>
      <Button onClick={() => void act("RANDOM")} disabled={disabled || !group.slots.some((item) => !item.locked)}><Shuffle className="size-4" />随机</Button>
      <Button variant="outline" onClick={() => void act("PREVIOUS")} disabled={disabled || !group.slots.some((item) => !item.locked && item.canGoPrevious)}><ArrowLeft className="size-4" />上一个</Button>
      <Button variant="outline" onClick={() => setEditing(!editing)} disabled={disabled}><Pencil className="size-4" />{editing ? "完成编辑" : "编辑分组"}</Button>
      <Button variant="outline" onClick={() => void afterSave(onCreate)} disabled={disabled} loading={creating}><Plus className="size-4" />创建分组</Button>
    </>} />
    <Tabs className="matching-group-tabs" activeKey={group.id} onChange={(id) => void afterSave(() => onSelect(id))} items={groups.map((item) => ({ key: item.id, label: item.name.trim() || "未命名分组", disabled }))} />
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">{group.slots.length} 个列表项 · {group.slots.filter((item) => item.locked).length} 个已锁定</p>
      <span role="status" className={cn("text-xs", saveState === "error" ? "text-destructive" : "text-muted-foreground")}>
        {saveState === "saved" ? <span className="inline-flex items-center gap-1"><Check className="size-3.5" />已自动保存</span> : saveState === "error" ? "自动保存失败" : saveState === "saving" ? "正在保存…" : "等待自动保存…"}
      </span>
    </div>
    {error && <div className="mb-4"><Alert title={error} tone="error"><div className="flex flex-wrap gap-2">{saveState === "error" && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void afterSave(() => undefined)}>重试自动保存</Button>}<Button variant="outline" size="sm" disabled={disabled} onClick={() => void reload()}>重新加载分组（放弃本地修改）</Button></div></Alert></div>}
    {editing && <div className="surface mb-5 p-4 sm:p-5">
      <Field label="分组名称"><Input maxLength={120} value={group.name} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))} placeholder="例如：日常出门搭配" /></Field>
      <Field label="分组备注"><Textarea maxLength={2000} rows={2} value={group.notes} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, notes: event.target.value }))} placeholder="记录这组搭配的用途" /></Field>
      <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">所有修改自动保存，无需手动保存。</p><Button variant="destructive" size="sm" disabled={disabled} onClick={() => setDeleteOpen(true)}><Trash2 className="size-4" />删除分组</Button></div>
    </div>}
    {!editing && group.notes && <p className="mb-5 whitespace-pre-wrap break-words text-sm text-muted-foreground">{group.notes}</p>}
    <div className="matching-list">
      {group.slots.map((item, index) => <MatchingRow key={item.id} slot={item} index={index} busy={disabled} onConfigure={() => setSlotId(item.id)} onRandom={() => void act("RANDOM", item.id)} onPrevious={() => void act("PREVIOUS", item.id)} onLock={() => updateSlot(item.id, { locked: !item.locked })} onDisplay={(display) => updateSlot(item.id, { display })} onRemove={editing ? () => edit((current) => ({ ...current, slots: current.slots.filter((entry) => entry.id !== item.id) })) : undefined} />)}
    </div>
    {!group.slots.length && <div className="surface p-6"><EmptyState icon={List} title="分组里还没有列表项" description="添加列表项，为每一项设置独立的类型和匹配规则。" /></div>}
    <Button variant="outline" className="mt-4 w-full" disabled={disabled || group.slots.length >= 100} onClick={() => {
      const item = newMatchingSlot();
      edit((current) => ({ ...current, slots: [...current.slots, item] }));
      setSlotId(item.id);
    }}><Plus className="size-4" />添加列表项</Button>
    <p className="mt-3 text-xs text-muted-foreground">锁定项会跳过随机和上一个操作。每项保留最近 100 次结果；系统暂存区不参与随机。</p>
    {slot && <SlotEditor slot={slot} busy={disabled} onChange={(patch) => updateSlot(slot.id, patch)} onClose={() => void afterSave(() => setSlotId(null))} />}
    <Dialog open={deleteOpen} onClose={() => !deleting && setDeleteOpen(false)} title="删除搭配分组" description="将删除本分组的配置和随机记录，已有物品档案不受影响。" footer={<><Button variant="outline" disabled={deleting} onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="destructive" loading={deleting} onClick={() => void removeGroup()}>删除分组</Button></>}><p>{group.name.trim() || "未命名分组"}</p></Dialog>
  </>;
}

function MatchingRow({ slot, index, busy, onConfigure, onRandom, onPrevious, onLock, onDisplay, onRemove }: {
  slot: MatchingSlot; index: number; busy: boolean; onConfigure: () => void; onRandom: () => void;
  onPrevious: () => void; onLock: () => void; onDisplay: (display: MatchingSlotConfig["display"]) => void; onRemove?: () => void;
}) {
  const node = slot.node;
  const image = node?.images?.[0];
  const name = slot.name.trim() || `列表项 ${index + 1}`;
  const typeName = typeTabs.find((tab) => tab.key === slot.type)?.label;
  return <article className={cn("matching-row surface", slot.locked && "matching-row--locked")} aria-label={name}>
    <div className="matching-row__header">
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold" title={name}>{name}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{typeName} · {modeTabs.find((tab) => tab.key === slot.mode)?.label} · {slot.candidateCount} 个候选{slot.locked ? " · 已锁定" : ""}</p></div>
      <Tooltip title={slot.display === "LARGE" ? "切换为小图 + 详情" : "切换为大图 + 简洁详情"}><Button size="icon" variant="ghost" disabled={busy} aria-label={`${name}：${slot.display === "LARGE" ? "小图详情" : "大图简洁"}`} onClick={() => onDisplay(slot.display === "LARGE" ? "DETAIL" : "LARGE")}>{slot.display === "LARGE" ? <List className="size-4" /> : <Image className="size-4" />}</Button></Tooltip>
      <Button size="icon" variant="ghost" disabled={busy} aria-label={`${name}：配置`} onClick={onConfigure}><Pencil className="size-4" /></Button>
      {onRemove && <Button size="icon" variant="ghost" disabled={busy} aria-label={`${name}：删除`} onClick={onRemove}><Trash2 className="size-4" /></Button>}
    </div>
    <div className={cn("matching-row__body", slot.display === "LARGE" ? "matching-row__body--large" : "matching-row__body--detail")}>
      <div className="matching-row__image">{image ? <img src={slot.display === "LARGE" ? image.mainUrl || image.url || imageUrl(image.id, "main") : image.thumbUrl || imageUrl(image.id)} alt={node?.name || ""} /> : <TypeIcon type={slot.type} className="size-10 text-muted-foreground/50" />}</div>
      <div className="matching-row__details">
        {node ? <>
          <Link className="line-clamp-2 font-medium text-primary" to={`/archives/${node.id}`} title={node.name}>{node.name}</Link>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{node.code}</p>
          <div className="mt-2"><StatusBadge status={node.stockStatus} /></div>
          <p className="mt-2 truncate text-xs text-muted-foreground" title={nodeLocationLabel(node)}>{nodeLocationLabel(node)}</p>
          <dl className="matching-row__taxonomy">
            <div><dt>分类</dt><dd>{node.categories?.map((item) => item.name).join(" / ") || "—"}</dd></div>
            <div><dt>标签</dt><dd>{node.tags?.map((item) => item.name).join(" / ") || "—"}</dd></div>
            <div><dt>规格</dt><dd>{node.specifications?.map((item) => item.name).join(" / ") || "—"}</dd></div>
            {slot.display === "DETAIL" && <div><dt>档案备注</dt><dd className="whitespace-pre-wrap">{node.notes || "—"}</dd></div>}
          </dl>
        </> : <div className="grid min-h-24 content-center"><p className="font-medium">{slot.currentNodeId ? "原档案已删除" : slot.candidateCount ? "等待随机搭配" : "暂无符合规则的档案"}</p><p className="mt-2 text-xs text-muted-foreground">{slot.locked ? "解锁后可以重新随机" : slot.candidateCount ? "点击随机，挑选这一项" : "调整配置或添加档案后再随机"}</p></div>}
      </div>
    </div>
    <div className="matching-row__notes" title={slot.notes}>{slot.notes || "未填写列表项备注"}</div>
    <div className="matching-row__actions">
      <Button onClick={onRandom} disabled={busy || slot.locked} aria-label={`${name}：随机`}><Shuffle className="size-4" />随机</Button>
      <Button variant="outline" onClick={onPrevious} disabled={busy || slot.locked || !slot.canGoPrevious} aria-label={`${name}：上一个`}><ArrowLeft className="size-4" />上一个</Button>
      <Tooltip title={slot.locked ? "解锁" : "锁定当前结果"}><Button size="icon" variant={slot.locked ? "secondary" : "outline"} onClick={onLock} disabled={busy} aria-label={`${name}：${slot.locked ? "解锁" : "锁定"}`} aria-pressed={slot.locked}>{slot.locked ? <LockKeyhole className="size-4" /> : <UnlockKeyhole className="size-4" />}</Button></Tooltip>
    </div>
  </article>;
}

function SlotEditor({ slot, busy, onChange, onClose }: { slot: MatchingSlot; busy: boolean; onChange: (patch: Partial<MatchingSlotConfig>) => void; onClose: () => void }) {
  const categories = useQuery({ queryKey: ["categories"], queryFn: queries.categories });
  const tags = useQuery({ queryKey: ["tags"], queryFn: queries.tags });
  const specifications = useQuery({ queryKey: ["matching-specifications"], queryFn: matchingSpecifications });
  const taxonomyError = categories.error || tags.error || specifications.error;
  const ruleDisabled = busy || slot.locked;
  return <Dialog open onClose={onClose} title="配置列表项" description="修改自动保存，分类、标签和规格均可多选，也可以不选。" footer={<Button onClick={onClose} disabled={busy}>完成</Button>}>
    {slot.locked && <div className="mb-4"><Alert title="当前列表项已锁定" tone="info">解锁后可以修改类型和匹配规则。</Alert></div>}
    <Field label="列表项名称"><Input maxLength={120} value={slot.name} disabled={busy} placeholder="例如：上衣、出门包" onChange={(event) => onChange({ name: event.target.value })} /></Field>
    <Field label="类型">
      <Segmented<MatchingSlotConfig["type"]> block size="large" aria-label="类型" name="matching-type" value={slot.type} disabled={ruleDisabled} options={typeTabs.map((tab) => ({ value: tab.key, label: tab.label }))} onChange={(type) => onChange({ type })} className="matching-config-options" />
    </Field>
    <Field label="匹配规则">
      <Segmented<MatchingSlotConfig["mode"]> block size="large" aria-label="匹配规则" name="matching-mode" value={slot.mode} disabled={ruleDisabled} options={modeTabs.map((tab) => ({ value: tab.key, label: tab.label }))} onChange={(mode) => onChange({ mode })} className="matching-config-options" />
      <p className="text-xs text-muted-foreground">{modeHelp[slot.mode]}未选维度不限制，全部不选时随机该类型全部档案。</p>
    </Field>
    <Field label="显示模式">
      <Segmented<MatchingSlotConfig["display"]> block size="large" aria-label="显示模式" name="matching-display" value={slot.display} disabled={busy} options={displayOptions} onChange={(display) => onChange({ display })} className="matching-config-options" />
    </Field>
    {taxonomyError && <Alert title={errorMessage(taxonomyError)} tone="error" />}
    <Field label="分类"><TaxonomySelect aria-label="搭配分类" mode="multiple" allowClear maxTagCount="responsive" value={slot.categoryIds} disabled={ruleDisabled || categories.isPending || Boolean(categories.error)} optionFilterProp="label" placeholder="不限分类" options={buildCategoryTreeRows(pageItems(categories.data)).map(({ category, depth }) => ({ value: category.id, label: `${"　".repeat(depth)}${category.name}` }))} onChange={(categoryIds) => onChange({ categoryIds })} /></Field>
    <Field label="标签"><TaxonomySelect aria-label="搭配标签" mode="multiple" allowClear maxTagCount="responsive" value={slot.tagIds} disabled={ruleDisabled || tags.isPending || Boolean(tags.error)} optionFilterProp="label" placeholder="不限标签" options={pageItems(tags.data).map((tag) => ({ value: tag.id, label: tag.name }))} onChange={(tagIds) => onChange({ tagIds })} /></Field>
    <Field label="规格"><TaxonomySelect aria-label="搭配规格" mode="multiple" allowClear maxTagCount="responsive" value={slot.specificationIds} disabled={ruleDisabled || specifications.isPending || Boolean(specifications.error)} optionFilterProp="label" placeholder="不限规格" options={pageItems(specifications.data).map((specification) => ({ value: specification.id, label: specification.name }))} onChange={(specificationIds) => onChange({ specificationIds })} /></Field>
    <Field label="列表项备注"><Textarea maxLength={2000} rows={3} disabled={busy} value={slot.notes} onChange={(event) => onChange({ notes: event.target.value })} placeholder="记录这一项的搭配要求" /></Field>
  </Dialog>;
}
