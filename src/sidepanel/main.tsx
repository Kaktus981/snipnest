import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { groupDrafts, isShortDraft, type DraftGroup } from "../shared/draft-organize";
import { hostPermissionPattern, isLikelySensitiveUrl, normalizeSettings } from "../shared/logic";
import {
  DEFAULT_SETTINGS,
  type Draft,
  type DraftGrouping,
  type ExportPayload,
  type FieldContext,
  type ImportSummary,
  type Settings,
  type SiteGrant,
  type Snippet,
  type Suggestion
} from "../shared/types";
import "../styles.css";

type TabName = "current" | "drafts" | "snippets" | "privacy";

interface CurrentSiteStatus {
  origin: string | null;
  enabled: boolean;
  permitted: boolean;
}

async function message<T = unknown>(payload: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.ok === false) throw new Error(response.error ?? "操作失败");
  return response as T;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function fieldName(field: FieldContext): string {
  return field.label || field.ariaLabel || field.placeholder || field.name || "这个输入框";
}

function Empty({ title, children }: React.PropsWithChildren<{ title: string }>): React.ReactElement {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  count,
  countLabel = "份",
  action
}: {
  eyebrow: string;
  title: string;
  description: string;
  count?: number;
  countLabel?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="page-heading">
      <div className="grow">
        <div className="page-overline">{eyebrow}</div>
        <h2 className="page-title">{title}</h2>
        <p className="page-description">{description}</p>
      </div>
      {action ?? (typeof count === "number" ? <span className="count-note">{count} {countLabel}</span> : null)}
    </div>
  );
}

function PromoteModal({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const [title, setTitle] = useState(fieldName(draft.field));
  const [category, setCategory] = useState("通用");
  const [tags, setTags] = useState(draft.field.label || draft.field.placeholder);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    await message({
      type: "PROMOTE_DRAFT",
      id: draft.id,
      title,
      category,
      tags: tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean)
    });
    onSaved();
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
        <div className="modal-head">
          <div className="grow"><div className="modal-overline">常用内容</div><h2 className="modal-title">保存为常用内容</h2></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <p className="card-description">保存后不会自动过期，可以在其他网站的输入框里再次插入。</p>
        <label className="field-label">名称</label>
        <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <label className="field-label">分类</label>
        <input className="field" value={category} onChange={(event) => setCategory(event.target.value)} />
        <label className="field-label">标签（用逗号分隔）</label>
        <input className="field" value={tags} onChange={(event) => setTags(event.target.value)} />
        <div className="preview">{draft.latestText}</div>
        <div className="button-row">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存到常用内容"}</button>
        </div>
      </form>
    </div>
  );
}

function SnippetModal({ snippet, onClose, onSaved }: { snippet?: Snippet; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const [title, setTitle] = useState(snippet?.title ?? "");
  const [content, setContent] = useState(snippet?.content ?? "");
  const [category, setCategory] = useState(snippet?.category ?? "通用");
  const [tags, setTags] = useState(snippet?.tags.join("，") ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    await message({
      type: "SAVE_SNIPPET",
      snippet: {
        ...snippet,
        title,
        content,
        category,
        tags: tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean)
      }
    });
    onSaved();
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
        <div className="modal-head">
          <div className="grow"><div className="modal-overline">常用内容</div><h2 className="modal-title">{snippet ? "编辑常用内容" : "新建常用内容"}</h2></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <label className="field-label">名称</label>
        <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <label className="field-label">正文</label>
        <textarea className="field" value={content} onChange={(event) => setContent(event.target.value)} />
        <label className="field-label">分类</label>
        <input className="field" value={category} onChange={(event) => setCategory(event.target.value)} />
        <label className="field-label">标签（用逗号分隔）</label>
        <input className="field" value={tags} onChange={(event) => setTags(event.target.value)} />
        <div className="button-row">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim() || !content.trim()}>{busy ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </div>
  );
}

function DraftCard({
  draft,
  activeTabId,
  canRestore,
  selected,
  onSelect,
  onChanged,
  onPromote
}: {
  draft: Draft;
  activeTabId?: number;
  canRestore?: boolean;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onChanged: () => void;
  onPromote: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  async function insert(): Promise<void> {
    if (!activeTabId) return;
    await message({ type: "INSERT_TEXT", tabId: activeTabId, text: draft.latestText });
  }

  async function remove(): Promise<void> {
    if (!confirm("确定删除这份自动保存内容吗？此操作无法撤销。")) return;
    await message({ type: "DELETE_DRAFT", id: draft.id });
    onChanged();
  }

  async function extend(): Promise<void> {
    await message({ type: "EXTEND_DRAFT", id: draft.id });
    onChanged();
  }

  async function restoreRecovery(): Promise<void> {
    if (!activeTabId || !draft.recovery || !canRestore) return;
    await message({ type: "INSERT_TEXT", tabId: activeTabId, text: draft.recovery.text });
    await message({ type: "DISMISS_DRAFT_RECOVERY", id: draft.id });
    onChanged();
  }

  async function dismissRecovery(): Promise<void> {
    await message({ type: "DISMISS_DRAFT_RECOVERY", id: draft.id });
    onChanged();
  }

  return (
    <article className={`draft-row ${draft.recovery ? "has-recovery" : ""}`}>
      <div className="draft-row-head">
        {onSelect ? <input className="select-box" type="checkbox" aria-label={`选择${fieldName(draft.field)}`} checked={selected} onChange={(event) => onSelect(event.target.checked)} /> : null}
        <div className="draft-row-heading grow">
          <div className="draft-title-line">
            <h3 className="list-title truncate">{fieldName(draft.field)}</h3>
            <span className={`draft-retention ${draft.status === "extended" ? "is-extended" : ""}`}>
              保留 {draft.status === "extended" ? "30" : "7"} 天
            </span>
          </div>
          <div className="meta truncate">{draft.pageTitle || draft.origin} · {formatTime(draft.updatedAt)}</div>
        </div>
      </div>
      {draft.recovery ? (
        <div className="recovery-card">
          <div className="row-between"><strong>可能误删</strong><span>{draft.recovery.beforeCharCount}字 → {draft.recovery.afterCharCount}字</span></div>
          <div className="truncate" style={{ marginTop: 5 }}>{draft.recovery.text}</div>
          <div className="list-actions">
            <button className="button primary small" disabled={!canRestore} title={canRestore ? "" : "请先点击网页里的这个输入框"} onClick={() => void restoreRecovery()}>恢复删除前内容</button>
            <button className="button ghost small" onClick={() => void dismissRecovery()}>这是有意修改</button>
          </div>
        </div>
      ) : null}
      <div className="preview draft-preview">{draft.latestText}</div>
      <div className="draft-row-footer">
        <span className="meta">{draft.latestText.length} 字{draft.versions.length ? ` · ${draft.versions.length} 次记录` : ""}</span>
        <div className="draft-quick-actions">
          {draft.versions.length ? <button className="draft-text-action" onClick={() => setExpanded(!expanded)}>{expanded ? "收起记录" : "历史"}</button> : null}
          <button className="draft-insert-action" disabled={!activeTabId} title={activeTabId ? "插入到当前网页的文本框" : "请先打开一个普通网页"} onClick={() => void insert()}>插入</button>
          <details className="more-actions draft-more-actions">
            <summary className="draft-more-trigger" aria-label="更多操作" title="更多操作">···</summary>
            <div className="action-menu">
              <button className="menu-action" onClick={onPromote}>保存为常用内容</button>
              {draft.status === "temporary" ? <button className="menu-action" onClick={() => void extend()}>延长保留30天</button> : null}
              <button className="menu-action danger-text" onClick={() => void remove()}>删除这份备份</button>
            </div>
          </details>
        </div>
      </div>
      {expanded ? (
        <div className="draft-history">
          {draft.versions.map((version) => (
            <div className="draft-history-item" key={version.id}>
              <div className="row-between"><strong>{formatTime(version.createdAt)}</strong><span>{version.charCount}字</span></div>
              <div className="truncate" style={{ marginTop: 4 }}>{version.text}</div>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function App(): React.ReactElement {
  const [tabName, setTabName] = useState<TabName>("current");
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);
  const [activeField, setActiveField] = useState<FieldContext | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [search, setSearch] = useState("");
  const [promoting, setPromoting] = useState<Draft | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | "new" | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState({ drafts: 0, snippets: 0, characters: 0 });
  const [grants, setGrants] = useState<Record<string, SiteGrant>>({});
  const [currentSiteStatus, setCurrentSiteStatus] = useState<CurrentSiteStatus>({
    origin: null,
    enabled: false,
    permitted: false
  });
  const [siteBusy, setSiteBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [shortDraftsOpen, setShortDraftsOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      // A side panel opened directly is not an activeTab invocation. The tabs
      // permission exposes URL/title metadata so we can identify only the
      // active tab in the last-focused browser window before per-site consent.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      setActiveTab(tab ?? null);
      const tabUrl = tab?.url && /^https?:/.test(tab.url) ? tab.url : null;
      const tabOrigin = tabUrl ? new URL(tabUrl).origin : null;
      setCurrentSiteStatus({ origin: tabOrigin, enabled: false, permitted: false });
      const [draftResponse, snippetResponse, statsResponse, stored] = await Promise.all([
        message<{ drafts: Draft[] }>({ type: "LIST_DRAFTS" }),
        message<{ snippets: Snippet[] }>({ type: "LIST_SNIPPETS" }),
        message<{ stats: typeof stats }>({ type: "GET_STATS" }),
        chrome.storage.local.get(["settings", "siteGrants"])
      ]);
      setDrafts(draftResponse.drafts);
      setSnippets(snippetResponse.snippets);
      setStats(statsResponse.stats);
      setSettings(normalizeSettings(stored.settings as Partial<Settings> | undefined));
      setGrants((stored.siteGrants ?? {}) as Record<string, SiteGrant>);
      if (tabOrigin && tabUrl && tab?.id && tab.windowId !== undefined) {
        const status = await message<{ enabled: boolean; permitted: boolean }>({
          type: "GET_SITE_STATUS",
          origin: tabOrigin
        });
        setCurrentSiteStatus({ origin: tabOrigin, enabled: status.enabled, permitted: status.permitted });
        if (!status.enabled && !isLikelySensitiveUrl(tabUrl)) {
          await message({
            type: "PREPARE_SITE_ACTIVATION",
            origin: tabOrigin,
            tabId: tab.id,
            windowId: tab.windowId
          });
        }
      }
      if (tab?.id) {
        const fieldResponse = await message<{ field: FieldContext | null }>({ type: "GET_ACTIVE_FIELD", tabId: tab.id });
        setActiveField(fieldResponse.field);
        if (fieldResponse.field) {
          const suggestionResponse = await message<{ suggestions: Suggestion[] }>({ type: "GET_SUGGESTIONS", field: fieldResponse.field });
          setSuggestions(suggestionResponse.suggestions);
        } else setSuggestions([]);
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void loadData();
    const listener = (payload: { type?: string; tabId?: number; field?: FieldContext }) => {
      if (payload.type === "ACTIVE_FIELD_CHANGED" && payload.tabId === activeTab?.id && payload.field) {
        setActiveField(payload.field);
        void message<{ suggestions: Suggestion[] }>({ type: "GET_SUGGESTIONS", field: payload.field })
          .then((response) => setSuggestions(response.suggestions))
          .catch(() => undefined);
      }
      if (payload.type === "DATA_CHANGED") void loadData();
    };
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes.siteGrants || changes.settings)) void loadData();
    };
    const tabListener = () => void loadData();
    const updatedListener = (_tabId: number, changeInfo: { url?: string; status?: string }) => {
      if (changeInfo.url || changeInfo.status === "complete") void loadData();
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.storage.onChanged.addListener(storageListener);
    chrome.tabs.onActivated.addListener(tabListener);
    chrome.tabs.onUpdated.addListener(updatedListener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.storage.onChanged.removeListener(storageListener);
      chrome.tabs.onActivated.removeListener(tabListener);
      chrome.tabs.onUpdated.removeListener(updatedListener);
    };
  }, [activeTab?.id, loadData]);

  const filteredDrafts = useMemo(() => {
    const value = search.trim().toLowerCase();
    return value
      ? drafts.filter((draft) => `${fieldName(draft.field)} ${draft.pageTitle} ${draft.latestText}`.toLowerCase().includes(value))
      : drafts;
  }, [drafts, search]);

  const filteredSnippets = useMemo(() => {
    const value = search.trim().toLowerCase();
    return value
      ? snippets.filter((snippet) => `${snippet.title} ${snippet.category} ${snippet.tags.join(" ")} ${snippet.content}`.toLowerCase().includes(value))
      : snippets;
  }, [snippets, search]);

  const regularDrafts = useMemo(() => filteredDrafts.filter((draft) => !isShortDraft(draft)), [filteredDrafts]);
  const shortDrafts = useMemo(() => filteredDrafts.filter(isShortDraft), [filteredDrafts]);
  const regularGroups = useMemo(() => groupDrafts(regularDrafts, settings.draftGrouping), [regularDrafts, settings.draftGrouping]);
  const shortGroups = useMemo(() => groupDrafts(shortDrafts, settings.draftGrouping), [shortDrafts, settings.draftGrouping]);

  useEffect(() => {
    const available = new Set(drafts.map((draft) => draft.id));
    setSelectedDraftIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [drafts]);

  const currentOrigin = activeTab?.url && /^https?:/.test(activeTab.url) ? new URL(activeTab.url).origin : null;
  const currentRisky = Boolean(activeTab?.url && /^https?:/.test(activeTab.url) && isLikelySensitiveUrl(activeTab.url));
  const currentProtected = Boolean(
    currentOrigin && currentSiteStatus.origin === currentOrigin && currentSiteStatus.enabled
  );
  const currentDrafts = currentOrigin ? drafts.filter((draft) => draft.origin === currentOrigin) : [];

  async function enableCurrentSite(): Promise<void> {
    if (!activeTab?.id || activeTab.windowId === undefined || !activeTab.url || !currentOrigin || currentRisky) return;
    setSiteBusy(true);
    setError("");
    try {
      // Start both operations inside the click task so Edge recognizes the
      // permission request as a direct user action. Explicit registration
      // after acceptance also covers a fast permissions.onAdded event.
      const preparePromise = message({
        type: "PREPARE_SITE_ACTIVATION",
        origin: currentOrigin,
        tabId: activeTab.id,
        windowId: activeTab.windowId
      });
      const permissionPromise = currentSiteStatus.permitted
        ? Promise.resolve(true)
        : chrome.permissions.request({ origins: [hostPermissionPattern(currentOrigin)] });
      const [, accepted] = await Promise.all([preparePromise, permissionPromise]);
      if (!accepted) {
        await message({ type: "CANCEL_SITE_ACTIVATION", origin: currentOrigin });
        throw new Error("你取消了网站授权，当前网站没有被启用");
      }
      await message({ type: "REGISTER_SITE", origin: currentOrigin });
      await loadData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "网站授权失败");
    } finally {
      setSiteBusy(false);
    }
  }

  async function disableCurrentSite(): Promise<void> {
    if (!currentOrigin) return;
    setSiteBusy(true);
    setError("");
    try {
      await message({ type: "UNREGISTER_SITE", origin: currentOrigin });
      setActiveField(null);
      setSuggestions([]);
      await loadData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "关闭网站自动保存失败");
    } finally {
      setSiteBusy(false);
    }
  }

  async function insertText(text: string, snippetId?: string): Promise<void> {
    if (!activeTab?.id) return;
    try {
      await message({ type: "INSERT_TEXT", tabId: activeTab.id, text, snippetId });
      await loadData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "插入失败");
    }
  }

  async function updateSettings(next: Settings): Promise<void> {
    setSettings(next);
    await chrome.storage.local.set({ settings: next });
  }

  async function exportJson(): Promise<void> {
    const response = await message<{ data: ExportPayload }>({ type: "EXPORT_DATA" });
    const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `snipnest-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File): Promise<void> {
    setImportBusy(true);
    setImportNotice("");
    setError("");
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("JSON备份不能超过20MB");
      const data = JSON.parse(await file.text()) as unknown;
      if (
        typeof data !== "object" ||
        data === null ||
        !("format" in data) ||
        data.format !== "draftvault-export" ||
        !("drafts" in data) ||
        !Array.isArray(data.drafts) ||
        !("snippets" in data) ||
        !Array.isArray(data.snippets)
      ) throw new Error("这不是文栈支持的JSON备份文件");
      if (!confirm(
        `准备导入 ${data.drafts.length} 份自动保存内容和 ${data.snippets.length} 条常用内容。\n\n` +
        "同一条数据只会在备份版本更新时覆盖，现有的其他数据不会删除。是否继续？"
      )) return;
      const response = await message<{ summary: ImportSummary }>({ type: "IMPORT_DATA", data });
      const summary = response.summary;
      const changed = summary.draftsAdded + summary.draftsUpdated + summary.snippetsAdded + summary.snippetsUpdated;
      setImportNotice(
        changed
          ? `导入完成：新增${summary.draftsAdded}份自动保存内容、更新${summary.draftsUpdated}份；新增${summary.snippetsAdded}条常用内容、更新${summary.snippetsUpdated}条。`
          : "导入完成：备份中的内容没有比现有数据更新，未覆盖任何记录。"
      );
      await loadData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setImportBusy(false);
    }
  }

  async function clearData(): Promise<void> {
    if (!confirm("确定清除全部自动保存内容和常用内容吗？此操作无法撤销。")) return;
    await message({ type: "CLEAR_ALL_DATA" });
    await loadData();
  }

  async function revokeGrant(origin: string): Promise<void> {
    await message({ type: "UNREGISTER_SITE", origin });
    await loadData();
  }

  function toggleDraft(id: string, selected: boolean): void {
    setSelectedDraftIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleGroup(key: string): void {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectGroup(group: DraftGroup, selected: boolean): void {
    setSelectedDraftIds((current) => {
      const next = new Set(current);
      group.drafts.forEach((draft) => selected ? next.add(draft.id) : next.delete(draft.id));
      return next;
    });
  }

  async function batchDelete(): Promise<void> {
    const ids = [...selectedDraftIds];
    if (!ids.length || !confirm(`确定删除选中的 ${ids.length} 份自动保存内容吗？此操作无法撤销。`)) return;
    await message({ type: "BATCH_DELETE_DRAFTS", ids });
    setSelectedDraftIds(new Set());
    await loadData();
  }

  async function batchExtend(): Promise<void> {
    const ids = [...selectedDraftIds];
    if (!ids.length) return;
    await message({ type: "BATCH_EXTEND_DRAFTS", ids });
    setSelectedDraftIds(new Set());
    await loadData();
  }

  function renderGroup(group: DraftGroup, prefix: "main" | "short"): React.ReactElement {
    const key = `${prefix}:${group.key}`;
    const collapsed = collapsedGroups.has(key);
    const allSelected = group.drafts.every((draft) => selectedDraftIds.has(draft.id));
    return (
      <section className="draft-group" key={key}>
        <div className="group-head">
          <input className="select-box" type="checkbox" aria-label={`选择${group.label}分组`} checked={allSelected} onChange={(event) => selectGroup(group, event.target.checked)} />
          <button className="group-toggle grow" aria-expanded={!collapsed} onClick={() => toggleGroup(key)}>
            <span className="group-copy">
              <strong className="group-title truncate">{group.label}</strong>
              <span className="group-count">{group.drafts.length} 份输入备份</span>
            </span>
            <span className="group-disclosure" aria-hidden="true">{collapsed ? "＋" : "−"}</span>
          </button>
        </div>
        {!collapsed ? <div className="list group-list">{group.drafts.map((draft) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            activeTabId={activeTab?.id}
            canRestore={activeField?.fingerprint === draft.field.fingerprint}
            selected={selectedDraftIds.has(draft.id)}
            onSelect={(selected) => toggleDraft(draft.id, selected)}
            onChanged={() => void loadData()}
            onPromote={() => setPromoting(draft)}
          />
        ))}</div> : null}
      </section>
    );
  }

  function CurrentPage(): React.ReactElement {
    const hasCurrentFieldBackup = Boolean(
      currentProtected && activeField && currentDrafts.some((draft) => draft.field.fingerprint === activeField.fingerprint)
    );
    const workflowCue = !currentOrigin
      ? { label: "暂不可用", title: "请先打开一个普通网页", note: "Edge 内部页面无法启用文栈", tone: "is-idle" }
      : currentRisky
        ? { label: "安全保护", title: "这个页面不会保存输入内容", note: "登录、支付和验证码页面会自动跳过", tone: "is-caution" }
        : !currentProtected
          ? { label: "下一步", title: "先为当前网站开启自动保存", note: "开启后，再到网页里点选文本框", tone: "is-next" }
          : !settings.autoSaveEnabled
            ? { label: "已暂停", title: "自动保存已在设置中关闭", note: "误删大段内容时仍会保留恢复副本", tone: "is-caution" }
            : !activeField
              ? { label: "下一步", title: "回到网页，点一下要填写的文本框", note: "识别后，输入内容将自动保存在本机", tone: "is-next" }
              : hasCurrentFieldBackup
                ? { label: "已保存", title: "这个文本框已有本地备份", note: "可以继续输入", tone: "is-ready" }
                : { label: "可以输入", title: "这个文本框已准备好自动保存", note: "输入后，内容只保存在本机", tone: "is-next" };

    return (
      <div className="content current-workspace">
        <section className={`workflow-cue ${workflowCue.tone}`} aria-label="当前操作提示" aria-live="polite">
          <span className="workflow-cue-label">{workflowCue.label}</span>
          <strong className="workflow-cue-title">{workflowCue.title}</strong>
          <span className="workflow-cue-note">{workflowCue.note}</span>
        </section>
        <section className="context-panel">
          <div className="section-label">当前网站</div>
          <div className="context-line row-between">
            <div className="grow">
              <h2 className="context-title truncate">{activeTab?.title ?? "当前页"}</h2>
              <p className="card-description truncate">{currentOrigin ?? "这个页面无法使用文栈"}</p>
            </div>
            <span className={`status ${currentRisky ? "warning" : currentProtected && settings.autoSaveEnabled ? "success" : "muted"}`}>
              {!currentOrigin
                ? "不可使用"
                : currentRisky
                  ? "不会保存"
                  : currentProtected
                    ? settings.autoSaveEnabled ? "自动保存中" : "仅防误删"
                    : "尚未开启"}
            </span>
          </div>
          {!currentOrigin ? (
            <div className="notice context-notice">Edge 新标签页、设置页和扩展商店等内部页面不能使用文栈。请先打开普通网站。</div>
          ) : currentRisky ? (
            <div className="notice warning context-notice">出于安全考虑，文栈不会在支付、登录或验证码页面保存输入内容。</div>
          ) : currentProtected ? (
            <div className="context-actions">
              <div className="notice">
                {settings.autoSaveEnabled
                  ? "自动保存已开启。你在普通文本框中输入的内容会保存在本机；密码、验证码和支付信息不会被读取。"
                  : "此网站可以使用文栈，但自动保存已在设置中暂停。若一次误删大段内容，文栈仍会保留一份恢复副本。"}
              </div>
              <button className="button danger" disabled={siteBusy} onClick={() => void disableCurrentSite()}>
                {siteBusy ? "正在关闭…" : "关闭此网站自动保存"}
              </button>
            </div>
          ) : (
            <div className="context-actions">
              <p className="context-copy">开启后，文栈会保存你在这个网站普通文本框里输入的内容。密码、验证码和支付信息不会被读取。</p>
              <button className="button primary" disabled={siteBusy} onClick={() => void enableCurrentSite()}>
                {siteBusy ? "正在请求授权…" : "开启此网站自动保存"}
              </button>
            </div>
          )}
        </section>
        {currentProtected && activeField ? (
          <section className="workspace-section field-section">
            <div className="section-heading-between">
              <div>
                <div className="section-label">当前文本框</div>
                <h2 className="section-title">{fieldName(activeField)}</h2>
              </div>
            </div>
            {activeField.maxLength ? <div className="meta" style={{ marginTop: 8 }}>最多 {activeField.maxLength} 字</div> : null}
          </section>
        ) : null}
        {suggestions.length ? (
          <section className="workspace-section">
            <div className="section-heading-between">
              <div><div className="section-label">可继续使用</div><h2 className="section-title">可插入内容</h2><p className="section-description">根据输入框名称和页面标题，在本地找到的常用内容。</p></div>
              <span className="count-note">{suggestions.length} 条</span>
            </div>
            <div className="list workspace-list">
              {suggestions.map((suggestion) => (
                <article className="content-row suggestion-row" key={suggestion.snippet.id}>
                  <div className="suggestion-head">
                    <strong className="list-title grow">{suggestion.snippet.title}</strong>
                    <button className="text-action" onClick={() => void insertText(suggestion.snippet.content, suggestion.snippet.id)}>插入</button>
                  </div>
                  <div className="preview">{suggestion.snippet.content}</div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {currentDrafts.length ? (
          <section className="workspace-section">
            <div className="section-heading-between">
              <div><div className="section-label">最近保存</div><h2 className="section-title">这个网站的备份</h2><p className="section-description">在网页中点选对应的文本框后，可以将内容恢复回去。</p></div>
              <span className="count-note">{currentDrafts.length} 份</span>
            </div>
            <div className="list workspace-list">{currentDrafts.slice(0, 3).map((draft) => <DraftCard key={draft.id} draft={draft} activeTabId={activeTab?.id} canRestore={activeField?.fingerprint === draft.field.fingerprint} onChanged={() => void loadData()} onPromote={() => setPromoting(draft)} />)}</div>
          </section>
        ) : null}
      </div>
    );
  }

  function DraftsPage(): React.ReactElement {
    return (
      <div className="content drafts-page">
        <PageHeading
          eyebrow="本机备份"
          title="输入备份"
          description="按网站整理最近自动保存的内容"
          count={filteredDrafts.length}
        />
        <div className="draft-toolbar">
          <input className="field" placeholder="搜索网站、输入框或内容" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedDraftIds(new Set()); }} />
          <select className="field compact" aria-label="自动保存内容分组方式" value={settings.draftGrouping} onChange={(event) => { setSelectedDraftIds(new Set()); void updateSettings({ ...settings, draftGrouping: event.target.value as DraftGrouping }); }}>
            <option value="site">按网站</option><option value="date">按日期</option><option value="field">按输入框</option>
          </select>
        </div>
        {selectedDraftIds.size ? (
          <div className="batch-bar">
            <strong>已选择 {selectedDraftIds.size} 份</strong>
            <button className="button secondary small" onClick={() => void batchExtend()}>延长30天</button>
            <button className="button danger small" onClick={() => void batchDelete()}>批量删除</button>
            <button className="button ghost small" onClick={() => setSelectedDraftIds(new Set())}>取消选择</button>
          </div>
        ) : null}
        <div className="group-stack">
          {regularGroups.map((group) => renderGroup(group, "main"))}
          {shortDrafts.length ? (
            <section className="short-drafts">
              <button className="short-toggle" onClick={() => setShortDraftsOpen(!shortDraftsOpen)}>
                <span><strong>较短内容</strong><small>1至9字，已完整保存</small></span>
                <span>{shortDrafts.length}份 · {shortDraftsOpen ? "收起" : "展开"}</span>
              </button>
              {shortDraftsOpen ? <div className="group-stack nested">{shortGroups.map((group) => renderGroup(group, "short"))}</div> : null}
            </section>
          ) : null}
          {!filteredDrafts.length ? <div className="empty-panel"><Empty title="还没有自动保存内容">{settings.autoSaveEnabled ? `开启本网站自动保存并输入至少 ${settings.minChars} 个字后，内容会出现在这里。` : "自动保存已关闭；大段文字被意外清空时，文栈仍会保留一份可恢复内容。"}</Empty></div> : null}
        </div>
      </div>
    );
  }

  function SnippetsPage(): React.ReactElement {
    return (
      <div className="content">
        <PageHeading
          eyebrow="常用内容"
          title="常用内容"
          description="保存经常重复输入的文字"
          count={filteredSnippets.length}
          countLabel="条"
        />
        <div className="row search-row">
          <input className="field grow" placeholder="搜索名称、分类或标签" value={search} onChange={(event) => setSearch(event.target.value)} />
          <button className="button primary" onClick={() => setEditingSnippet("new")}>新建</button>
        </div>
        <div className="list list-table" style={{ marginTop: 12 }}>
          {filteredSnippets.map((snippet) => (
            <article className="content-row snippet-row" key={snippet.id}>
              <div className="row-between"><div className="grow"><h3 className="list-title truncate">{snippet.title}</h3><div className="meta">{snippet.category} · 使用{snippet.useCount}次</div></div><span className="status-note">长期保存</span></div>
              <div className="preview">{snippet.content}</div>
              <div className="meta-tags" style={{ marginTop: 8 }}>{snippet.tags.map((tag) => <span className="meta-tag" key={tag}>{tag}</span>)}</div>
              <div className="list-actions action-bar">
                <button className="button primary small action-primary" disabled={!activeField} title={activeField ? "" : "请先点击网页里的输入框"} onClick={() => void insertText(snippet.content, snippet.id)}>插入到输入框</button>
                <details className="more-actions">
                  <summary className="button ghost small">更多</summary>
                  <div className="action-menu">
                    <button className="menu-action" onClick={() => setEditingSnippet(snippet)}>编辑常用内容</button>
                    <button className="menu-action danger-text" onClick={() => void (async () => { if (confirm("确定删除这条常用内容吗？")) { await message({ type: "DELETE_SNIPPET", id: snippet.id }); await loadData(); } })()}>删除常用内容</button>
                  </div>
                </details>
              </div>
            </article>
          ))}
          {!filteredSnippets.length ? <div className="empty-panel"><Empty title="还没有常用内容">可以新建一条，也可以从自动保存内容中保存。</Empty></div> : null}
        </div>
      </div>
    );
  }

  function PrivacyPage(): React.ReactElement {
    return (
      <div className="content settings-page">
        <PageHeading
          eyebrow="文栈"
          title="偏好与数据"
          description="管理保存方式、可用网站和本机备份"
        />
        <section className="settings-summary" aria-labelledby="local-data-title">
          <div className="settings-summary-head">
            <div>
              <div className="settings-local-state"><span />只保存在本机</div>
              <h2 id="local-data-title" className="settings-summary-title">你的文栈</h2>
            </div>
            <p>不会主动上传到网络</p>
          </div>
          <dl className="settings-metrics">
            <div><dt>输入备份</dt><dd>{stats.drafts}</dd></div>
            <div><dt>常用内容</dt><dd>{stats.snippets}</dd></div>
            <div><dt>保存字符</dt><dd>{stats.characters}</dd></div>
          </dl>
          <p className="settings-privacy-note">
            文栈只查询当前网页的网址和标题；为网站开启自动保存后，才会读取其中的普通文本框。
          </p>
        </section>

        <section className="settings-block" aria-labelledby="save-rules-title">
          <header className="settings-block-head">
            <span className="settings-block-index">01</span>
            <div className="grow">
              <h2 id="save-rules-title">保存规则</h2>
              <p>决定何时保存，以及内容保留多久</p>
            </div>
          </header>
          <div className="settings-sheet">
            <div className="settings-line settings-line-featured">
              <div className="settings-line-copy">
                <strong>自动保存输入内容</strong>
                <small>关闭后停止持续保存，误删大段文字时仍会尝试保留副本。</small>
              </div>
              <button
                className={`toggle ${settings.autoSaveEnabled ? "on" : ""}`}
                role="switch"
                aria-checked={settings.autoSaveEnabled}
                aria-label="自动保存输入内容"
                title={settings.autoSaveEnabled ? "自动保存已开启" : "自动保存已关闭，仍可尝试恢复误删内容"}
                onClick={() => void updateSettings({ ...settings, autoSaveEnabled: !settings.autoSaveEnabled })}
              >
                <span />
              </button>
            </div>
            <label className="settings-line">
              <span className="settings-line-copy"><strong>保留时间</strong><small>到期后自动清理输入备份</small></span>
              <select className="settings-select" value={settings.retentionDays} onChange={(event) => void updateSettings({ ...settings, retentionDays: Number(event.target.value) as 1 | 7 | 30 })}>
                <option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option>
              </select>
            </label>
            <label className="settings-line">
              <span className="settings-line-copy"><strong>开始保存</strong><small>输入达到这个字数后保存</small></span>
              <select className="settings-select" value={settings.minChars} onChange={(event) => void updateSettings({ ...settings, minChars: Number(event.target.value) })}>
                <option value={1}>1 字</option><option value={5}>5 字</option><option value={10}>10 字</option><option value={20}>20 字</option><option value={50}>50 字</option>
              </select>
            </label>
            <label className="settings-line">
              <span className="settings-line-copy"><strong>备份分组</strong><small>自动保存页面中的默认排列方式</small></span>
              <select className="settings-select" value={settings.draftGrouping} onChange={(event) => void updateSettings({ ...settings, draftGrouping: event.target.value as DraftGrouping })}>
                <option value="site">按网站</option><option value="date">按日期</option><option value="field">按输入框</option>
              </select>
            </label>
          </div>
        </section>

        <section className="settings-block" aria-labelledby="site-access-title">
          <header className="settings-block-head">
            <span className="settings-block-index">02</span>
            <div className="grow"><h2 id="site-access-title">网站范围</h2><p>只有下面的网站可以自动保存</p></div>
            <span className="settings-block-count">{Object.keys(grants).length}</span>
          </header>
          {Object.keys(grants).length ? <div className="settings-site-list">
          {Object.values(grants).map((grant) => (
            <div className="settings-site-row" key={grant.origin}>
              <div className="grow"><strong className="settings-site-domain truncate">{grant.origin}</strong><span className="settings-site-date">开启于 {formatTime(grant.enabledAt)}</span></div>
              <button className="settings-inline-danger" onClick={() => void revokeGrant(grant.origin)}>停止保存</button>
            </div>
          ))}
          </div> : <div className="settings-empty">还没有为任何网站开启自动保存。</div>}
        </section>

        <section className="settings-block" aria-labelledby="data-actions-title">
          <header className="settings-block-head">
            <span className="settings-block-index">03</span>
            <div className="grow"><h2 id="data-actions-title">备份与清理</h2><p>JSON 文件只在当前浏览器中读取</p></div>
          </header>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importJson(file);
            }}
          />
          <div className="settings-transfer-list">
            <button className="settings-transfer-action" disabled={importBusy} onClick={() => importInputRef.current?.click()}>
              <span className="settings-transfer-mark">入</span>
              <span className="settings-transfer-copy"><strong>{importBusy ? "正在导入…" : "导入备份"}</strong><small>从文栈 JSON 文件恢复数据</small></span>
              <span className="settings-transfer-hint">选择文件</span>
            </button>
            <button className="settings-transfer-action" onClick={() => void exportJson()}>
              <span className="settings-transfer-mark">出</span>
              <span className="settings-transfer-copy"><strong>导出备份</strong><small>将当前数据保存为 JSON 文件</small></span>
              <span className="settings-transfer-hint">保存文件</span>
            </button>
          </div>
          <div className="settings-clear-zone">
            <span className="settings-clear-mark">谨慎操作</span>
            <div className="settings-clear-copy"><strong>清除本机全部数据</strong><small>输入备份、常用内容和网站记录都会被删除</small></div>
            <button className="settings-clear-action" onClick={() => void clearData()}>清除数据</button>
          </div>
          {importNotice ? <div className="settings-import-notice">{importNotice}</div> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <nav className="tabs" aria-label="主导航">
        {([
          ["current", "01", "工作台"],
          ["drafts", "02", "自动保存"],
          ["snippets", "03", "常用内容"],
          ["privacy", "04", "设置"]
        ] as [TabName, string, string][]).map(([name, index, label]) => (
          <button
            className={`tab ${tabName === name ? "active" : ""}`}
            key={name}
            aria-current={tabName === name ? "page" : undefined}
            onClick={() => { setTabName(name); setSearch(""); }}
          >
            <span className="tab-index">{index}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="app-main">
        {error ? <div className="notice warning app-error">{error}</div> : null}
        {tabName === "current" ? <CurrentPage /> : null}
        {tabName === "drafts" ? <DraftsPage /> : null}
        {tabName === "snippets" ? <SnippetsPage /> : null}
        {tabName === "privacy" ? <PrivacyPage /> : null}
      </main>
      {promoting ? <PromoteModal draft={promoting} onClose={() => setPromoting(null)} onSaved={() => { setPromoting(null); void loadData(); }} /> : null}
      {editingSnippet ? <SnippetModal snippet={editingSnippet === "new" ? undefined : editingSnippet} onClose={() => setEditingSnippet(null)} onSaved={() => { setEditingSnippet(null); void loadData(); }} /> : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
