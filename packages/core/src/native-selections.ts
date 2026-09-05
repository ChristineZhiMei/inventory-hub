import { resolve } from "node:path";

interface MediaSelection { path: string; expiresAt: number }
const selections = new Map<string, MediaSelection>();

export const registerMediaSelection = (token: string, path: string, expiresAt: number): void => {
  if (!token || !path || expiresAt <= Date.now()) return;
  selections.set(token, { path: resolve(path), expiresAt });
};

export const consumeMediaSelection = (token: string): string | undefined => {
  const selection = selections.get(token);
  selections.delete(token);
  if (!selection || selection.expiresAt <= Date.now()) return undefined;
  return selection.path;
};

export const resolveMediaSelection = (token: string): string | undefined => {
  const selection = selections.get(token);
  if (!selection || selection.expiresAt <= Date.now()) {
    selections.delete(token);
    return undefined;
  }
  return selection.path;
};

export const inspectMediaSelection = (token: string): { valid: boolean; expiresAt?: string } => {
  const selection = selections.get(token);
  if (!selection || selection.expiresAt <= Date.now()) {
    selections.delete(token);
    return { valid: false };
  }
  return { valid: true, expiresAt: new Date(selection.expiresAt).toISOString() };
};
