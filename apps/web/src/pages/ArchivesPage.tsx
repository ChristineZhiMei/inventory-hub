import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import { ItemsPage } from "./ItemsPage";
import { LocationsPage } from "./LocationsPage";
import type { NodeType } from "@/lib/types";

const archiveTabs: Array<{ key: NodeType; label: string }> = [
  { key: "ITEM", label: "物品" },
  { key: "BAG", label: "袋子" },
  { key: "BOX", label: "箱子" },
  { key: "WAREHOUSE", label: "仓库" },
];

export function ArchivesPage() {
  const [params, setParams] = useSearchParams();
  const requestedType = params.get("type") as NodeType | null;
  const type = archiveTabs.some((tab) => tab.key === requestedType)
    ? requestedType!
    : "ITEM";

  function changeType(nextType: string) {
    const next = new URLSearchParams(params);
    next.set("type", nextType);
    next.delete("cursor");
    setParams(next, { replace: true });
  }

  return (
    <div>
      <Tabs
        activeKey={type}
        onChange={changeType}
        items={archiveTabs}
        className="archive-tabs"
      />
      {type === "ITEM" ? <ItemsPage /> : <LocationsPage forcedType={type} />}
    </div>
  );
}
