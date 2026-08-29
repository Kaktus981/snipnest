import {
  DEFAULT_SETTINGS,
  type DraftVersion,
  type FieldContext,
  type Settings,
  type Snippet,
  type Suggestion
} from "./types";

const SENSITIVE_TERMS = [
  "password",
  "passwd",
  "passcode",
  "otp",
  "one-time",
  "verification",
  "captcha",
  "credit card",
  "card number",
  "cvv",
  "cvc",
  "bank account",
  "routing number",
  "social security",
  "ssn",
  "身份证",
  "护照",
  "银行卡",
  "信用卡",
  "安全码",
  "验证码",
  "支付密码",
  "私钥",
  "助记词",
  "医疗记录"
];

const SENSITIVE_URL_TERMS = [
  "checkout",
  "payment",
  "pay/",
  "bank",
  "wallet",
  "security",
  "verify-identity",
  "支付",
  "收银台"
];

export interface FieldMeta {
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  autocomplete?: string;
  disabled?: boolean;
  readOnly?: boolean;
}

/**
 * Chrome/Edge match patterns do not accept ports. Host permissions therefore
 * use scheme + hostname, while SnipNest still keeps its own grant keyed by
 * the full origin (including a non-default port).
 */
export function hostPermissionPattern(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只支持 http 或 https 网站");
  }
  return `${url.protocol}//${url.hostname}/*`;
}

export function isLikelySensitiveField(meta: FieldMeta): boolean {
  const type = (meta.type ?? "").toLowerCase();
  if (["password", "hidden", "file"].includes(type) || meta.disabled || meta.readOnly) {
    return true;
  }

  const autocomplete = (meta.autocomplete ?? "").toLowerCase();
  if (
    autocomplete.includes("cc-") ||
    autocomplete.includes("one-time-code") ||
    autocomplete.includes("current-password") ||
    autocomplete.includes("new-password")
  ) {
    return true;
  }

  const haystack = [meta.name, meta.id, meta.label, meta.ariaLabel, meta.placeholder]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return SENSITIVE_TERMS.some((term) => haystack.includes(term));
}

export function isLikelySensitiveUrl(url: string): boolean {
  const value = url.toLowerCase();
  return SENSITIVE_URL_TERMS.some((term) => value.includes(term));
}

export function normalizePathname(pathname: string): string {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return clean
    .split("/")
    .map((part) => (/^\d{3,}$/.test(part) || /^[a-f0-9-]{16,}$/i.test(part) ? ":id" : part))
    .join("/");
}

export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function makeFieldFingerprint(
  context: Omit<FieldContext, "fingerprint">
): string {
  const parts = [
    context.origin,
    normalizePathname(context.pathname),
    context.label,
    context.ariaLabel,
    context.placeholder,
    context.name,
    context.inputType,
    context.domHint
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|");
  return `field_${stableHash(parts)}`;
}

export function trimVersions(versions: DraftVersion[], maxVersions: number): DraftVersion[] {
  return [...versions].sort((a, b) => b.createdAt - a.createdAt).slice(0, maxVersions);
}

export function isDestructiveEdit(previousText: string, currentText: string): boolean {
  const before = previousText.trim().length;
  const after = currentText.trim().length;
  return before >= 20 && after <= Math.floor(before * 0.2);
}

export function normalizeSettings(input?: Partial<Settings>): Settings {
  const legacy = Boolean(input && !("draftGrouping" in input));
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    minChars: legacy ? 1 : (input?.minChars ?? DEFAULT_SETTINGS.minChars),
    draftGrouping: input?.draftGrouping ?? DEFAULT_SETTINGS.draftGrouping,
    autoSaveEnabled:
      typeof input?.autoSaveEnabled === "boolean" ? input.autoSaveEnabled : DEFAULT_SETTINGS.autoSaveEnabled
  };
}

function phrases(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const set = new Set(normalized.split(" ").filter((item) => item.length > 1));
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chunk = match[0];
    set.add(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      set.add(chunk.slice(index, index + 2));
    }
  }
  return set;
}

export function scoreSnippet(field: FieldContext, snippet: Snippet): Suggestion {
  const fieldPrimary = [field.label, field.ariaLabel, field.placeholder, field.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const pageContext = field.pageTitle.toLowerCase();
  const snippetPrimary = [snippet.title, snippet.category, ...snippet.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const fieldTokens = phrases(`${fieldPrimary} ${pageContext}`);
  const snippetTokens = phrases(snippetPrimary);
  const reasons: string[] = [];
  let score = 0;

  if (snippet.title.length > 1 && fieldPrimary.includes(snippet.title.toLowerCase())) {
    score += 70;
    reasons.push("输入框名称相符");
  }
  if (snippet.category && pageContext.includes(snippet.category.toLowerCase())) {
    score += 18;
    reasons.push("页面场景相符");
  }

  const overlaps = [...snippetTokens].filter((token) => fieldTokens.has(token));
  if (overlaps.length > 0) {
    score += Math.min(45, overlaps.length * 9);
    reasons.push(`匹配：${overlaps.slice(0, 3).join("、")}`);
  }

  if (field.maxLength && snippet.content.length <= field.maxLength) {
    score += 4;
    reasons.push("符合字数限制");
  }

  return { snippet, score, reasons };
}

export function rankSuggestions(field: FieldContext, snippets: Snippet[]): Suggestion[] {
  return snippets
    .map((snippet) => scoreSnippet(field, snippet))
    .filter((suggestion) => suggestion.score >= 18)
    .sort((a, b) => b.score - a.score || b.snippet.useCount - a.snippet.useCount)
    .slice(0, 3);
}
