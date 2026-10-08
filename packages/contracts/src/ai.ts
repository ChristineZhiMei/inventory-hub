/** Shared form limits also apply to AI results, after invalid IDs and duplicates are removed. */
export const ITEM_CATEGORY_LIMIT = 3;
export const AI_NAME_PROMPT_LIMIT = 300;
export const AI_OPTION_EXAMPLE_LIMIT = 10;
export const AI_OPTION_EXAMPLE_LENGTH = 100;
export const AI_FIELDS = ["name", "categoryIds", "specificationIds", "tagIds"] as const;
export type AiField = typeof AI_FIELDS[number];
export const AI_FIELD_LABELS: Record<AiField, string> = {
  name: "物品名称", categoryIds: "分类", specificationIds: "规格", tagIds: "标签",
};
export interface AiSettings {
  model: string;
  namePrompt: string;
  configured: boolean;
  version: number;
  endpoint: string;
  contextMaxUses: number;
}
export interface AiConnectionTestResult {
  model: string;
  elapsedMs: number;
}
export interface AiSelectionRules {
  categories: string;
  specifications: string;
  tags: string;
  version: number;
}
export interface AiOption { id: string; name: string; description: string; examples: string[]; version: number; parentId?: string | null }
export interface AiRecognitionResult {
  values: Partial<{ name: string; categoryIds: string[]; specificationIds: string[]; tagIds: string[] }>;
  options: { categories: AiOption[]; specifications: AiOption[]; tags: AiOption[] };
  warnings: string[];
  context: { id: string; version: string; useCount: number; maxUses: number };
  usage: { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null };
}
