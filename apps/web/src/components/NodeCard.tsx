import { Archive, Box, ChevronRight, MapPin, Package, Warehouse } from "lucide-react";
import { Link } from "react-router-dom";
import type { InventoryNode, NodeType, StockStatus } from "@/lib/types";
import { imageUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge, Card } from "./AntUi";

const icons: Record<NodeType, typeof Archive> = { ITEM: Archive, BAG: Package, BOX: Box, WAREHOUSE: Warehouse };
const typeNames: Record<NodeType, string> = { ITEM: "物品", BAG: "袋子", BOX: "箱子", WAREHOUSE: "仓库" };
const statusMap: Record<StockStatus, { label: string; variant: "success" | "warning" | "destructive" }> = { IN_STOCK: { label: "在库", variant: "success" }, OUT: { label: "已出库", variant: "warning" }, DISCARDED: { label: "已废弃", variant: "destructive" } };

export function TypeIcon({ type, className }: { type: NodeType; className?: string }) { const Icon = icons[type]; return <Icon className={className} />; }
export function TypeName({ type }: { type: NodeType }) { return typeNames[type]; }
export function StatusBadge({ status }: { status?: StockStatus | null }) { if (!status) return null; const info = statusMap[status]; return <Badge variant={info.variant}>{info.label}</Badge>; }

export function nodeLocationLabel(node: InventoryNode): string {
  if (node.stockStatus === "OUT") return "已出库";
  if (node.stockStatus === "DISCARDED") return "已废弃";
  const parent = node.path?.[1];
  if (parent?.isSystemStaging) return "暂存区";
  if (parent) return `${parent.name} · ${parent.code}`;
  return node.type === "WAREHOUSE" ? "顶级位置" : "未设置位置";
}

export function NodeCard({
  node,
  selectable,
  selectionDisabled,
  selected,
  onSelect,
}: {
  node: InventoryNode;
  selectable?: boolean;
  selectionDisabled?: boolean;
  selected?: boolean;
  onSelect?: (node: InventoryNode) => void;
}) {
  const destination = node.type === "ITEM" ? `/items/${node.id}` : `/locations/${node.id}`;
  const image = node.images?.[0];
  const location = nodeLocationLabel(node);
  const content = <>
      <div className="flex h-32 items-stretch">
      <div className="grid w-28 shrink-0 place-items-center bg-muted sm:w-32">{image ? <img src={image.thumbUrl || image.url || imageUrl(image.id)} alt="" className="size-full object-cover" /> : <TypeIcon type={node.type} className="size-9 text-muted-foreground/60" />}</div>
      <div className="flex min-w-0 flex-1 flex-col p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="truncate font-medium">{node.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{node.code}</p></div><div className="flex shrink-0 flex-col items-end gap-1.5"><Badge variant="outline"><TypeName type={node.type} /></Badge><StatusBadge status={node.stockStatus} /></div></div><div className="mt-auto flex min-w-0 items-center gap-2 pt-2"><p className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground" title={location}><MapPin className="size-3.5 shrink-0" /><span className="truncate">{location}</span></p><ChevronRight className="node-card__chevron size-5 shrink-0 text-muted-foreground" /></div></div>
    </div>
  </>;
  const cardClassName = cn("node-card w-full overflow-hidden text-left", selected && "ring-2 ring-primary");
  if (selectable) return <Card
    role="button"
    tabIndex={selectionDisabled ? -1 : 0}
    aria-pressed={selected}
    aria-disabled={selectionDisabled}
    onClick={() => !selectionDisabled && onSelect?.(node)}
    onKeyDown={(event) => {
      if (selectionDisabled) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect?.(node);
    }}
    className={cn(
      cardClassName,
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
      selectionDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
    )}
  >{content}</Card>;
  return <Link to={destination} className="block w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Card className={cardClassName}>{content}</Card></Link>;
}
