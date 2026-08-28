import type { Draft, DraftGrouping } from "./types";

export interface DraftGroup {
  key: string;
  label: string;
  drafts: Draft[];
}

export function draftFieldName(draft: Draft): string {
  const field = draft.field;
  return field.label || field.ariaLabel || field.placeholder || field.name || "未命名长文本字段";
}

export function isShortDraft(draft: Draft): boolean {
  const length = draft.latestText.trim().length;
  return length >= 1 && length <= 9;
}

function dateBucket(updatedAt: number, now: number): { key: string; label: string; order: number } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (updatedAt >= start) return { key: "today", label: "今天", order: 0 };
  if (updatedAt >= start - day) return { key: "yesterday", label: "昨天", order: 1 };
  if (updatedAt >= start - 7 * day) return { key: "week", label: "近7天", order: 2 };
  return { key: "older", label: "更早", order: 3 };
}

export function groupDrafts(
  drafts: Draft[],
  grouping: DraftGrouping,
  now = Date.now()
): DraftGroup[] {
  const groups = new Map<string, { label: string; order: number; drafts: Draft[] }>();
  drafts.forEach((draft) => {
    let key: string;
    let label: string;
    let order = Number.MAX_SAFE_INTEGER;
    if (grouping === "date") {
      const bucket = dateBucket(draft.updatedAt, now);
      key = bucket.key;
      label = bucket.label;
      order = bucket.order;
    } else if (grouping === "field") {
      label = draftFieldName(draft);
      key = label.toLocaleLowerCase("zh-CN");
    } else {
      try {
        label = new URL(draft.origin).host;
      } catch {
        label = draft.origin;
      }
      key = draft.origin;
    }
    const existing = groups.get(key) ?? { label, order, drafts: [] };
    existing.drafts.push(draft);
    existing.order = Math.min(existing.order, order);
    groups.set(key, existing);
  });

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      drafts: group.drafts.sort((a, b) => b.updatedAt - a.updatedAt),
      order: group.order
    }))
    .sort((a, b) => a.order - b.order || b.drafts[0].updatedAt - a.drafts[0].updatedAt)
    .map(({ order: _order, ...group }) => group);
}
