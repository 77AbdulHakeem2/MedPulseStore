export interface AdminBotButtonItem {
  id: number;
  parentId: number | null;
  code: string;
  labelAr: string;
  labelEn: string;
  iconEmoji: string;
  iconCustomEmojiId: string | null;
  buttonStyle: string | null;
  actionType: string;
  actionValue: string;
  contentAr: string;
  contentEn: string;
  rowOrder: number;
  colOrder: number;
  buttonsPerRow: number;
  isVisible: boolean;
  isEnabled: boolean;
}

export interface ButtonTreeNode {
  button: AdminBotButtonItem;
  children: ButtonTreeNode[];
}

export function sortButtonsByLayout<T extends { rowOrder: number; colOrder: number; id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.rowOrder - b.rowOrder || a.colOrder - b.colOrder || a.id - b.id);
}

/**
 * Builds a clean parent -> children tree from flat bot_menu_buttons rows.
 * Any orphaned button whose parentId no longer exists is safely promoted to root so it is never lost.
 */
export function buildButtonHierarchy(buttons: AdminBotButtonItem[]): ButtonTreeNode[] {
  const sorted = sortButtonsByLayout(buttons);
  const byId = new Map<number, ButtonTreeNode>();
  for (const btn of sorted) {
    byId.set(btn.id, { button: btn, children: [] });
  }

  const roots: ButtonTreeNode[] = [];
  for (const btn of sorted) {
    const node = byId.get(btn.id)!;
    if (btn.parentId && btn.parentId !== btn.id && byId.has(btn.parentId)) {
      byId.get(btn.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Computes all descendant button IDs (inclusive) to prevent circular parenting and support cascade previews.
 */
export function collectDescendantButtonIds(buttons: AdminBotButtonItem[], rootId: number): number[] {
  const result: number[] = [];
  const visited = new Set<number>();
  const queue: number[] = [rootId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    for (const b of buttons) {
      if (b.parentId === current && !visited.has(b.id)) {
        queue.push(b.id);
      }
    }
  }
  return result;
}

/**
 * Builds breadcrumb trail from root down to the selected button ID.
 */
export function buildButtonBreadcrumb(buttons: AdminBotButtonItem[], targetId: number | null): AdminBotButtonItem[] {
  if (!targetId) return [];
  const byId = new Map(buttons.map((b) => [b.id, b]));
  const chain: AdminBotButtonItem[] = [];
  const seen = new Set<number>();
  let curr = byId.get(targetId);

  while (curr && !seen.has(curr.id)) {
    seen.add(curr.id);
    chain.unshift(curr);
    curr = curr.parentId ? byId.get(curr.parentId) : undefined;
  }
  return chain;
}

/**
 * Groups visible sibling buttons into Telegram Inline Keyboard preview rows honoring rowOrder & buttonsPerRow.
 */
export function buildInlinePreviewRows(buttons: AdminBotButtonItem[]): AdminBotButtonItem[][] {
  const visible = sortButtonsByLayout(buttons.filter((b) => b.isVisible));
  const rowMap = new Map<number, AdminBotButtonItem[]>();
  for (const btn of visible) {
    const list = rowMap.get(btn.rowOrder) || [];
    list.push(btn);
    rowMap.set(btn.rowOrder, list);
  }

  const rows: AdminBotButtonItem[][] = [];
  const sortedRowOrders = Array.from(rowMap.keys()).sort((a, b) => a - b);
  for (const rOrder of sortedRowOrders) {
    const items = rowMap.get(rOrder) || [];
    const maxCols = Math.max(1, Math.min(3, items[0]?.buttonsPerRow || 2));
    for (let i = 0; i < items.length; i += maxCols) {
      rows.push(items.slice(i, i + maxCols));
    }
  }
  return rows;
}

export interface SubMenuPreviewTile {
  key: string;
  kind: 'category' | 'guide' | 'custom_button';
  entityId: number;
  label: string;
  buttonStyle: string | null;
  isEnabled: boolean;
  orderIndex: number;
  groupSize: number;
  subCount: number;
}

export interface SubMenuPreviewCategoryInput {
  id: number;
  nameAr: string;
  nameEn: string;
  iconEmoji: string;
  buttonStyle: string | null;
  sortOrder: number;
  isActive: boolean;
  showInStore: boolean;
}

export interface SubMenuPreviewGuideInput {
  id: number;
  titleAr: string;
  titleEn: string;
  iconEmoji: string;
  sortOrder: number;
  isVisible: boolean;
}

/**
 * Builds the exact Telegram Inline Keyboard rows for the Live Sub-Buttons Preview Screen,
 * matching Telegram's customer rendering for Store (c:store), Guides (c:guides), and Custom Submenus (c:btn:<id>).
 */
export function buildSubMenuPreviewRows(params: {
  isStoreButton: boolean;
  isGuidesButton: boolean;
  categories: SubMenuPreviewCategoryInput[];
  guides: SubMenuPreviewGuideInput[];
  customChildren: AdminBotButtonItem[];
  lang: 'ar' | 'en';
  childCountsByButtonId?: Map<number, number>;
}): SubMenuPreviewTile[][] {
  const { isStoreButton, isGuidesButton, categories, guides, customChildren, lang, childCountsByButtonId } = params;
  const rows: SubMenuPreviewTile[][] = [];

  if (isStoreButton) {
    const visibleCats = [...categories]
      .filter((c) => c.isActive && c.showInStore)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const catTiles: SubMenuPreviewTile[] = visibleCats.map((c, idx) => {
      const name = lang === 'en' ? c.nameEn || c.nameAr : c.nameAr || c.nameEn;
      const prefix = c.iconEmoji ? `${c.iconEmoji} ` : '';
      return {
        key: `cat-${c.id}`,
        kind: 'category',
        entityId: c.id,
        label: `${prefix}${name}`,
        buttonStyle: c.buttonStyle || 'primary',
        isEnabled: true,
        orderIndex: idx,
        groupSize: visibleCats.length,
        subCount: 0,
      };
    });
    for (let i = 0; i < catTiles.length; i += 2) {
      rows.push(catTiles.slice(i, i + 2));
    }
  } else if (isGuidesButton) {
    const visibleGuides = [...guides]
      .filter((g) => g.isVisible)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const guideTiles: SubMenuPreviewTile[] = visibleGuides.map((g, idx) => {
      const title = lang === 'en' ? g.titleEn || g.titleAr : g.titleAr || g.titleEn;
      const prefix = g.iconEmoji ? `${g.iconEmoji} ` : '';
      return {
        key: `guide-${g.id}`,
        kind: 'guide',
        entityId: g.id,
        label: `${prefix}${title}`,
        buttonStyle: 'primary',
        isEnabled: true,
        orderIndex: idx,
        groupSize: visibleGuides.length,
        subCount: 0,
      };
    });
    for (let i = 0; i < guideTiles.length; i += 2) {
      rows.push(guideTiles.slice(i, i + 2));
    }
  }

  const visibleCustom = sortButtonsByLayout(customChildren.filter((b) => b.isVisible));
  const customIndexById = new Map(visibleCustom.map((b, idx) => [b.id, idx]));
  const customRows = buildInlinePreviewRows(customChildren);
  for (const r of customRows) {
    rows.push(
      r.map((btn) => ({
        key: `btn-${btn.id}`,
        kind: 'custom_button',
        entityId: btn.id,
        label: lang === 'en' ? btn.labelEn || btn.labelAr : btn.labelAr || btn.labelEn,
        buttonStyle: btn.buttonStyle,
        isEnabled: btn.isEnabled,
        orderIndex: customIndexById.get(btn.id) ?? 0,
        groupSize: visibleCustom.length,
        subCount: childCountsByButtonId?.get(btn.id) || 0,
      }))
    );
  }

  return rows;
}

/**
 * Deterministic swap reorder for sortOrder-based sub-buttons (Store Categories & Service Guides).
 * Normalizes sequential sortOrder values (10, 20, 30, ...) so duplicate default sortOrders never block movement.
 * When `isVisibleFn` is provided (e.g. from the Live Preview screen), swaps directly with the adjacent VISIBLE item
 * so hidden items never cause an apparent no-op move.
 */
export function computeSwappedSortOrderUpdates<T extends { id: number; sortOrder: number }>(
  items: T[],
  targetId: number,
  direction: 'up' | 'down',
  isVisibleFn?: (item: T) => boolean
): {
  updates: Array<{ id: number; sortOrder: number }>;
  fromPos: number;
  toPos: number;
  swappedWithId: number;
} | null {
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const idx = sorted.findIndex((i) => i.id === targetId);
  if (idx === -1) return null;

  let targetIdx = -1;
  if (isVisibleFn) {
    const step = direction === 'up' ? -1 : 1;
    for (let j = idx + step; j >= 0 && j < sorted.length; j += step) {
      if (isVisibleFn(sorted[j])) {
        targetIdx = j;
        break;
      }
    }
  } else {
    targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  }
  if (targetIdx < 0 || targetIdx >= sorted.length) return null;

  const swappedWithId = sorted[targetIdx].id;
  const reordered = [...sorted];
  const temp = reordered[idx];
  reordered[idx] = reordered[targetIdx];
  reordered[targetIdx] = temp;

  let fromPos = idx + 1;
  let toPos = targetIdx + 1;
  if (isVisibleFn) {
    const visibleBefore = sorted.filter(isVisibleFn);
    const visibleAfter = reordered.filter(isVisibleFn);
    fromPos = visibleBefore.findIndex((x) => x.id === targetId) + 1;
    toPos = visibleAfter.findIndex((x) => x.id === targetId) + 1;
  }

  return {
    updates: reordered.map((item, i) => ({ id: item.id, sortOrder: (i + 1) * 10 })),
    fromPos,
    toPos,
    swappedWithId,
  };
}

/**
 * Deterministic swap reorder for layout-based bot_menu_buttons (both Main Buttons and Nested Sub-Buttons).
 * Preserves existing row/column slot shapes and swaps the target button with its immediate neighbor cleanly.
 * When `visibleOnly` is true, swaps directly with the adjacent visible sibling so the live preview moves on every click.
 */
export function computeSwappedButtonLayoutUpdates(
  siblings: AdminBotButtonItem[],
  targetId: number,
  direction: 'up' | 'down',
  visibleOnly = false
): {
  updates: Array<{ id: number; rowOrder: number; colOrder: number }>;
  fromPos: number;
  toPos: number;
  swappedWithId: number;
} | null {
  const sorted = sortButtonsByLayout(siblings);
  const idx = sorted.findIndex((b) => b.id === targetId);
  if (idx === -1) return null;

  let targetIdx = -1;
  if (visibleOnly) {
    const step = direction === 'up' ? -1 : 1;
    for (let j = idx + step; j >= 0 && j < sorted.length; j += step) {
      if (sorted[j].isVisible) {
        targetIdx = j;
        break;
      }
    }
  } else {
    targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  }
  if (targetIdx < 0 || targetIdx >= sorted.length) return null;

  // Assign deterministic unique (rowOrder, colOrder) slots reflecting current visual layout
  const slots: Array<{ rowOrder: number; colOrder: number }> = [];
  let lastRow = 0;
  let colInRow = 0;
  for (const btn of sorted) {
    const r = Math.max(1, btn.rowOrder);
    if (r !== lastRow) {
      lastRow = r;
      colInRow = 1;
    } else {
      colInRow += 1;
    }
    slots.push({ rowOrder: r, colOrder: colInRow });
  }

  const swappedWithId = sorted[targetIdx].id;
  const reordered = [...sorted];
  const temp = reordered[idx];
  reordered[idx] = reordered[targetIdx];
  reordered[targetIdx] = temp;

  const updates = reordered.map((btn, i) => ({
    id: btn.id,
    rowOrder: slots[i].rowOrder,
    colOrder: slots[i].colOrder,
  }));

  let fromPos = idx + 1;
  let toPos = targetIdx + 1;
  if (visibleOnly) {
    const visBefore = sorted.filter((b) => b.isVisible);
    const visAfter = reordered.filter((b) => b.isVisible);
    fromPos = visBefore.findIndex((b) => b.id === targetId) + 1;
    toPos = visAfter.findIndex((b) => b.id === targetId) + 1;
  }

  return {
    updates,
    fromPos,
    toPos,
    swappedWithId,
  };
}

