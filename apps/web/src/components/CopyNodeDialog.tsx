import { useState } from "react";
import { Checkbox } from "antd";
import { useNavigate } from "react-router-dom";
import { copyFields, readCopyDefaults, type CopyField } from "@/lib/nodeCopy";
import type { InventoryNode } from "@/lib/types";
import { Button, Dialog } from "./AntUi";

export function CopyNodeDialog({ node, onClose }: { node: InventoryNode; onClose: () => void }) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<CopyField[]>(() =>
    readCopyDefaults().filter((field) => field !== "location" || node.type !== "WAREHOUSE"),
  );
  return (
    <Dialog open onClose={onClose} title="复制档案" description="选择要复制的基本信息，下一步可继续编辑。不会复制包含的物品或容器。"
      footer={<><Button variant="outline" onClick={onClose}>取消</Button><Button onClick={() => {
        const params = new URLSearchParams({ copyFrom: node.id, fields: selected.join(",") });
        navigate(`/archives/new?${params}`);
        onClose();
      }}>下一步</Button></>}>
      <Checkbox.Group value={selected} onChange={(values) => setSelected(values as CopyField[])} className="grid grid-cols-2 gap-4 py-3">
        {copyFields.map((field) => <Checkbox key={field.value} value={field.value} disabled={field.value === "location" && node.type === "WAREHOUSE"}>{field.label}</Checkbox>)}
      </Checkbox.Group>
      <p className="mt-3 text-sm text-muted-foreground">默认勾选项可在「设置 → 复制偏好」中修改。仓库始终创建为顶级位置。</p>
    </Dialog>
  );
}
