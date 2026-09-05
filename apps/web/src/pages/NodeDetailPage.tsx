import { useState } from "react";
import { Image, Table } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Box,
  ChevronRight,
  Edit3,
  History,
  ImageOff,
  Package,
  PackagePlus,
  Printer,
  Trash2,
  Warehouse,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorMessage, imageUrl } from "@/lib/api";
import {
  consumeLocalNativeQueue,
  type NativePrintSettings,
} from "@/lib/localPrinting";
import { pageItems, queries } from "@/lib/queries";
import type {
  InventoryAction,
  InventoryNode,
  PrintExecutor,
} from "@/lib/types";
import { formatDate, formatOperationSummary } from "@/lib/utils";
import { CodeLabel } from "@/components/CodeLabel";
import { InventoryActionDialog } from "@/components/InventoryActionDialog";
import {
  NodeCard,
  StatusBadge,
  TypeIcon,
  TypeName,
} from "@/components/NodeCard";
import { PageHeader, QueryError } from "@/components/Page";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  Segmented,
  Select,
  Skeleton,
} from "@/components/AntUi";

export function NodeDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const contentView = searchParams.get("view") === "list" ? "list" : "card";
  const [action, setAction] = useState<InventoryAction | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [executorId, setExecutorId] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [lastPrintJobId, setLastPrintJobId] = useState("");
  const detail = useQuery({
    queryKey: ["node", id],
    queryFn: () => queries.node(id!),
    enabled: !!id,
  });
  const contents = useQuery({
    queryKey: ["contents", id, "direct"],
    queryFn: () => queries.contents(id!, false),
    enabled: !!id && !!detail.data && detail.data.type !== "ITEM",
  });
  const operations = useQuery({
    queryKey: ["operations", "node", id],
    queryFn: () =>
      queries.operations(
        new URLSearchParams({ nodeId: id!, limit: "8" }).toString(),
      ),
    enabled: !!id,
  });
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: queries.capabilities,
  });
  const executors = useQuery({
    queryKey: ["print-executors"],
    queryFn: queries.printExecutors,
    enabled: printOpen && capabilities.data?.deploymentMode === "server",
  });
  const nativePrintSettings = useQuery({
    queryKey: ["native-print-settings"],
    queryFn: () => api<NativePrintSettings>("/print-native/settings"),
    enabled: capabilities.data?.deploymentMode === "desktop",
    retry: false,
  });
  const printMutation = useMutation({
    mutationFn: async (remote?: { executorId: string; printerId: string }) => {
      const native =
        !remote && capabilities.data?.deploymentMode === "desktop";
      const job = await api<{ id: string }>("/print-jobs", {
        method: "POST",
        idempotent: true,
        body: {
          executorId:
            remote?.executorId || (native ? "local-native" : "local-simulator"),
          printerId:
            remote?.printerId ||
            (native ? "local-default" : "HPRT-D35-SIMULATOR"),
          nodeIds: [id],
          templateId: `default-${nativePrintSettings.data?.paper || "40x30"}`,
          copies: 1,
        },
      });
      if (native && window.inventoryHub?.printLabel)
        await consumeLocalNativeQueue();
      return job;
    },
    onSuccess: (job) => {
      setPrintOpen(false);
      setLastPrintJobId(job.id);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () =>
      api(`/nodes/${id}`, {
        method: "DELETE",
        idempotent: true,
        body: {
          expectedVersion: detail.data!.version,
          expectedLocationVersion: detail.data!.locationVersion,
          locationToken: detail.data!.locationToken,
          confirmCode,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      navigate(detail.data?.type === "ITEM" ? "/items" : "/locations", {
        replace: true,
      });
    },
  });
  if (detail.isLoading)
    return (
      <>
        <PageHeader title="加载档案…" back />
        <Skeleton className="h-80" />
      </>
    );
  if (detail.isError || !detail.data)
    return (
      <>
        <PageHeader title="档案详情" back />
        <QueryError error={detail.error} onRetry={() => detail.refetch()} />
      </>
    );
  const node = detail.data;
  const contentItems = pageItems(contents.data);
  const canDelete =
    node.stockStatus === "DISCARDED" ||
    (node.type === "WAREHOUSE" &&
      !node.isSystemStaging &&
      contentItems.length === 0);
  const actions: InventoryAction[] =
    node.type === "WAREHOUSE"
      ? []
      : node.stockStatus === "IN_STOCK"
        ? ["MOVE", "REMOVE", "CHECK_OUT", "DISCARD"]
        : node.stockStatus === "OUT"
          ? ["CHECK_IN", "DISCARD"]
          : ["RESTORE"];
  const actionName: Record<InventoryAction, string> = {
    MOVE: "移动",
    REMOVE: "移出",
    CHECK_OUT: "出库",
    CHECK_IN: "入库",
    DISCARD: "废弃",
    RESTORE: "恢复",
  };
  const onlineExecutors = (executors.data || []).filter(
    (executor) => executor.state === "ONLINE",
  );
  const selectedExecutor =
    onlineExecutors.find((executor) => executor.id === executorId) ||
    onlineExecutors[0];
  const selectedPrinter = remotePrinterId(selectedExecutor);
  return (
    <div>
      <PageHeader
        title={node.name}
        description={`${node.code} · ${node.type === "ITEM" ? "物品" : node.type === "BAG" ? "袋子" : node.type === "BOX" ? "箱子" : "仓库"}`}
        back
        actions={
          <>
            <Link
              to={`${node.type === "ITEM" ? `/items/${node.id}` : `/locations/${node.id}`}/edit`}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"
            >
              <Edit3 className="size-4" />
              编辑
            </Link>
            <Button
              variant="outline"
              onClick={() =>
                capabilities.data?.deploymentMode === "server"
                  ? setPrintOpen(true)
                  : printMutation.mutate(undefined)
              }
              loading={printMutation.isPending}
              disabled={capabilities.isLoading || capabilities.isError}
            >
              <Printer className="size-4" />
              打印标签
            </Button>
          </>
        }
      />
      {printMutation.error && (
        <Alert title="无法创建打印任务" tone="error" className="mb-4">
          {errorMessage(printMutation.error)}
        </Alert>
      )}
      {lastPrintJobId && (
        <Alert title="打印任务已创建" tone="success" className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {capabilities.data?.deploymentMode === "desktop" &&
              !window.inventoryHub?.printLabel
                ? "任务已发送到电脑端打印队列，页面可以继续操作。"
                : "当前页面会保持不变，可以继续操作。"}
            </span>
            <Link
              to={`/print-jobs/${lastPrintJobId}`}
              className="font-medium text-primary hover:underline"
            >
              查看打印任务
            </Link>
          </div>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="p-5">
              <div className="flex flex-wrap items-start gap-5">
                <div className="grid size-16 place-items-center rounded-lg bg-muted">
                  <TypeIcon
                    type={node.type}
                    className="size-8 text-muted-foreground"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold">{node.name}</h2>
                    <StatusBadge status={node.stockStatus} />
                    {node.isSystemStaging && (
                      <Badge variant="warning">系统暂存区</Badge>
                    )}
                  </div>
                  <p className="mt-2 font-mono text-sm text-muted-foreground">
                    {node.code}
                  </p>
                  {node.path?.length ? (
                    <nav
                      className="mt-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
                      aria-label="当前位置"
                    >
                      {node.path.map((entry, index) => (
                        <span
                          key={entry.id}
                          className="flex items-center gap-1"
                        >
                          <Link
                            to={
                              entry.type === "ITEM"
                                ? `/items/${entry.id}`
                                : `/locations/${entry.id}`
                            }
                            className="hover:text-foreground hover:underline"
                          >
                            {entry.name}
                          </Link>
                          {index < node.path!.length - 1 && (
                            <ChevronRight className="size-3" />
                          )}
                        </span>
                      ))}
                    </nav>
                  ) : node.stockStatus === "OUT" ? (
                    <p className="mt-3 text-sm text-amber-700">
                      当前离库
                      {node.lastPath?.length
                        ? `；最后位置：${node.lastPath.map((entry) => entry.name).join(" / ")}`
                        : ""}
                    </p>
                  ) : null}
                </div>
              </div>
              {actions.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-2 border-t pt-5">
                  {actions.map((name) => (
                    <Button
                      key={name}
                      variant={
                        name === "DISCARD" || name === "CHECK_OUT"
                          ? "outline"
                          : "secondary"
                      }
                      onClick={() => setAction(name)}
                    >
                      {actionName[name]}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>图片</CardTitle>
            </CardHeader>
            <CardContent>
              {node.images?.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {node.images.map((image, index) => (
                    <div
                      key={image.id}
                      className="node-detail-image group relative aspect-square overflow-hidden rounded-md bg-muted"
                    >
                      <Image
                        src={image.thumbUrl || image.url || imageUrl(image.id)}
                        preview={{
                          src: image.mainUrl || image.url || imageUrl(image.id, "main"),
                          mask: "查看原图",
                        }}
                        alt={`${node.name} 图片 ${index + 1}`}
                        rootClassName="node-detail-image__preview"
                      />
                      {index === 0 && (
                        <span className="absolute bottom-2 left-2 rounded bg-slate-950/75 px-2 py-1 text-xs text-white">
                          封面
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid min-h-36 place-items-center rounded-md border border-dashed">
                  <div className="text-center">
                    <ImageOff className="mx-auto size-7 text-muted-foreground/60" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      没有图片
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          {node.type !== "ITEM" && (
            <Card>
              <CardHeader className="node-contents-header">
                <CardTitle>收纳内容</CardTitle>
                <Segmented
                  className="node-contents-header__tabs"
                  value={contentView}
                  onChange={(value) => {
                    const next = new URLSearchParams(searchParams);
                    if (value === "list") next.set("view", "list");
                    else next.delete("view");
                    setSearchParams(next, { replace: true });
                  }}
                  options={[
                    { value: "card", label: "卡片" },
                    { value: "list", label: "列表" },
                  ]}
                />
                <p className="col-span-2 text-sm text-muted-foreground">
                  当前直接包含 {contentItems.length} 个档案；袋子或箱子里的内容请进入对应详情查看。
                </p>
              </CardHeader>
              <CardContent>
                {contents.isLoading ? (
                  <Skeleton className="h-40" />
                ) : contents.isError ? (
                  <QueryError
                    error={contents.error}
                    onRetry={() => contents.refetch()}
                  />
                ) : contentItems.length && contentView === "card" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {contentItems.map((child) => (
                      <div key={child.id}>
                        <NodeCard node={child} />
                      </div>
                    ))}
                  </div>
                ) : contentItems.length ? (
                  <div className="overflow-x-auto">
                    <Table<InventoryNode>
                      rowKey="id"
                      pagination={false}
                      dataSource={contentItems}
                      scroll={{ x: 680 }}
                      columns={[
                        {
                          title: "名称",
                          dataIndex: "name",
                          key: "name",
                          ellipsis: true,
                        },
                        {
                          title: "类型",
                          key: "type",
                          width: 90,
                          render: (_, child) => (
                            <Badge variant="outline"><TypeName type={child.type} /></Badge>
                          ),
                        },
                        {
                          title: "编号",
                          dataIndex: "code",
                          key: "code",
                          width: 120,
                          render: (code: string) => <span className="font-mono text-xs">{code}</span>,
                        },
                        {
                          title: "状态",
                          key: "status",
                          width: 90,
                          render: (_, child) => <StatusBadge status={child.stockStatus} />,
                        },
                        {
                          title: "操作",
                          key: "action",
                          width: 100,
                          fixed: "right",
                          render: (_, child) => (
                            <Link
                              to={child.type === "ITEM" ? `/items/${child.id}` : `/locations/${child.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              查看详情
                            </Link>
                          ),
                        },
                      ]}
                    />
                  </div>
                ) : (
                  <EmptyState
                    icon={
                      node.type === "BAG"
                        ? Package
                        : node.type === "BOX"
                          ? Box
                          : Warehouse
                    }
                    title="这里还是空的"
                    description="可以进入连续录入工作台，新建或扫码装入已有档案。"
                    action={
                      <Link
                        to={`/intake?targetId=${node.id}`}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        开始连续录入
                      </Link>
                    }
                  />
                )}
              </CardContent>
            </Card>
          )}
        </div>
        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>档案编号</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <CodeLabel
                code={node.code}
                name={node.name}
                categories={node.categories}
                specifications={node.specifications}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>档案信息</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">类型</dt>
                  <dd className="mt-1 font-medium">
                    <TypeName type={node.type} />
                  </dd>
                </div>
                {(node.categories?.length || node.category) && (
                  <div>
                    <dt className="text-muted-foreground">分类</dt>
                    <dd className="mt-2 flex flex-wrap gap-1">
                      {node.categories?.length
                        ? node.categories.map((category) => (
                            <Badge key={category.id} variant="outline">
                              {category.name}
                            </Badge>
                          ))
                        : node.category?.name}
                    </dd>
                  </div>
                )}
                {(node.specifications?.length || node.specification) && (
                  <div>
                    <dt className="text-muted-foreground">规格</dt>
                    <dd className="mt-2 flex flex-wrap gap-1">
                      {node.specifications?.length
                        ? node.specifications.map((specification) => (
                            <Badge key={specification.id} variant="outline">
                              {specification.name}
                            </Badge>
                          ))
                        : node.specification}
                    </dd>
                  </div>
                )}
                {node.tags?.length ? (
                  <div>
                    <dt className="text-muted-foreground">标签</dt>
                    <dd className="mt-2 flex flex-wrap gap-1">
                      {node.tags.map((tag) => (
                        <Badge key={tag.id} variant="secondary">
                          {tag.name}
                        </Badge>
                      ))}
                    </dd>
                  </div>
                ) : null}
                {node.notes && (
                  <div>
                    <dt className="text-muted-foreground">备注</dt>
                    <dd className="mt-1 whitespace-pre-wrap">{node.notes}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">最近更新</dt>
                  <dd className="mt-1">{formatDate(node.updatedAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4" />
                最近操作
              </CardTitle>
            </CardHeader>
            <CardContent>
              {pageItems(operations.data).length ? (
                <ol className="space-y-2">
                  {pageItems(operations.data).map((operation) => (
                    <li key={operation.id}>
                      <Link
                        to={`/operations/${operation.id}`}
                        className="block rounded-md p-2 hover:bg-muted"
                      >
                        <p className="text-sm font-medium">
                          {formatOperationSummary(operation.action, operation.summary)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDate(operation.createdAt)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  暂无记录
                </p>
              )}
            </CardContent>
          </Card>
          {canDelete && (
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              永久删除档案
            </Button>
          )}
        </aside>
      </div>
      <InventoryActionDialog
        open={!!action}
        action={action || "MOVE"}
        nodes={[node]}
        onClose={() => setAction(null)}
      />
      <Dialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="打印标签"
        footer={
          <>
            <Button variant="outline" onClick={() => setPrintOpen(false)}>
              取消
            </Button>
            <Button
              loading={printMutation.isPending}
              disabled={!selectedExecutor || !selectedPrinter}
              onClick={() =>
                selectedExecutor &&
                selectedPrinter &&
                printMutation.mutate({
                  executorId: selectedExecutor.id,
                  printerId: selectedPrinter,
                })
              }
            >
              创建打印任务
            </Button>
          </>
        }
      >
        {executors.isError ? (
          <QueryError
            error={executors.error}
            onRetry={() => executors.refetch()}
          />
        ) : (
          <div className="space-y-4">
            <label
              className="block text-sm font-medium"
              htmlFor="remote-print-executor"
            >
              在线执行器
            </label>
            <Select
              id="remote-print-executor"
              value={selectedExecutor?.id || ""}
              onChange={(event) => setExecutorId(event.target.value)}
              disabled={executors.isLoading}
            >
              <option value="">
                {executors.isLoading ? "正在读取…" : "选择执行器"}
              </option>
              {onlineExecutors.map((executor) => (
                <option key={executor.id} value={executor.id}>
                  {executor.name} ·{" "}
                  {remotePrinterId(executor) || "未报告打印机"}
                </option>
              ))}
            </Select>
            {!executors.isLoading && !onlineExecutors.length && (
              <Alert title="没有在线打印执行器" tone="warning">
                请先在设置中完成配对。
              </Alert>
            )}
            {selectedExecutor && !selectedPrinter && (
              <Alert title="执行器未报告打印机" tone="warning">
                请在执行器电脑上选择打印机并重新连接。
              </Alert>
            )}
            {printMutation.error && (
              <Alert title="无法创建打印任务" tone="error">
                {errorMessage(printMutation.error)}
              </Alert>
            )}
          </div>
        )}
      </Dialog>
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="永久删除档案"
        description="此操作不可撤销，编号仍会永久保留。"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              loading={deleteMutation.isPending}
              disabled={confirmCode !== node.code}
              onClick={() => deleteMutation.mutate()}
            >
              永久删除
            </Button>
          </>
        }
      >
        <Alert title="图片将在撤销访问后进入清理队列" tone="warning">
          磁盘离线时清理会等待，档案删除不代表文件已经物理清除。
        </Alert>
        <label
          htmlFor="hard-delete-confirmation"
          className="mt-4 block text-sm font-medium"
        >
          输入编号 <strong>{node.code}</strong> 确认
        </label>
        <Input
          id="hard-delete-confirmation"
          name="hard-delete-confirmation"
          className="mt-2"
          value={confirmCode}
          onChange={(e) => setConfirmCode(e.target.value.toUpperCase())}
          autoComplete="off"
        />
        {deleteMutation.error && (
          <p className="mt-3 text-sm text-destructive">
            {errorMessage(deleteMutation.error)}
          </p>
        )}
      </Dialog>
    </div>
  );
}

function remotePrinterId(executor?: PrintExecutor) {
  const capabilities = executor?.capabilities;
  const first = capabilities?.printers?.[0];
  return (
    capabilities?.selectedPrinterId ||
    capabilities?.defaultPrinterId ||
    capabilities?.printerId ||
    capabilities?.printerIds?.[0] ||
    (typeof first === "string"
      ? first
      : first?.printerId || first?.id || first?.name) ||
    ""
  );
}
