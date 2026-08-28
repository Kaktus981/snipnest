import type {
  Draft,
  DestructiveEditPayload,
  DraftUpdatePayload,
  ExportPayload,
  Settings,
  Snippet
} from "./types";
import { trimVersions } from "./logic";

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

export function openDatabase(): Promise<IDBDatabase> {
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
