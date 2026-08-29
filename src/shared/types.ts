type DraftStatus = "temporary" | "extended";
export type DraftGrouping = "site" | "date" | "field";

export interface SiteGrant {
  origin: string;
  enabled: boolean;
  enabledAt: number;
}

export interface FieldContext {
  origin: string;
  pathname: string;
  pageUrl: string;
  pageTitle: string;
  label: string;
  ariaLabel: string;
  placeholder: string;
  name: string;
  inputType: string;
  maxLength: number | null;
  domHint: string;
  fingerprint: string;
}

export interface DraftVersion {
  id: string;
  text: string;
  charCount: number;
  createdAt: number;
}

interface DraftRecovery {
  text: string;
  createdAt: number;
  beforeCharCount: number;
  afterCharCount: number;
}

export interface Draft {
  id: string;
  origin: string;
  pathname: string;
  pageUrl: string;
  pageTitle: string;
  field: FieldContext;
  latestText: string;
  versions: DraftVersion[];
  recovery?: DraftRecovery;
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface Snippet {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  sourceDraftId?: string;
  useCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Suggestion {
  snippet: Snippet;
  score: number;
  reasons: string[];
}

export interface Settings {
  retentionDays: 1 | 7 | 30;
  minChars: number;
  maxVersions: number;
  draftGrouping: DraftGrouping;
  autoSaveEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 7,
  minChars: 1,
  maxVersions: 5,
  draftGrouping: "site",
  autoSaveEnabled: true
};

export interface ImportSummary {
  draftsAdded: number;
  draftsUpdated: number;
  draftsSkipped: number;
  snippetsAdded: number;
  snippetsUpdated: number;
  snippetsSkipped: number;
  settingsImported: boolean;
}

export interface DraftUpdatePayload {
  id: string;
  field: FieldContext;
  text: string;
  checkpoint: boolean;
}

export interface DestructiveEditPayload {
  id: string;
  field: FieldContext;
  previousText: string;
  currentText: string;
}

export interface ExportPayload {
  format: "draftvault-export";
  version: 1;
  exportedAt: number;
  drafts: Draft[];
  snippets: Snippet[];
  settings: Settings;
}

export type RuntimeMessage =
  | { type: "PREPARE_SITE_ACTIVATION"; origin: string; tabId: number; windowId: number }
  | { type: "CANCEL_SITE_ACTIVATION"; origin: string }
  | { type: "REGISTER_SITE"; origin: string }
  | { type: "UNREGISTER_SITE"; origin: string }
  | { type: "GET_SITE_STATUS"; origin: string }
  | { type: "DRAFT_UPDATE"; payload: DraftUpdatePayload }
  | { type: "DRAFT_DESTRUCTIVE_EDIT"; payload: DestructiveEditPayload }
  | { type: "DISMISS_DRAFT_RECOVERY"; id: string }
  | { type: "GET_FIELD_ASSIST"; field: FieldContext }
  | { type: "FIELD_FOCUSED"; field: FieldContext }
  | { type: "GET_ACTIVE_FIELD"; tabId: number }
  | { type: "LIST_DRAFTS"; origin?: string }
  | { type: "DELETE_DRAFT"; id: string }
  | { type: "BATCH_DELETE_DRAFTS"; ids: string[] }
  | { type: "EXTEND_DRAFT"; id: string }
  | { type: "BATCH_EXTEND_DRAFTS"; ids: string[] }
  | { type: "PROMOTE_DRAFT"; id: string; title: string; category: string; tags: string[] }
  | { type: "LIST_SNIPPETS" }
  | { type: "SAVE_SNIPPET"; snippet: Partial<Snippet> & Pick<Snippet, "title" | "content"> }
  | { type: "DELETE_SNIPPET"; id: string }
  | { type: "GET_SUGGESTIONS"; field: FieldContext }
  | { type: "SNIPPET_USED"; id: string }
  | { type: "INSERT_TEXT"; tabId: number; text: string; snippetId?: string }
  | { type: "GET_STATS" }
  | { type: "EXPORT_DATA" }
  | { type: "IMPORT_DATA"; data: unknown }
  | { type: "CLEAR_ALL_DATA" };
