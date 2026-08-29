import type {
  Draft,
  DestructiveEditPayload,
  DraftUpdatePayload,
  ExportPayload,
  FieldContext,
  ImportSummary,
  Settings,
  Snippet
} from "./types";
import { normalizeSettings, trimVersions } from "./logic";

// Legacy storage name is intentionally retained so upgrades keep every user's local drafts.
const DB_NAME = "draftvault";
const DB_VERSION = 1;
const DRAFTS = "drafts";
const SNIPPETS = "snippets";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFTS)) {
        const drafts = database.createObjectStore(DRAFTS, { keyPath: "id" });
        drafts.createIndex("origin", "origin", { unique: false });
        drafts.createIndex("expiresAt", "expiresAt", { unique: false });
        drafts.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(SNIPPETS)) {
        const snippets = database.createObjectStore(SNIPPETS, { keyPath: "id" });
        snippets.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function upsertDraft(
  payload: DraftUpdatePayload,
  settings: Settings,
  now = Date.now()
): Promise<Draft> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  const existing = (await requestResult(store.get(payload.id))) as Draft | undefined;
  if (existing?.latestText === payload.text) {
    await transactionDone(transaction);
    database.close();
    return existing;
  }
  const expiresAt = now + settings.retentionDays * 24 * 60 * 60 * 1000;
  const versions = existing?.versions ? [...existing.versions] : [];

  if (payload.checkpoint && versions[0]?.text !== payload.text) {
    versions.unshift({
      id: `version_${now}_${Math.random().toString(36).slice(2, 8)}`,
      text: payload.text,
      charCount: payload.text.length,
      createdAt: now
    });
  }

  const draft: Draft = {
    id: payload.id,
    origin: payload.field.origin,
    pathname: payload.field.pathname,
    pageUrl: payload.field.pageUrl,
    pageTitle: payload.field.pageTitle,
    field: payload.field,
    latestText: payload.text,
    versions: trimVersions(versions, settings.maxVersions),
    recovery: existing?.recovery,
    status: existing?.status ?? "temporary",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    expiresAt: existing?.status === "extended" ? Math.max(existing.expiresAt, expiresAt) : expiresAt
  };

  store.put(draft);
  await transactionDone(transaction);
  database.close();
  return draft;
}

export async function protectDraftRecovery(
  payload: DestructiveEditPayload,
  settings: Settings,
  now = Date.now()
): Promise<Draft> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  const existing = (await requestResult(store.get(payload.id))) as Draft | undefined;
  const expiresAt = now + settings.retentionDays * 24 * 60 * 60 * 1000;
  const draft: Draft = {
    id: payload.id,
    origin: payload.field.origin,
    pathname: payload.field.pathname,
    pageUrl: payload.field.pageUrl,
    pageTitle: payload.field.pageTitle,
    field: payload.field,
    latestText: existing?.latestText ?? payload.previousText,
    versions: existing?.versions ?? [],
    recovery: {
      text: payload.previousText,
      createdAt: now,
      beforeCharCount: payload.previousText.trim().length,
      afterCharCount: payload.currentText.trim().length
    },
    status: existing?.status ?? "temporary",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    expiresAt: existing?.status === "extended" ? Math.max(existing.expiresAt, expiresAt) : expiresAt
  };
  store.put(draft);
  await transactionDone(transaction);
  database.close();
  return draft;
}

export async function dismissDraftRecovery(id: string): Promise<Draft | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  const existing = (await requestResult(store.get(id))) as Draft | undefined;
  if (!existing) {
    await transactionDone(transaction);
    database.close();
    return undefined;
  }
  const { recovery: _recovery, ...rest } = existing;
  const updated = { ...rest, updatedAt: Date.now() } as Draft;
  store.put(updated);
  await transactionDone(transaction);
  database.close();
  return updated;
}

export async function getDraft(id: string): Promise<Draft | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readonly");
  const value = (await requestResult(transaction.objectStore(DRAFTS).get(id))) as Draft | undefined;
  await transactionDone(transaction);
  database.close();
  return value;
}

export async function listDrafts(origin?: string): Promise<Draft[]> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readonly");
  const store = transaction.objectStore(DRAFTS);
  const values = origin
    ? ((await requestResult(store.index("origin").getAll(origin))) as Draft[])
    : ((await requestResult(store.getAll())) as Draft[]);
  await transactionDone(transaction);
  database.close();
  return values.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDraft(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  transaction.objectStore(DRAFTS).delete(id);
  await transactionDone(transaction);
  database.close();
}

export async function deleteDrafts(ids: string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return 0;
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  uniqueIds.forEach((id) => store.delete(id));
  await transactionDone(transaction);
  database.close();
  return uniqueIds.length;
}

export async function extendDraft(id: string, now = Date.now()): Promise<Draft | undefined> {
  const draft = await getDraft(id);
  if (!draft) return undefined;
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const updated: Draft = {
    ...draft,
    status: "extended",
    updatedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000
  };
  transaction.objectStore(DRAFTS).put(updated);
  await transactionDone(transaction);
  database.close();
  return updated;
}

export async function extendDrafts(ids: string[], now = Date.now()): Promise<number> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return 0;
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  let changed = 0;
  for (const id of uniqueIds) {
    const draft = (await requestResult(store.get(id))) as Draft | undefined;
    if (!draft) continue;
    store.put({
      ...draft,
      status: "extended",
      updatedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000
    });
    changed += 1;
  }
  await transactionDone(transaction);
  database.close();
  return changed;
}

export async function saveSnippet(
  input: Partial<Snippet> & Pick<Snippet, "title" | "content">,
  now = Date.now()
): Promise<Snippet> {
  const database = await openDatabase();
  const transaction = database.transaction(SNIPPETS, "readwrite");
  const store = transaction.objectStore(SNIPPETS);
  const existing = input.id ? ((await requestResult(store.get(input.id))) as Snippet | undefined) : undefined;
  const snippet: Snippet = {
    id: input.id ?? `snippet_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title.trim(),
    content: input.content,
    category: input.category?.trim() ?? "未分类",
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    sourceDraftId: input.sourceDraftId,
    useCount: input.useCount ?? existing?.useCount ?? 0,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now
  };
  store.put(snippet);
  await transactionDone(transaction);
  database.close();
  return snippet;
}

export async function listSnippets(): Promise<Snippet[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SNIPPETS, "readonly");
  const snippets = (await requestResult(transaction.objectStore(SNIPPETS).getAll())) as Snippet[];
  await transactionDone(transaction);
  database.close();
  return snippets.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSnippet(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SNIPPETS, "readwrite");
  transaction.objectStore(SNIPPETS).delete(id);
  await transactionDone(transaction);
  database.close();
}

export async function incrementSnippetUse(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SNIPPETS, "readwrite");
  const store = transaction.objectStore(SNIPPETS);
  const snippet = (await requestResult(store.get(id))) as Snippet | undefined;
  if (snippet) {
    store.put({ ...snippet, useCount: snippet.useCount + 1, updatedAt: Date.now() });
  }
  await transactionDone(transaction);
  database.close();
}

export async function promoteDraft(
  id: string,
  title: string,
  category: string,
  tags: string[]
): Promise<Snippet | undefined> {
  const draft = await getDraft(id);
  if (!draft) return undefined;
  const snippet = await saveSnippet({
    title,
    content: draft.latestText,
    category,
    tags,
    sourceDraftId: draft.id
  });
  await deleteDraft(id);
  return snippet;
}

export async function cleanupExpired(now = Date.now()): Promise<number> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  const drafts = (await requestResult(store.getAll())) as Draft[];
  const expired = drafts.filter((draft) => draft.expiresAt <= now);
  expired.forEach((draft) => store.delete(draft.id));
  await transactionDone(transaction);
  database.close();
  return expired.length;
}

export async function clearAllData(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([DRAFTS, SNIPPETS], "readwrite");
  transaction.objectStore(DRAFTS).clear();
  transaction.objectStore(SNIPPETS).clear();
  await transactionDone(transaction);
  database.close();
}

export async function exportData(settings: Settings): Promise<ExportPayload> {
  const [drafts, snippets] = await Promise.all([listDrafts(), listSnippets()]);
  return {
    // Keep the legacy schema marker so existing backups remain compatible after the SnipNest rename.
    format: "draftvault-export",
    version: 1,
    exportedAt: Date.now(),
    drafts,
    snippets,
    settings
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function importedField(value: unknown): FieldContext | null {
  if (!isRecord(value)) return null;
  const stringKeys = [
    "origin",
    "pathname",
    "pageUrl",
    "pageTitle",
    "label",
    "ariaLabel",
    "placeholder",
    "name",
    "inputType",
    "domHint",
    "fingerprint"
  ] as const;
  if (stringKeys.some((key) => typeof value[key] !== "string")) return null;
  try {
    const origin = new URL(value.origin as string);
    if (!/^https?:$/.test(origin.protocol) || origin.origin !== value.origin) return null;
  } catch {
    return null;
  }
  if (!(value.maxLength === null || finiteNumber(value.maxLength))) return null;
  return value as unknown as FieldContext;
}

function importedDraft(value: unknown): Draft | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.latestText !== "string") return null;
  const field = importedField(value.field);
  if (!field || typeof value.origin !== "string" || value.origin !== field.origin) return null;
  if (
    typeof value.pathname !== "string" ||
    typeof value.pageUrl !== "string" ||
    typeof value.pageTitle !== "string" ||
    !Array.isArray(value.versions) ||
    !["temporary", "extended"].includes(String(value.status)) ||
    !finiteNumber(value.createdAt) ||
    !finiteNumber(value.updatedAt) ||
    !finiteNumber(value.expiresAt)
  ) return null;
  const versions = value.versions.map((version) => {
    if (
      !isRecord(version) ||
      typeof version.id !== "string" ||
      typeof version.text !== "string" ||
      !finiteNumber(version.createdAt)
    ) return null;
    return {
      id: version.id,
      text: version.text,
      charCount: version.text.length,
      createdAt: version.createdAt
    };
  });
  if (versions.some((version) => !version)) return null;
  let recovery: Draft["recovery"];
  if (value.recovery !== undefined) {
    if (
      !isRecord(value.recovery) ||
      typeof value.recovery.text !== "string" ||
      !finiteNumber(value.recovery.createdAt) ||
      !finiteNumber(value.recovery.beforeCharCount) ||
      !finiteNumber(value.recovery.afterCharCount)
    ) return null;
    recovery = {
      text: value.recovery.text,
      createdAt: value.recovery.createdAt,
      beforeCharCount: value.recovery.beforeCharCount,
      afterCharCount: value.recovery.afterCharCount
    };
  }
  return {
    id: value.id,
    origin: value.origin,
    pathname: value.pathname,
    pageUrl: value.pageUrl,
    pageTitle: value.pageTitle,
    field,
    latestText: value.latestText,
    versions: versions as Draft["versions"],
    recovery,
    status: value.status as Draft["status"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt
  };
}

function importedSnippet(value: unknown): Snippet | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.content !== "string" ||
    typeof value.category !== "string" ||
    !Array.isArray(value.tags) ||
    value.tags.some((tag) => typeof tag !== "string") ||
    !finiteNumber(value.useCount) ||
    !finiteNumber(value.createdAt) ||
    !finiteNumber(value.updatedAt)
  ) return null;
  if (value.sourceDraftId !== undefined && typeof value.sourceDraftId !== "string") return null;
  return {
    id: value.id,
    title: value.title,
    content: value.content,
    category: value.category,
    tags: [...new Set(value.tags as string[])],
    sourceDraftId: value.sourceDraftId as string | undefined,
    useCount: value.useCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function importedSettings(value: unknown, current: Settings): { settings: Settings; imported: boolean } {
  if (!isRecord(value)) return { settings: current, imported: false };
  const retentionDays = [1, 7, 30].includes(Number(value.retentionDays))
    ? Number(value.retentionDays) as 1 | 7 | 30
    : current.retentionDays;
  const minChars = finiteNumber(value.minChars) && value.minChars >= 1 ? value.minChars : current.minChars;
  const maxVersions = finiteNumber(value.maxVersions) && value.maxVersions >= 1
    ? Math.min(20, Math.floor(value.maxVersions))
    : current.maxVersions;
  const draftGrouping = ["site", "date", "field"].includes(String(value.draftGrouping))
    ? value.draftGrouping as Settings["draftGrouping"]
    : current.draftGrouping;
  return {
    settings: normalizeSettings({
      ...current,
      retentionDays,
      minChars,
      maxVersions,
      draftGrouping,
      autoSaveEnabled:
        typeof value.autoSaveEnabled === "boolean" ? value.autoSaveEnabled : current.autoSaveEnabled
    }),
    imported: true
  };
}

export async function importData(
  input: unknown,
  currentSettings: Settings,
  now = Date.now()
): Promise<{ summary: ImportSummary; settings: Settings }> {
  if (
    !isRecord(input) ||
    input.format !== "draftvault-export" ||
    input.version !== 1 ||
    !Array.isArray(input.drafts) ||
    !Array.isArray(input.snippets)
  ) {
    throw new Error("这不是文栈支持的JSON备份文件");
  }
  const drafts = input.drafts.map(importedDraft);
  const snippets = input.snippets.map(importedSnippet);
  if (drafts.some((draft) => !draft) || snippets.some((snippet) => !snippet)) {
    throw new Error("备份文件包含损坏或无法识别的数据");
  }
  const imported = importedSettings(input.settings, currentSettings);
  const summary: ImportSummary = {
    draftsAdded: 0,
    draftsUpdated: 0,
    draftsSkipped: 0,
    snippetsAdded: 0,
    snippetsUpdated: 0,
    snippetsSkipped: 0,
    settingsImported: imported.imported
  };
  const database = await openDatabase();
  const transaction = database.transaction([DRAFTS, SNIPPETS], "readwrite");
  const draftStore = transaction.objectStore(DRAFTS);
  const snippetStore = transaction.objectStore(SNIPPETS);
  for (const importedValue of drafts as Draft[]) {
    const existing = (await requestResult(draftStore.get(importedValue.id))) as Draft | undefined;
    if (existing && existing.updatedAt >= importedValue.updatedAt) {
      summary.draftsSkipped += 1;
      continue;
    }
    const retentionMs = (importedValue.status === "extended" ? 30 : imported.settings.retentionDays) * 24 * 60 * 60 * 1000;
    draftStore.put({
      ...importedValue,
      versions: trimVersions(importedValue.versions, imported.settings.maxVersions),
      expiresAt: Math.max(importedValue.expiresAt, now + retentionMs)
    });
    if (existing) summary.draftsUpdated += 1;
    else summary.draftsAdded += 1;
  }
  for (const importedValue of snippets as Snippet[]) {
    const existing = (await requestResult(snippetStore.get(importedValue.id))) as Snippet | undefined;
    if (existing && existing.updatedAt >= importedValue.updatedAt) {
      summary.snippetsSkipped += 1;
      continue;
    }
    snippetStore.put(importedValue);
    if (existing) summary.snippetsUpdated += 1;
    else summary.snippetsAdded += 1;
  }
  await transactionDone(transaction);
  database.close();
  return { summary, settings: imported.settings };
}

export async function getStats(): Promise<{ drafts: number; snippets: number; characters: number }> {
  const [drafts, snippets] = await Promise.all([listDrafts(), listSnippets()]);
  return {
    drafts: drafts.length,
    snippets: snippets.length,
    characters:
      drafts.reduce((sum, draft) => sum + draft.latestText.length, 0) +
      snippets.reduce((sum, snippet) => sum + snippet.content.length, 0)
  };
}
