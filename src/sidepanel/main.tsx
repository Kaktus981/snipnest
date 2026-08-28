import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { groupDrafts, isShortDraft, type DraftGroup } from "../shared/draft-organize";
import { normalizeSettings } from "../shared/logic";
import {
  DEFAULT_SETTINGS,
  type Draft,
  type DraftGrouping,
  type ExportPayload,
  type FieldContext,
  type Settings,
  type SiteGrant,
  type Snippet,
  type Suggestion
} from "../shared/types";
import "../styles.css";

type TabName = "current" | "drafts" | "snippets" | "privacy";

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
  return field.label || field.ariaLabel || field.placeholder || field.name || "未命名长文本字段";
}

function Empty({ icon, title, children }: React.PropsWithChildren<{ icon: string; title: string }>): React.ReactElement {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <div>{children}</div>
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
        <h2 className="card-title">升级为永久片段</h2>
        <p className="card-description">升级后草稿不再自动过期，并可在其他网站获得本地推荐。</p>
        <label className="field-label">片段名称</label>
        <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <label className="field-label">分类</label>
        <input className="field" value={category} onChange={(event) => setCategory(event.target.value)} />
        <label className="field-label">标签（用逗号分隔）</label>
        <input className="field" value={tags} onChange={(event) => setTags(event.target.value)} />
        <div className="preview">{draft.latestText}</div>
        <div className="button-row">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存片段"}</button>
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
        <h2 className="card-title">{snippet ? "编辑片段" : "新建片段"}</h2>
        <label className="field-label">片段名称</label>
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
    if (!confirm("确定删除这份草稿吗？此操作无法撤销。")) return;
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
    <article className="list-card">
      <div className="row-between">
        {onSelect ? <input className="select-box" type="checkbox" aria-label={`选择${fieldName(draft.field)}`} checked={selected} onChange={(event) => onSelect(event.target.checked)} /> : null}
        <div className="grow">
          <h3 className="list-title truncate">{fieldName(draft.field)}</h3>
          <div className="meta truncate">{draft.pageTitle || draft.origin} · {formatTime(draft.updatedAt)}</div>
        </div>
        <span className={`status ${draft.status === "extended" ? "warning" : "muted"}`}>
          {draft.status === "extended" ? "30天" : "7天"}
        </span>
      </div>
      {draft.recovery ? (
        <div className="recovery-card">
          <div className="row-between"><strong>疑似误删</strong><span>{draft.recovery.beforeCharCount}字 → {draft.recovery.afterCharCount}字</span></div>
          <div className="truncate" style={{ marginTop: 5 }}>{draft.recovery.text}</div>
          <div className="list-actions">
            <button className="button primary small" disabled={!canRestore} title={canRestore ? "" : "请先点击原网页中的这个字段"} onClick={() => void restoreRecovery()}>恢复删除前内容</button>
            <button className="button ghost small" onClick={() => void dismissRecovery()}>这是有意修改</button>
          </div>
        </div>
      ) : null}
      <div className="preview">{draft.latestText}</div>
      <div className="row-between" style={{ marginTop: 8 }}>
        <span className="meta">{draft.latestText.length}字 · {draft.versions.length}个历史版本</span>
        {draft.versions.length ? <button className="button ghost small" onClick={() => setExpanded(!expanded)}>{expanded ? "收起历史" : "查看历史"}</button> : null}
      </div>
      {expanded ? (
        <div style={{ marginTop: 8 }}>
          {draft.versions.map((version) => (
            <div className="notice" key={version.id} style={{ marginTop: 6 }}>
              <div className="row-between"><strong>{formatTime(version.createdAt)}</strong><span>{version.charCount}字</span></div>
              <div className="truncate" style={{ marginTop: 4 }}>{version.text}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="list-actions">
        <button className="button primary small" disabled={!activeTabId} onClick={() => void insert()}>插入当前字段</button>
        <button className="button secondary small" onClick={onPromote}>升级片段</button>
        {draft.status === "temporary" ? <button className="button ghost small" onClick={() => void extend()}>延长30天</button> : null}
        <button className="button danger small" onClick={() => void remove()}>删除</button>
      </div>
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
  const [error, setError] = useState("");
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [shortDraftsOpen, setShortDraftsOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setActiveTab(tab ?? null);
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
  const currentDrafts = currentOrigin ? drafts.filter((draft) => draft.origin === currentOrigin) : [];

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

  async function clearData(): Promise<void> {
    if (!confirm("确定清除全部草稿和永久片段吗？此操作无法撤销。")) return;
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
    if (!ids.length || !confirm(`确定删除选中的 ${ids.length} 份草稿吗？此操作无法撤销。`)) return;
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
          <button className="group-toggle grow" onClick={() => toggleGroup(key)}>
            <span className="truncate">{group.label}</span><span>{group.drafts.length}份 · {collapsed ? "展开" : "收起"}</span>
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
    return (
      <div className="content">
        <section className="card">
          <div className="row-between">
            <div className="grow">
              <h2 className="card-title truncate">{activeTab?.title ?? "当前页面"}</h2>
              <p className="card-description truncate">{currentOrigin ?? "当前页面不可访问"}</p>
            </div>
            <span className={`status ${currentOrigin && grants[currentOrigin]?.enabled ? "success" : "muted"}`}>
              {currentOrigin && grants[currentOrigin]?.enabled ? "保护中" : "未保护"}
            </span>
          </div>
        </section>
        <section className="card">
          <h2 className="card-title">当前输入位置</h2>
          {activeField ? (
            <>
              <p className="card-description">{fieldName(activeField)}</p>
              <div className="chip-list" style={{ marginTop: 9 }}>
                <span className="chip">{activeField.inputType}</span>
                {activeField.maxLength ? <span className="chip">最多{activeField.maxLength}字</span> : null}
                <span className="chip">本地匹配</span>
              </div>
            </>
          ) : <div className="notice" style={{ marginTop: 10 }}>请先点击网页中的长文本输入框。</div>}
        </section>
        <section className="card">
          <h2 className="card-title">推荐片段</h2>
          {suggestions.length ? (
            <div className="list" style={{ marginTop: 10 }}>
              {suggestions.map((suggestion) => (
                <div className="list-card" key={suggestion.snippet.id}>
                  <div className="row-between"><strong className="list-title">{suggestion.snippet.title}</strong><span className="chip">匹配 {suggestion.score}</span></div>
                  <div className="preview">{suggestion.snippet.content}</div>
                  <div className="meta" style={{ marginTop: 7 }}>{suggestion.reasons.join(" · ")}</div>
                  <button className="button primary small" style={{ marginTop: 9 }} onClick={() => void insertText(suggestion.snippet.content, suggestion.snippet.id)}>预览后插入</button>
                </div>
              ))}
            </div>
          ) : <div className="notice" style={{ marginTop: 10 }}>当前字段暂无达到匹配阈值的片段。</div>}
        </section>
        <section className="card">
          <div className="row-between"><h2 className="card-title">本页草稿</h2><span className="meta">{currentDrafts.length}份</span></div>
          {currentDrafts.length ? <div className="list" style={{ marginTop: 10 }}>{currentDrafts.slice(0, 3).map((draft) => <DraftCard key={draft.id} draft={draft} activeTabId={activeTab?.id} canRestore={activeField?.fingerprint === draft.field.fingerprint} onChanged={() => void loadData()} onPromote={() => setPromoting(draft)} />)}</div> : <div className="notice" style={{ marginTop: 10 }}>输入达到{settings.minChars}字并停顿后，草稿会出现在这里。</div>}
        </section>
      </div>
    );
  }

  function DraftsPage(): React.ReactElement {
    return (
      <div className="content">
        <div className="draft-toolbar">
          <input className="field" placeholder="搜索字段、网页或草稿内容" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedDraftIds(new Set()); }} />
          <select className="field compact" aria-label="草稿分组方式" value={settings.draftGrouping} onChange={(event) => { setSelectedDraftIds(new Set()); void updateSettings({ ...settings, draftGrouping: event.target.value as DraftGrouping }); }}>
            <option value="site">按网站</option><option value="date">按日期</option><option value="field">按字段</option>
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
                <span><strong>短草稿</strong><small>1至9字，已完整保存</small></span>
                <span>{shortDrafts.length}份 · {shortDraftsOpen ? "收起" : "展开"}</span>
              </button>
              {shortDraftsOpen ? <div className="group-stack nested">{shortGroups.map((group) => renderGroup(group, "short"))}</div> : null}
            </section>
          ) : null}
          {!filteredDrafts.length ? <div className="card"><Empty icon="⌛" title="还没有草稿">启用网站保护并输入至少{settings.minChars}个字符后，草稿会自动保存在这里。</Empty></div> : null}
        </div>
      </div>
    );
  }

  function SnippetsPage(): React.ReactElement {
    return (
      <div className="content">
        <div className="row">
          <input className="field grow" placeholder="搜索片段、分类或标签" value={search} onChange={(event) => setSearch(event.target.value)} />
          <button className="button primary" onClick={() => setEditingSnippet("new")}>新建</button>
        </div>
        <div className="list" style={{ marginTop: 12 }}>
          {filteredSnippets.map((snippet) => (
            <article className="list-card" key={snippet.id}>
              <div className="row-between"><div className="grow"><h3 className="list-title truncate">{snippet.title}</h3><div className="meta">{snippet.category} · 使用{snippet.useCount}次</div></div><span className="chip">永久</span></div>
              <div className="preview">{snippet.content}</div>
              <div className="chip-list" style={{ marginTop: 8 }}>{snippet.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}</div>
              <div className="list-actions">
                <button className="button primary small" disabled={!activeField} onClick={() => void insertText(snippet.content, snippet.id)}>插入当前字段</button>
                <button className="button ghost small" onClick={() => setEditingSnippet(snippet)}>编辑</button>
                <button className="button danger small" onClick={() => void (async () => { if (confirm("确定删除这个永久片段吗？")) { await message({ type: "DELETE_SNIPPET", id: snippet.id }); await loadData(); } })()}>删除</button>
              </div>
            </article>
          ))}
          {!filteredSnippets.length ? <div className="card"><Empty icon="✦" title="还没有永久片段">可以新建片段，也可以从草稿页面将有价值的内容升级为片段。</Empty></div> : null}
        </div>
      </div>
    );
  }

  function PrivacyPage(): React.ReactElement {
    return (
      <div className="content">
        <section className="card">
          <h2 className="card-title">本地数据概览</h2>
          <div className="stat-grid" style={{ marginTop: 12 }}>
            <div className="stat"><div className="stat-value">{stats.drafts}</div><div className="stat-label">临时草稿</div></div>
            <div className="stat"><div className="stat-value">{stats.snippets}</div><div className="stat-label">永久片段</div></div>
            <div className="stat"><div className="stat-value">{stats.characters}</div><div className="stat-label">保存字符</div></div>
          </div>
          <p className="card-description">数据保存在当前浏览器的扩展存储中，不会主动发送到网络。</p>
        </section>
        <section className="card">
          <h2 className="card-title">草稿策略</h2>
          <label className="field-label">默认保留时间</label>
          <select className="field" value={settings.retentionDays} onChange={(event) => void updateSettings({ ...settings, retentionDays: Number(event.target.value) as 1 | 7 | 30 })}>
            <option value={1}>1天</option><option value={7}>7天</option><option value={30}>30天</option>
          </select>
          <label className="field-label">开始保护的最少字符数</label>
          <select className="field" value={settings.minChars} onChange={(event) => void updateSettings({ ...settings, minChars: Number(event.target.value) })}>
            <option value={1}>1字（推荐）</option><option value={5}>5字</option><option value={10}>10字</option><option value={20}>20字</option><option value={50}>50字</option>
          </select>
          <label className="field-label">草稿默认分组</label>
          <select className="field" value={settings.draftGrouping} onChange={(event) => void updateSettings({ ...settings, draftGrouping: event.target.value as DraftGrouping })}>
            <option value="site">按网站</option><option value="date">按日期</option><option value="field">按字段</option>
          </select>
        </section>
        <section className="card">
          <div className="row-between"><h2 className="card-title">已授权网站</h2><span className="meta">{Object.keys(grants).length}个</span></div>
          {Object.values(grants).map((grant) => (
            <div className="row-between" style={{ marginTop: 11 }} key={grant.origin}>
              <div className="grow"><div className="truncate" style={{ fontSize: 12, fontWeight: 650 }}>{grant.origin}</div><div className="meta">启用于 {formatTime(grant.enabledAt)}</div></div>
              <button className="button danger small" onClick={() => void revokeGrant(grant.origin)}>撤销</button>
            </div>
          ))}
          {!Object.keys(grants).length ? <div className="notice" style={{ marginTop: 10 }}>尚未授权任何网站。</div> : null}
        </section>
        <section className="card">
          <h2 className="card-title">数据控制</h2>
          <p className="card-description">导出文件包含草稿和永久片段，请将其保存在可信位置。</p>
          <div className="button-row">
            <button className="button secondary" onClick={() => void exportJson()}>导出 JSON</button>
            <button className="button danger" onClick={() => void clearData()}>清除全部</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">文</div>
        <div className="brand-copy grow"><h1 className="brand-title">文栈 SnipNest</h1><div className="brand-subtitle">网页长文本的本地记忆库</div></div>
        <span className="status success">本地</span>
      </header>
      <nav className="tabs">
        {(["current", "drafts", "snippets", "privacy"] as TabName[]).map((name) => (
          <button className={`tab ${tabName === name ? "active" : ""}`} key={name} onClick={() => { setTabName(name); setSearch(""); }}>
            {{ current: "当前页面", drafts: "草稿", snippets: "片段", privacy: "隐私设置" }[name]}
          </button>
        ))}
      </nav>
      {error ? <div className="notice warning" style={{ margin: 12 }}>{error}</div> : null}
      {tabName === "current" ? <CurrentPage /> : null}
      {tabName === "drafts" ? <DraftsPage /> : null}
      {tabName === "snippets" ? <SnippetsPage /> : null}
      {tabName === "privacy" ? <PrivacyPage /> : null}
      {promoting ? <PromoteModal draft={promoting} onClose={() => setPromoting(null)} onSaved={() => { setPromoting(null); void loadData(); }} /> : null}
      {editingSnippet ? <SnippetModal snippet={editingSnippet === "new" ? undefined : editingSnippet} onClose={() => setEditingSnippet(null)} onSaved={() => { setEditingSnippet(null); void loadData(); }} /> : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
