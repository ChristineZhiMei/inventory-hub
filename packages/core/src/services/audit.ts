// Audit queries live in NodeService because they reuse node snapshots and pagination.
// This module intentionally exports the public filter shape for adapters.
export interface OperationQuery {
  nodeId?: string;
  action?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
