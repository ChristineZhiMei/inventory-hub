import type { Category } from "@/lib/types";

export interface CategoryTreeRow {
  category: Category;
  depth: number;
}

const categoryNameCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export function buildCategoryTreeRows(categories: Category[]): CategoryTreeRow[] {
  const categoryIds = new Set(categories.map((category) => category.id));
  const childrenByParent = new Map<string | null, Category[]>();
  for (const category of categories) {
    const parentId = category.parentId && categoryIds.has(category.parentId)
      ? category.parentId
      : null;
    const siblings = childrenByParent.get(parentId) || [];
    siblings.push(category);
    childrenByParent.set(parentId, siblings);
  }
  for (const siblings of childrenByParent.values())
    siblings.sort((left, right) => categoryNameCollator.compare(left.name, right.name));

  const rows: CategoryTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (category: Category, depth: number) => {
    if (visited.has(category.id)) return;
    visited.add(category.id);
    rows.push({ category, depth });
    for (const child of childrenByParent.get(category.id) || []) visit(child, depth + 1);
  };

  for (const root of childrenByParent.get(null) || []) visit(root, 0);
  // Defensive fallback: keep malformed or cyclic records visible instead of silently losing them.
  for (const category of categories) if (!visited.has(category.id)) visit(category, 0);
  return rows;
}
