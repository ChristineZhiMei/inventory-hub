import { Table } from "antd";
import { Link } from "react-router-dom";
import type { InventoryNode } from "@/lib/types";
import { Badge } from "./AntUi";
import {
  nodeLocationLabel,
  StatusBadge,
  TypeName,
} from "./NodeCard";

export function NodeListTable({
  nodes,
  loading,
  selecting = false,
  selected,
  onSelectedChange,
  canSelect = () => true,
}: {
  nodes: InventoryNode[];
  loading?: boolean;
  selecting?: boolean;
  selected?: InventoryNode[];
  onSelectedChange?: (nodes: InventoryNode[]) => void;
  canSelect?: (node: InventoryNode) => boolean;
}) {
  const selectedIds = new Set(selected?.map((node) => node.id) || []);
  return (
    <div className="overflow-x-auto">
      <Table<InventoryNode>
        rowKey="id"
        loading={loading}
        pagination={false}
        dataSource={nodes}
        scroll={{ x: 760 }}
        rowSelection={selecting ? {
          selectedRowKeys: [...selectedIds],
          getCheckboxProps: (node) => ({ disabled: !canSelect(node) }),
          onChange: (_, selectedRows) => onSelectedChange?.(selectedRows),
        } : undefined}
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
            render: (_, node) => <Badge variant="outline"><TypeName type={node.type} /></Badge>,
          },
          {
            title: "编号",
            dataIndex: "code",
            key: "code",
            width: 120,
            render: (code: string) => <span className="font-mono text-xs">{code}</span>,
          },
          {
            title: "所在位置",
            key: "location",
            width: 190,
            ellipsis: true,
            render: (_, node) => nodeLocationLabel(node),
          },
          {
            title: "状态",
            key: "status",
            width: 90,
            render: (_, node) => <StatusBadge status={node.stockStatus} />,
          },
          {
            title: "操作",
            key: "action",
            width: 96,
            fixed: "right",
            render: (_, node) => (
              <Link
                to={node.type === "ITEM" ? `/items/${node.id}` : `/locations/${node.id}`}
                className="font-medium text-primary hover:underline"
              >
                查看
              </Link>
            ),
          },
        ]}
      />
    </div>
  );
}
