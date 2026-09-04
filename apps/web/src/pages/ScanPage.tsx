import { useState } from "react";
import { ScanLine, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { errorMessage } from "@/lib/api";
import type { InventoryAction, InventoryNode } from "@/lib/types";
import { InventoryActionDialog } from "@/components/InventoryActionDialog";
import { NodeCard } from "@/components/NodeCard";
import { ScannerInput } from "@/components/ScannerInput";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Segmented,
} from "@/components/AntUi";
import { api } from "@/lib/api";
import { queries } from "@/lib/queries";

async function findNode(code: string) {
  const data = await api<{ id?: string; node?: InventoryNode }>(
    `/codes/${code}`,
  );
  return (
    data.node ||
    (data.id
      ? queries.node(data.id)
      : Promise.reject(new Error("没有找到档案")))
  );
}

export function ScanPage() {
  const [params, setParams] = useSearchParams();
  const mode = params.get("mode") === "batch" ? "batch" : "lookup";
  const [candidate, setCandidate] = useState<InventoryNode | null>(null);
  const [pending, setPending] = useState<InventoryNode[]>([]);
  const [scanError, setScanError] = useState("");
  const [action, setAction] = useState<InventoryAction | null>(null);
  async function scan(code: string) {
    setScanError("");
    try {
      const node = await findNode(code);
      if (mode === "lookup") setCandidate(node);
      else if (!pending.some((item) => item.id === node.id))
        setPending((current) => [...current, node]);
    } catch (error) {
      setScanError(errorMessage(error));
    }
  }
  return (
    <div>
      <div className="mb-5">
        <Segmented
          value={mode}
          onChange={(value) => {
            setParams({ mode: value }, { replace: true });
            setCandidate(null);
            setPending([]);
            setScanError("");
          }}
          options={[
            { value: "lookup", label: "单码查询" },
            { value: "batch", label: "批量清单" },
          ]}
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanLine className="size-5" />
              {mode === "lookup" ? "识别档案" : "连续加入清单"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScannerInput
              onCode={scan}
              paused={mode === "lookup" && !!candidate}
            />
            {scanError && (
              <Alert title="无法识别" tone="error" className="mt-4">
                {scanError}
              </Alert>
            )}
            {mode === "lookup" && candidate && (
              <div className="mt-5">
                <NodeCard node={candidate} />
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" onClick={() => setCandidate(null)}>
                    继续扫描
                  </Button>
                </div>
              </div>
            )}
            {mode === "lookup" && !candidate && (
              <EmptyState
                icon={ScanLine}
                title="等待编号"
                description="PC 可用扫码枪聚焦输入框；手机在可信 HTTPS 下可打开摄像头。"
              />
            )}
          </CardContent>
        </Card>
        {mode === "batch" && (
          <Card>
            <CardHeader>
              <CardTitle>待处理清单（{pending.length}/100）</CardTitle>
            </CardHeader>
            <CardContent>
              {pending.length ? (
                <>
                  <div className="max-h-[55vh] space-y-2 overflow-y-auto">
                    {pending.map((node) => (
                      <div
                        key={node.id}
                        className="flex min-h-12 items-center gap-3 rounded-md border p-2"
                      >
                        <span className="font-mono text-xs">{node.code}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {node.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setPending((current) =>
                              current.filter((item) => item.id !== node.id),
                            )
                          }
                          aria-label={`移除 ${node.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Button variant="outline" onClick={() => setAction("MOVE")}>
                      批量移动
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setAction("REMOVE")}
                    >
                      移出暂存
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setAction("CHECK_OUT")}
                    >
                      批量出库
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setAction("CHECK_IN")}
                    >
                      批量入库
                    </Button>
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={ScanLine}
                  title="清单为空"
                  description="连续扫描会去重；此时不会修改任何库存。"
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>
      <InventoryActionDialog
        open={!!action}
        action={action || "MOVE"}
        nodes={pending}
        onClose={() => {
          setAction(null);
          setPending([]);
        }}
      />
    </div>
  );
}
