import { useEffect, useState } from "react";

export function useWebReleaseStatus() {
  const [status, setStatus] = useState<InventoryHubWebReleaseStatus | null>(null);

  useEffect(() => {
    const bridge = window.inventoryHub;
    if (!bridge?.getWebReleaseStatus) return;
    let active = true;
    void bridge.getWebReleaseStatus().then((value) => {
      if (active) setStatus(value);
    }).catch(() => undefined);
    const unsubscribe = bridge.onWebReleaseStatus?.((value) => {
      if (active) setStatus(value);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return status;
}

export function reportWebReleaseReady(): void {
  void window.inventoryHub?.reportWebReleaseReady?.().catch(() => undefined);
}
