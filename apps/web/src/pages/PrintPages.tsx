import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Printer,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "@/lib/api";
import {
  consumeLocalNativeQueue,
  type NativePrintSettings,
} from "@/lib/localPrinting";
import { pageItems, queries } from "@/lib/queries";
import type { PrintItemState } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { CodeLabel } from "@/components/CodeLabel";
import { PageHeader, QueryError } from "@/components/Page";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
} from "@/components/AntUi";

const stateInfo: Record<
  PrintItemState,
  {
    label: string;
    variant: "secondary" | "success" | "warning" | "destructive";
  }
> = {
  QUEUED: { label: "待发送", variant: "secondary" },
  SENDING: { label: "发送中", variant: "warning" },
  SUBMITTED: { label: "系统已接受", variant: "success" },
  FAILED: { label: "明确失败", variant: "destructive" },
  UNKNOWN: { label: "结果未知", variant: "warning" },
  CANCELLED: { label: "已取消", variant: "secondary" },
};

export function PrintJobsPage() {
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: queries.capabilities,
  });
  const query = useQuery({
    queryKey: ["print-jobs"],
    queryFn: queries.printJobs,
    refetchInterval: (q) =>
      pageItems(q.state.data).some((job) =>
        ["QUEUED", "RUNNING", "ATTENTION"].includes(job.status),
      )
        ? 2000
        : false,
  });
  const jobs = pageItems(query.data);
  const nativeSettings = useQuery({
    queryKey: ["native-print-settings"],
    queryFn: () => api<NativePrintSettings>("/print-native/settings"),
    enabled: capabilities.data?.deploymentMode === "desktop",
    retry: false,
  });
  const serverMode = capabilities.data?.deploymentMode === "server";
  return (
    <div>
      <Alert
        title={
          serverMode
            ? "打印由 Electron 执行器处理"
            : nativeSettings.data?.printerId
            ? `Electron 打印机：${nativeSettings.data.printerId}`
            : "Electron 打印机尚未配置"
        }
        tone="warning"
        className="mb-5"
      >
        {serverMode
          ? "设备列表和打印状态来自后端已配对的 Electron 执行器。"
          : nativeSettings.data?.printerId
          ? "系统接受打印任务不等于标签已经实际出纸；结果未知时不会自动重发。"
          : "请在设备与打印中，从 Electron 电脑上报的设备列表里选择打印机。"}
      </Alert>
      {query.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((x) => (
            <Skeleton key={x} className="h-24" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      ) : jobs.length ? (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Link
              to={`/print-jobs/${job.id}`}
              key={job.id}
              className="surface block p-4 transition hover:shadow-raised"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="grid size-11 place-items-center rounded-md bg-muted">
                  <Printer className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">打印任务 {job.id.slice(0, 8)}</p>
                    <Badge
                      variant={
                        job.status === "SETTLED"
                          ? "success"
                          : job.status === "ATTENTION"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {job.status}
                    </Badge>
                    {job.paused && <Badge variant="warning">已暂停</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(job.createdAt)} ·{" "}
                    {Object.entries(job.counts || {})
                      .map(
                        ([state, count]) =>
                          `${stateInfo[state as PrintItemState]?.label || state} ${count}`,
                      )
                      .join(" · ")}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Printer}
          title="还没有打印任务"
          description="在物品或位置档案详情中预览条码并创建打印任务。"
        />
      )}
    </div>
  );
}

export function PrintJobDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["print-job", id],
    queryFn: () => queries.printJob(id!),
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data &&
      ["QUEUED", "RUNNING", "ATTENTION"].includes(q.state.data.status)
        ? 2000
        : false,
  });
  const [resolveEvidence, setResolveEvidence] = useState("");
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(path, { method: "POST", idempotent: true, body: body || {} }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["print-job", id] });
      await queryClient.invalidateQueries({ queryKey: ["print-jobs"] });
    },
  });
  const nativePrint = useMutation({
    mutationFn: consumeLocalNativeQueue,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["print-job", id] });
      await queryClient.invalidateQueries({ queryKey: ["print-jobs"] });
    },
  });
  if (query.isLoading)
    return (
      <>
        <PageHeader title="打印任务" back />
        <Skeleton className="h-80" />
      </>
    );
  if (query.isError || !query.data)
    return (
      <>
        <PageHeader title="打印任务" back />
        <QueryError error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  const job = query.data;
  return (
    <div>
      <PageHeader
        title={`打印任务 ${job.id.slice(0, 8)}`}
        back
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                action.mutate({ path: `/print-jobs/${job.id}/cancel-pending` })
              }
            >
              <Ban className="size-4" />
              取消未发送
            </Button>
            {job.paused && (
              <Button
                loading={action.isPending || nativePrint.isPending}
                onClick={async () => {
                  await action.mutateAsync({
                    path: `/print-jobs/${job.id}/resume`,
                  });
                  if (job.executorId === "local-native")
                    await nativePrint.mutateAsync();
                }}
              >
                <RefreshCw className="size-4" />
                继续队列
              </Button>
            )}
            {job.executorId === "local-native" &&
              !job.paused &&
              job.items?.some((item) => item.state === "QUEUED") && (
                <Button
                  loading={nativePrint.isPending}
                  onClick={() => nativePrint.mutate()}
                >
                  <Printer className="size-4" />
                  继续本机打印
                </Button>
              )}
          </>
        }
      />
      {job.paused && (
        <Alert title="批次已暂停" tone="warning" className="mb-5">
          {job.pauseReason ||
            "请先处理明确失败或结果未知的标签，再继续剩余任务。"}
        </Alert>
      )}
      {action.error && (
        <Alert title="任务操作失败" tone="error" className="mb-5">
          {errorMessage(action.error)}
        </Alert>
      )}
      {nativePrint.error && (
        <Alert title="本机打印未完成" tone="error" className="mb-5">
          {errorMessage(nativePrint.error)}
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {job.items?.map((item) => {
            const info = stateInfo[item.state];
            return (
              <Card key={item.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">
                          {item.code}
                        </span>
                        <span className="truncate text-sm">{item.name}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        第 {item.ordinal + 1} 张 · 第 {item.copyIndex + 1} 份
                      </p>
                    </div>
                    <Badge variant={info.variant}>{info.label}</Badge>
                  </div>
                  {item.error && (
                    <p className="mt-3 rounded bg-red-50 p-2 text-sm text-destructive">
                      {item.error}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {item.state === "FAILED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          action.mutate({
                            path: `/print-items/${item.id}/retry`,
                            body: { expectedState: "FAILED" },
                          })
                        }
                      >
                        <RotateCcw className="size-4" />
                        只重试本张
                      </Button>
                    )}
                    {item.state === "UNKNOWN" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            action.mutate({
                              path: `/print-items/${item.id}/resolve`,
                              body: {
                                conclusion: "ACCEPTED",
                                evidence: resolveEvidence || "用户核对",
                                acknowledgedByUser: true,
                              },
                            })
                          }
                        >
                          确认已接受
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            action.mutate({
                              path: `/print-items/${item.id}/resolve`,
                              body: {
                                conclusion: "NOT_ACCEPTED",
                                evidence: resolveEvidence || "用户核对",
                                acknowledgedByUser: true,
                              },
                            })
                          }
                        >
                          确认未接受
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            action.mutate({
                              path: `/print-jobs/${job.id}/reprint`,
                              body: {
                                itemIds: [item.id],
                                acknowledgeDuplicateRisk: true,
                              },
                            })
                          }
                        >
                          承担重复风险并补打
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          }) || (
            <EmptyState
              icon={Printer}
              title="没有标签子任务"
              description="此批次没有可显示的标签。"
            />
          )}
        </div>
        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>批次状态</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(job.counts || {}).map(([state, count]) => (
                  <div key={state} className="rounded-md bg-muted p-3">
                    <p className="text-xs text-muted-foreground">
                      {stateInfo[state as PrintItemState]?.label || state}
                    </p>
                    <p className="mt-1 text-xl font-semibold">{count}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          {job.items?.[0] && (
            <Card>
              <CardHeader>
                <CardTitle>标签预览</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <CodeLabel
                  code={job.items[0].code}
                  name={job.items[0].name}
                  categories={job.items[0].payloadSnapshot?.node?.categories}
                  specifications={job.items[0].payloadSnapshot?.node?.specifications}
                  paper={job.items[0].payloadSnapshot?.paper}
                />
              </CardContent>
            </Card>
          )}{" "}
          {job.items?.some((item) => item.state === "UNKNOWN") && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="size-5 text-amber-600" />
                  人工核对依据
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Field label="核对记录">
                  <Input
                    value={resolveEvidence}
                    onChange={(e) => setResolveEvidence(e.target.value)}
                    placeholder="例如：系统队列中可见任务"
                  />
                </Field>
                <p className="mt-2 text-xs text-muted-foreground">
                  结果未知时不会自动重发，以免重复出纸。
                </p>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
