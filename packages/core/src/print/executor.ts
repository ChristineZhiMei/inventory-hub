export interface LabelPrintPayload {
  itemId: string;
  attemptNo: number;
  claimToken: string;
  printerId: string;
  png: Buffer;
  paper: { widthMm: number; heightMm: number; orientation: "portrait" | "landscape" };
}

export interface LabelPrintEvidence {
  state: "SUBMITTED" | "FAILED" | "UNKNOWN";
  osJobId?: string;
  message?: string;
}

export interface LabelPrintExecutor {
  readonly kind: "simulator" | "os-driver";
  isPrinterReady(printerId: string): Promise<boolean>;
  submitOne(payload: LabelPrintPayload): Promise<LabelPrintEvidence>;
}

/**
 * Deterministic software executor used until the HPRT D35 driver and paper are
 * available. Native Electron integration implements the same one-label API;
 * copies are deliberately expanded by the service and never sent as one batch.
 */
export class SimulatedLabelPrintExecutor implements LabelPrintExecutor {
  readonly kind = "simulator" as const;
  async isPrinterReady(): Promise<boolean> { return true; }
  async submitOne(payload: LabelPrintPayload): Promise<LabelPrintEvidence> {
    return { state: "SUBMITTED", osJobId: `sim-${payload.itemId}-${payload.attemptNo}` };
  }
}
