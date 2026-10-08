import { AI_FIELDS, type AiField } from "@inventory-hub/contracts";
const DEFAULTS_KEY = "inventory-hub:ai-default-fields";
export function readAiDefaults(): AiField[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "null");
    if (Array.isArray(saved)) return AI_FIELDS.filter((field) => saved.includes(field));
  } catch { /* Use all fields when storage is unavailable or malformed. */ }
  return [...AI_FIELDS];
}
export function saveAiDefaults(fields: AiField[]) { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(fields)); }
// A tab-local identity survives item navigation and isolates concurrent browser tabs.
export const aiClientId = crypto.randomUUID();
