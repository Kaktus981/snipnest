import {
  createPendingActivation,
  isPendingActivationValid,
  permissionCoversActivation,
  type PendingSiteActivation
} from "./shared/activation";
import {
  cleanupExpired,
  clearAllData,
  deleteDraft,
  deleteDrafts,
  deleteSnippet,
  dismissDraftRecovery,
  exportData,
  extendDraft,
  extendDrafts,
  getDraft,
  getStats,
  incrementSnippetUse,
  listDrafts,
  listSnippets,
  promoteDraft,
  protectDraftRecovery,
  saveSnippet,
  upsertDraft
} from "./shared/db";
import {
  hostPermissionPattern,
  isDestructiveEdit,
  isLikelySensitiveField,
  isLikelySensitiveUrl,
  normalizeSettings,
  rankSuggestions
} from "./shared/logic";
import {
  type FieldContext,
  type RuntimeMessage,
  type Settings,
  type SiteGrant
} from "./shared/types";

const CLEANUP_ALARM = "draftvault-cleanup";
const CONTENT_SCRIPT_PREFIX = "draftvault-site-";
const PENDING_ACTIVATIONS_KEY = "pendingSiteActivations";
const activeFields = new Map<number, FieldContext>();
const siteRegistrationTasks = new Map<string, Promise<SiteGrant>>();

async function getPendingActivations(): Promise<Record<string, PendingSiteActivation>> {
  const stored = await chrome.storage.local.get(PENDING_ACTIVATIONS_KEY);
  return (stored[PENDING_ACTIVATIONS_KEY] ?? {}) as Record<string, PendingSiteActivation>;
}

async function setPendingActivations(
  activations: Record<string, PendingSiteActivation>
): Promise<void> {
  await chrome.storage.local.set({ [PENDING_ACTIVATIONS_KEY]: activations });
}

async function prepareSiteActivation(
  origin: string,
  tabId: number,
  windowId: number
): Promise<PendingSiteActivation> {
  const normalizedOrigin = new URL(origin).origin;
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId || !tab.url || new URL(tab.url).origin !== normalizedOrigin) {
    throw new Error("当前标签页已经发生变化，请重新打开文栈");
  }
  const activations = await getPendingActivations();
  const now = Date.now();
  Object.entries(activations).forEach(([key, value]) => {
    if (!isPendingActivationValid(value, now)) delete activations[key];
  });
  const activation = createPendingActivation(normalizedOrigin, tabId, windowId, now);
  activations[normalizedOrigin] = activation;
  await setPendingActivations(activations);
  return activation;
}

async function cancelSiteActivation(origin: string): Promise<void> {
  const normalizedOrigin = new URL(origin).origin;
  const activations = await getPendingActivations();
  if (!(normalizedOrigin in activations)) return;
  delete activations[normalizedOrigin];
  await setPendingActivations(activations);
}

function originPattern(origin: string): string {
  return hostPermissionPattern(origin);
}

async function tabsForOrigin(origin: string): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({ url: originPattern(origin) });
  return tabs.filter((tab) => {
    try {
      return Boolean(tab.url && new URL(tab.url).origin === origin);
    } catch {
      return false;
    }
  });
}

async function siteStatus(origin: string): Promise<{ enabled: boolean; permitted: boolean }> {
  const normalizedOrigin = new URL(origin).origin;
  const [stored, permitted, registered, activations] = await Promise.all([
    chrome.storage.local.get("siteGrants"),
    chrome.permissions.contains({ origins: [originPattern(normalizedOrigin)] }),
    chrome.scripting.getRegisteredContentScripts({ ids: [scriptId(normalizedOrigin)] }),
    getPendingActivations()
  ]);
  const grants = (stored.siteGrants ?? {}) as Record<string, SiteGrant>;
  return {
    enabled: Boolean(grants[normalizedOrigin]?.enabled && permitted && registered.length),
    permitted,
    pending: Boolean(
      activations[normalizedOrigin] && isPendingActivationValid(activations[normalizedOrigin])
    )
  } as { enabled: boolean; permitted: boolean; pending: boolean };
}

function scriptId(origin: string): string {
  let hash = 2166136261;
  for (const char of origin) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${CONTENT_SCRIPT_PREFIX}${(hash >>> 0).toString(36)}`;
}

async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get("settings");
  return normalizeSettings(result.settings as Partial<Settings> | undefined);
}

async function setGrant(origin: string, enabled: boolean): Promise<SiteGrant> {
  const result = await chrome.storage.local.get("siteGrants");
  const grants = (result.siteGrants ?? {}) as Record<string, SiteGrant>;
  const grant: SiteGrant = { origin, enabled, enabledAt: Date.now() };
  if (enabled) grants[origin] = grant;
  else delete grants[origin];
  await chrome.storage.local.set({ siteGrants: grants });
  return grant;
}

async function registerSiteNow(normalizedOrigin: string): Promise<SiteGrant> {
  const pattern = originPattern(normalizedOrigin);
  const permitted = await chrome.permissions.contains({ origins: [pattern] });
  if (!permitted) throw new Error("当前网站尚未授权");

  const id = scriptId(normalizedOrigin);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const needsRegistration =
    registered.length === 0 ||
    registered[0].matches?.length !== 1 ||
    registered[0].matches[0] !== pattern;
  if (needsRegistration) {
    if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [pattern],
        js: ["content.js"],
        runAt: "document_idle",
        persistAcrossSessions: true
      }
    ]);
  }

  // The exact-origin grant must exist before injecting the current tab because
  // the content script verifies it before observing any field.
  const grant = await setGrant(normalizedOrigin, true);
  const tabs = await tabsForOrigin(normalizedOrigin);
  await Promise.allSettled(
    tabs.map((tab) =>
      tab.id ? chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }) : null
    )
  );
  await cancelSiteActivation(normalizedOrigin);
  return grant;
}

async function registerSite(origin: string): Promise<SiteGrant> {
  const normalizedOrigin = new URL(origin).origin;
  const existingTask = siteRegistrationTasks.get(normalizedOrigin);
  if (existingTask) return existingTask;

  const task = registerSiteNow(normalizedOrigin);
  siteRegistrationTasks.set(normalizedOrigin, task);
  try {
    return await task;
  } finally {
    if (siteRegistrationTasks.get(normalizedOrigin) === task) {
      siteRegistrationTasks.delete(normalizedOrigin);
    }
  }
}

async function completePendingActivations(grantedOrigins?: string[]): Promise<void> {
  const activations = await getPendingActivations();
  const now = Date.now();
  const availableOrigins = grantedOrigins ?? (await chrome.permissions.getAll()).origins ?? [];
  let changed = false;
  for (const [origin, activation] of Object.entries(activations)) {
    if (!isPendingActivationValid(activation, now)) {
      delete activations[origin];
      changed = true;
      continue;
    }
    if (!permissionCoversActivation(activation, availableOrigins)) continue;
    try {
      await registerSite(activation.origin);
      delete activations[origin];
      changed = true;
    } catch {
      // Keep a valid activation so startup recovery can retry a transient failure.
    }
  }
  if (changed) await setPendingActivations(activations);
}

async function unregisterSite(origin: string): Promise<void> {
  await cancelSiteActivation(origin);
  const id = scriptId(origin);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  const tabs = await tabsForOrigin(origin);
  await Promise.allSettled(
    tabs.map((tab) =>
      tab.id
        ? chrome.tabs.sendMessage(tab.id, { type: "DRAFTVAULT_DISABLE" }).catch(() => undefined)
        : null
    )
  );
  await setGrant(origin, false);
  const stored = await chrome.storage.local.get("siteGrants");
  const remaining = Object.values((stored.siteGrants ?? {}) as Record<string, SiteGrant>);
  const permissionStillUsed = remaining.some(
    (grant) => grant.enabled && originPattern(grant.origin) === originPattern(origin)
  );
  if (!permissionStillUsed) {
    await chrome.permissions.remove({ origins: [originPattern(origin)] });
  }
}

async function restoreRegisteredSites(): Promise<void> {
  const result = await chrome.storage.local.get("siteGrants");
  const grants = Object.values((result.siteGrants ?? {}) as Record<string, SiteGrant>);
  for (const grant of grants) {
    const pattern = originPattern(grant.origin);
    const permitted = await chrome.permissions.contains({ origins: [pattern] });
    if (grant.enabled && permitted) {
      await registerSite(grant.origin).catch(() => undefined);
    } else if (!permitted) {
      await setGrant(grant.origin, false);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  void chrome.storage.local.get("settings").then((result) => {
    const settings = normalizeSettings(result.settings as Partial<Settings> | undefined);
    return chrome.storage.local.set({ settings });
  });
  void restoreRegisteredSites();
  void completePendingActivations();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreRegisteredSites();
  void completePendingActivations();
  void cleanupExpired();
});

chrome.permissions.onAdded.addListener((permissions) => {
  void completePendingActivations(permissions.origins ?? []);
});

chrome.permissions.onRemoved.addListener((permissions) => {
  const removedOrigins = permissions.origins ?? [];
  if (!removedOrigins.length) return;
  void (async () => {
    const stored = await chrome.storage.local.get("siteGrants");
    const grants = (stored.siteGrants ?? {}) as Record<string, SiteGrant>;
    for (const grant of Object.values(grants)) {
      if (removedOrigins.includes(originPattern(grant.origin))) {
        await unregisterSite(grant.origin).catch(() => undefined);
      }
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) void cleanupExpired();
});

chrome.tabs.onRemoved.addListener((tabId) => activeFields.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) activeFields.delete(tabId);
});

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "PREPARE_SITE_ACTIVATION":
      return {
        ok: true,
        activation: await prepareSiteActivation(message.origin, message.tabId, message.windowId)
      };
    case "CANCEL_SITE_ACTIVATION":
      await cancelSiteActivation(message.origin);
      return { ok: true };
    case "REGISTER_SITE":
      return { ok: true, grant: await registerSite(message.origin) };
    case "UNREGISTER_SITE":
      await unregisterSite(message.origin);
      return { ok: true };
    case "GET_SITE_STATUS":
      return { ok: true, ...(await siteStatus(message.origin)) };
    case "DRAFT_UPDATE": {
      const senderUrl = sender.url ?? sender.tab?.url;
      if (!senderUrl || new URL(senderUrl).origin !== message.payload.field.origin) {
        throw new Error("草稿来源校验失败");
      }
      if (
        isLikelySensitiveUrl(senderUrl) ||
        isLikelySensitiveField({
          type: message.payload.field.inputType,
          name: message.payload.field.name,
          label: message.payload.field.label,
          ariaLabel: message.payload.field.ariaLabel,
          placeholder: message.payload.field.placeholder
        })
      ) {
        return { ok: true, skipped: true };
      }
      const permitted = await chrome.permissions.contains({
        origins: [originPattern(message.payload.field.origin)]
      });
      if (!permitted) throw new Error("网站授权已失效");
      const settings = await getSettings();
      const text = message.payload.text.trim();
      if (!text) return { ok: true, skipped: true, reason: "empty" };
      if (text.length < settings.minChars) {
        return { ok: true, skipped: true, reason: "below-minimum", minimum: settings.minChars };
      }
      const existing = await getDraft(message.payload.id);
      if (existing?.latestText === text) {
        return { ok: true, draft: existing, unchanged: true };
      }
      const draft = await upsertDraft({ ...message.payload, text }, settings);
      void chrome.runtime.sendMessage({ type: "DATA_CHANGED" }).catch(() => undefined);
      return { ok: true, draft };
    }
    case "DRAFT_DESTRUCTIVE_EDIT": {
      const senderUrl = sender.url ?? sender.tab?.url;
      if (!senderUrl || new URL(senderUrl).origin !== message.payload.field.origin) {
        throw new Error("草稿来源校验失败");
      }
      if (
        isLikelySensitiveUrl(senderUrl) ||
        isLikelySensitiveField({
          type: message.payload.field.inputType,
          name: message.payload.field.name,
          label: message.payload.field.label,
          ariaLabel: message.payload.field.ariaLabel,
          placeholder: message.payload.field.placeholder
        })
      ) {
        return { ok: true, skipped: true, reason: "sensitive" };
      }
      if (!isDestructiveEdit(message.payload.previousText, message.payload.currentText)) {
        return { ok: true, skipped: true, reason: "not-destructive" };
      }
      const permitted = await chrome.permissions.contains({
        origins: [originPattern(message.payload.field.origin)]
      });
      if (!permitted) throw new Error("网站授权已失效");
      const draft = await protectDraftRecovery(message.payload, await getSettings());
      void chrome.runtime.sendMessage({ type: "DATA_CHANGED" }).catch(() => undefined);
      return { ok: true, draft };
    }
    case "DISMISS_DRAFT_RECOVERY": {
      const draft = await dismissDraftRecovery(message.id);
      void chrome.runtime.sendMessage({ type: "DATA_CHANGED" }).catch(() => undefined);
      return { ok: true, draft };
    }
    case "GET_FIELD_ASSIST": {
      const [draft, snippets] = await Promise.all([
        getDraft(`draft_${message.field.fingerprint}`),
        listSnippets()
      ]);
      return { ok: true, draft, suggestions: rankSuggestions(message.field, snippets) };
    }
    case "FIELD_FOCUSED": {
      if (sender.tab?.id !== undefined) {
        activeFields.set(sender.tab.id, message.field);
        void chrome.runtime
          .sendMessage({ type: "ACTIVE_FIELD_CHANGED", tabId: sender.tab.id, field: message.field })
          .catch(() => undefined);
      }
      return { ok: true };
    }
    case "GET_ACTIVE_FIELD":
      return { ok: true, field: activeFields.get(message.tabId) ?? null };
    case "LIST_DRAFTS":
      return { ok: true, drafts: await listDrafts(message.origin) };
    case "DELETE_DRAFT":
      await deleteDraft(message.id);
      return { ok: true };
    case "BATCH_DELETE_DRAFTS":
      return { ok: true, changed: await deleteDrafts(message.ids.slice(0, 500)) };
    case "EXTEND_DRAFT":
      return { ok: true, draft: await extendDraft(message.id) };
    case "BATCH_EXTEND_DRAFTS":
      return { ok: true, changed: await extendDrafts(message.ids.slice(0, 500)) };
    case "PROMOTE_DRAFT":
      return {
        ok: true,
        snippet: await promoteDraft(message.id, message.title, message.category, message.tags)
      };
    case "LIST_SNIPPETS":
      return { ok: true, snippets: await listSnippets() };
    case "SAVE_SNIPPET":
      return { ok: true, snippet: await saveSnippet(message.snippet) };
    case "DELETE_SNIPPET":
      await deleteSnippet(message.id);
      return { ok: true };
    case "GET_SUGGESTIONS":
      return { ok: true, suggestions: rankSuggestions(message.field, await listSnippets()) };
    case "SNIPPET_USED":
      await incrementSnippetUse(message.id);
      return { ok: true };
    case "INSERT_TEXT": {
      const result = await chrome.tabs.sendMessage(message.tabId, {
        type: "DRAFTVAULT_INSERT_TEXT",
        text: message.text
      });
      if (message.snippetId && result?.ok) await incrementSnippetUse(message.snippetId);
      return result;
    }
    case "GET_STATS":
      return { ok: true, stats: await getStats() };
    case "EXPORT_DATA":
      return { ok: true, data: await exportData(await getSettings()) };
    case "CLEAR_ALL_DATA":
      await clearAllData();
      return { ok: true };
    case "CLEANUP_EXPIRED":
      return { ok: true, deleted: await cleanupExpired() };
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((value) => sendResponse(value))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "未知错误" })
    );
  return true;
});
