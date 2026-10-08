export * from "./ai.js";
export * from "./matching.js";
import { ITEM_CATEGORY_LIMIT } from "./ai.js";
import { z } from "zod";
export * from "./label.js";

export const NodeTypeSchema = z.enum(["WAREHOUSE", "BOX", "BAG", "ITEM"]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const StockStatusSchema = z.enum(["IN_STOCK", "OUT", "DISCARDED"]);
export type StockStatus = z.infer<typeof StockStatusSchema>;

export const InventoryActionSchema = z.enum([
  "MOVE",
  "REMOVE",
  "CHECK_OUT",
  "CHECK_IN",
  "DISCARD",
  "RESTORE",
]);
export type InventoryAction = z.infer<typeof InventoryActionSchema>;

export const PrintItemStateSchema = z.enum([
  "QUEUED",
  "SENDING",
  "SUBMITTED",
  "FAILED",
  "UNKNOWN",
  "CANCELLED",
]);
export type PrintItemState = z.infer<typeof PrintItemStateSchema>;

export const ErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "INVALID_CODE",
  "INVALID_PARENT_TYPE",
  "IMAGE_REQUIRED",
  "IMAGE_LIMIT",
  "UNAUTHENTICATED",
  "CSRF_INVALID",
  "DESKTOP_ONLY",
  "NOT_FOUND",
  "NODE_DELETED",
  "VERSION_CONFLICT",
  "LOCATION_CHANGED",
  "SUBTREE_CHANGED",
  "INVALID_STATE",
  "NONEMPTY_CONTAINER",
  "SYSTEM_NODE_PROTECTED",
  "REFERENCE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_RUNNING",
  "REQUEST_PREPARATION_EXPIRED",
  "UPLOAD_ALREADY_ATTACHED",
  "FILE_TOO_LARGE",
  "PIXEL_LIMIT",
  "UNSUPPORTED_IMAGE",
  "RATE_LIMITED",
  "PROCESSING_BUSY",
  "STORAGE_OFFLINE",
  "MAINTENANCE",
  "DB_UNAVAILABLE",
  "DATABASE_BUSY",
  "EXECUTOR_OFFLINE",
  "DATA_INTEGRITY_ERROR",
  "MEDIA_MISSING",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const IdSchema = z.string().uuid();
export const RequestIdSchema = z.string().uuid();
export const CodeSchema = z.string().trim().toUpperCase().regex(/^(W|C|I)[0-9]{6,}$/);
export const NameSchema = z.string().trim().min(1).max(120);
export const NotesSchema = z.string().trim().max(2000);

export const CreateNodeSchema = z.object({
  type: NodeTypeSchema,
  name: NameSchema,
  notes: NotesSchema.optional().default(""),
  tagIds: z.array(IdSchema).default([]),
  categoryId: IdSchema.optional(),
  categoryIds: z.array(IdSchema).max(ITEM_CATEGORY_LIMIT).default([]),
  specification: z.string().trim().max(500).optional().default(""),
  specificationIds: z.array(IdSchema).default([]),
  uploadIds: z.array(IdSchema).max(5).default([]),
  createMode: z.enum(["STAGE", "PLACE"]),
  targetId: IdSchema.optional(),
  targetLocationToken: z.string().min(1).optional(),
  initialContent: z.object({
    nodeId: IdSchema,
    expectedLocationVersion: z.number().int().positive(),
    locationToken: z.string().min(1),
    subtreeToken: z.string().min(1).optional(),
  }).optional(),
}).superRefine((value, context) => {
  if (value.type === "ITEM" && value.categoryIds.length === 0 && !value.categoryId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["categoryIds"], message: "物品必须至少选择一个分类" });
  }
  if (value.type === "WAREHOUSE" && (value.createMode !== "STAGE" || value.targetId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["createMode"], message: "仓库必须创建为根节点" });
  }
  if (value.createMode === "PLACE" && !value.targetId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetId"], message: "放置模式必须选择目标位置" });
  }
  if (value.createMode === "PLACE" && !value.targetLocationToken) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetLocationToken"], message: "放置模式必须携带目标位置令牌" });
  }
  if (value.type === "ITEM" && value.initialContent) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["initialContent"], message: "物品不能包含其他档案" });
  }
});
export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;

export const ImageSetEntrySchema = z.union([
  z.object({ imageId: IdSchema }),
  z.object({ uploadId: IdSchema }),
]);

export const PatchProfileSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: NameSchema.optional(),
  notes: NotesSchema.optional(),
  tagIds: z.array(IdSchema).optional(),
  categoryId: IdSchema.optional(),
  categoryIds: z.array(IdSchema).max(ITEM_CATEGORY_LIMIT).optional(),
  specification: z.string().trim().max(500).optional(),
  specificationIds: z.array(IdSchema).optional(),
  images: z.array(ImageSetEntrySchema).min(0).max(5).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
  message: "至少提供一个待更新字段",
});
export type PatchProfileInput = z.infer<typeof PatchProfileSchema>;

export const OperationTargetSchema = z.object({
  nodeId: IdSchema,
  expectedLocationVersion: z.number().int().positive().optional(),
  locationToken: z.string().optional(),
  subtreeToken: z.string().optional(),
});

export const OperationInputSchema = z.object({
  action: InventoryActionSchema,
  targets: z.array(OperationTargetSchema).min(1).max(100),
  targetId: IdSchema.optional(),
  targetLocationToken: z.string().optional(),
  reason: z.string().trim().max(500).optional(),
  reversesOperationId: IdSchema.optional(),
}).superRefine((value, context) => {
  if (value.action === "MOVE" && !value.targetId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetId"], message: "移位必须选择目标" });
  }
  if (["CHECK_OUT", "DISCARD"].includes(value.action) && value.targetId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetId"], message: "该动作不接受目标位置" });
  }
});
export type OperationInput = z.infer<typeof OperationInputSchema>;

export const DeleteNodeSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedLocationVersion: z.number().int().positive(),
  locationToken: z.string().min(1),
  confirmCode: CodeSchema,
});

export const UploadInitSchema = z.object({
  clientUploadId: IdSchema,
  filename: z.string().trim().min(1).max(255),
  byteLength: z.number().int().positive().max(25 * 1024 * 1024),
  declaredMime: z.enum(["image/jpeg", "image/png", "image/webp"]),
});
export type UploadInitInput = z.infer<typeof UploadInitSchema>;

export const PrintCreateSchema = z.object({
  executorId: z.string().trim().min(1).max(120).default("local-simulator"),
  printerId: z.string().trim().min(1).max(120).default("hprt-d35"),
  nodeIds: z.array(IdSchema).min(1).max(100).transform((ids) => [...new Set(ids)]),
  templateId: z.string().trim().min(1).max(120).default("d35-default"),
  copies: z.number().int().min(1).max(20).default(1),
});
export type PrintCreateInput = z.infer<typeof PrintCreateSchema>;

export interface ApiMeta {
  requestId: string;
  serverTime: string;
  nextCursor?: string | null;
}

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  error: {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string[]>;
    details?: unknown;
    retryable: boolean;
  };
  meta: { requestId: string };
}

export const isContainerType = (type: NodeType): boolean => type === "BOX" || type === "BAG";

export const isAllowedParent = (child: NodeType, parent: NodeType): boolean => {
  if (child === "BOX") return parent === "WAREHOUSE";
  if (child === "BAG") return parent === "WAREHOUSE" || parent === "BOX";
  if (child === "ITEM") return parent === "WAREHOUSE" || parent === "BOX" || parent === "BAG";
  return false;
};
