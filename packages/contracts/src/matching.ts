import { z } from "zod";

const optionIds = z.array(z.string().uuid()).max(100).transform((ids) => [...new Set(ids)]);

export const MatchingSlotSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(120),
  notes: z.string().max(2000),
  type: z.enum(["ITEM", "BAG", "BOX", "WAREHOUSE"]),
  mode: z.enum(["CONTAINS", "EXACT", "ANY"]),
  categoryIds: optionIds,
  tagIds: optionIds,
  specificationIds: optionIds,
  display: z.enum(["LARGE", "DETAIL"]),
  locked: z.boolean(),
}).strict();
export type MatchingSlotConfig = z.infer<typeof MatchingSlotSchema>;

export const MatchingGroupConfigSchema = z.object({
  name: z.string().max(120),
  notes: z.string().max(2000),
  slots: z.array(MatchingSlotSchema).max(100),
}).strict().refine((group) => new Set(group.slots.map((slot) => slot.id)).size === group.slots.length, {
  message: "列表项编号不能重复", path: ["slots"],
});
export type MatchingGroupConfig = z.infer<typeof MatchingGroupConfigSchema>;

export const MatchingGroupUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  config: MatchingGroupConfigSchema,
}).strict();

export const MatchingActionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  action: z.enum(["RANDOM", "PREVIOUS"]),
  slotId: z.string().uuid().optional(),
}).strict();
