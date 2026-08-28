void (async () => {
  const marker = "__draftvaultInitialized";
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  if (scope[marker]) return;
  scope[marker] = true;

  const status = await chrome.runtime
    .sendMessage({ type: "GET_SITE_STATUS", origin: location.origin })
    .catch(() => null);
  if (!status?.ok || !status.enabled) {
    delete scope[marker];
    return;
  }

  type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

  interface FieldContext {
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

  interface DraftAssist {
    id: string;
    latestText: string;
    updatedAt: number;
    recovery?: {
      text: string;
      createdAt: number;
      beforeCharCount: number;
      afterCharCount: number;
    };
  }

  interface SuggestionAssist {
    snippet: { id: string; title: string; content: string; category: string };
    score: number;
    reasons: string[];
  }

  const sensitiveTerms = [
    "password",
    "passwd",
    "passcode",
    "otp",
    "verification",
    "captcha",
    "credit card",
    "card number",
    "cvv",
    "cvc",
    "bank account",
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
  const sensitiveUrlTerms = ["checkout", "payment", "/pay/", "bank", "wallet", "收银台", "支付"];
  let enabled = !sensitiveUrlTerms.some((term) => location.href.toLowerCase().includes(term));
  let autoSaveEnabled = status.autoSaveEnabled !== false;
  let activeField: Editable | null = null;
  let activeContext: FieldContext | null = null;
  let currentAssist: { draft?: DraftAssist; suggestions: SuggestionAssist[] } = { suggestions: [] };
  const state = new Map<Editable, { debounce?: number; checkpoint?: number; lastValue?: string }>();

  function hash(value: string): string {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function normalizedPath(): string {
    return (location.pathname.replace(/\/+$/, "") || "/")
      .split("/")
      .map((part) => (/^\d{3,}$/.test(part) || /^[a-f0-9-]{16,}$/i.test(part) ? ":id" : part))
      .join("/");
  }

  function fieldLabel(element: Editable): string {
    const ariaLabelledBy = element.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      const text = ariaLabelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label?.textContent?.trim()) return label.textContent.trim();
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim().slice(0, 120);
    return "";
  }

  function domHint(element: Editable): string {
    if (element.id) return `#${element.id}`;
    const name = element.getAttribute("name");
    if (name) return `[name="${name}"]`;
    const siblings = element.parentElement
      ? [...element.parentElement.children].filter((child) => child.tagName === element.tagName)
      : [];
    return `${element.tagName.toLowerCase()}:${Math.max(0, siblings.indexOf(element))}`;
  }

  function isEditable(target: EventTarget | null): target is Editable {
    if (!(target instanceof HTMLElement)) return false;
    if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
    if (target instanceof HTMLInputElement) {
      return ["text", "search", "url"].includes(target.type) && !target.disabled && !target.readOnly;
    }
    return target.isContentEditable;
  }

  function isSensitive(element: Editable): boolean {
    if (element instanceof HTMLInputElement && ["password", "hidden", "file"].includes(element.type)) {
      return true;
    }
    const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
    if (/cc-|one-time-code|password/.test(autocomplete)) return true;
    const combined = [
      element.id,
      element.getAttribute("name"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      fieldLabel(element)
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return sensitiveTerms.some((term) => combined.includes(term));
  }

  function contextFor(element: Editable): FieldContext {
    const label = fieldLabel(element);
    const ariaLabel = element.getAttribute("aria-label") ?? "";
    const placeholder = element.getAttribute("placeholder") ?? "";
    const name = element.getAttribute("name") ?? "";
    const inputType = element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase();
    const maxLength =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.maxLength > 0
          ? element.maxLength
          : null
        : null;
    const hint = domHint(element);
    const base = {
      origin: location.origin,
      pathname: normalizedPath(),
      pageUrl: `${location.origin}${location.pathname}`,
      pageTitle: document.title,
      label,
      ariaLabel,
      placeholder,
      name,
      inputType,
      maxLength,
      domHint: hint
    };
    const fingerprint = `field_${hash(
      [location.origin, base.pathname, label, ariaLabel, placeholder, name, inputType, hint]
        .map((part) => part.trim().toLowerCase())
        .join("|")
    )}`;
    return { ...base, fingerprint };
  }

  function readValue(element: Editable): string {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
    return element.innerText || element.textContent || "";
  }

  function writeValue(element: Editable, text: string): void {
    if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, text);
    } else if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, text);
    } else {
      element.textContent = text;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.focus();
  }

  function destructiveEdit(previousText: string, currentText: string): boolean {
    const before = previousText.trim().length;
    const after = currentText.trim().length;
    return before >= 20 && after <= Math.floor(before * 0.2);
  }

  async function save(element: Editable, checkpoint: boolean): Promise<void> {
    if (!enabled || isSensitive(element)) return;
    if (!autoSaveEnabled) {
      setSaveStatus("误删保护中", "warning");
      return;
    }
    const text = readValue(element).trim();
    if (!text) {
      setSaveStatus("空白未覆盖", "muted");
      return;
    }
    const field = contextFor(element);
    setSaveStatus("正在保存…", "saving");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "DRAFT_UPDATE",
        payload: { id: `draft_${field.fingerprint}`, field, text, checkpoint }
      });
      if (!response?.ok) throw new Error(response?.error ?? "保存失败");
      if (response.reason === "auto-save-disabled") {
        autoSaveEnabled = false;
        setSaveStatus("误删保护中", "warning");
      } else if (response.reason === "below-minimum") {
        setSaveStatus(`需${response.minimum}字`, "muted");
      } else if (response.unchanged) {
        setSaveStatus("内容未变化", "muted");
      } else if (response.draft) {
        currentAssist = { ...currentAssist, draft: response.draft };
        setSaveStatus("已保存", "saved");
      }
    } catch {
      setSaveStatus("保存失败", "error");
    }
  }

  function scheduleSave(element: Editable): void {
    if (!autoSaveEnabled) return;
    const item = state.get(element) ?? { lastValue: readValue(element) };
    if (item.debounce) window.clearTimeout(item.debounce);
    item.debounce = window.setTimeout(() => void save(element, false), 800);
    if (!item.checkpoint) {
      item.checkpoint = window.setTimeout(() => {
        void save(element, true);
        const latest = state.get(element);
        if (latest) latest.checkpoint = undefined;
      }, 30_000);
    }
    state.set(element, item);
  }

  function clearScheduledSaves(): void {
    state.forEach((item) => {
      if (item.debounce) window.clearTimeout(item.debounce);
      if (item.checkpoint) window.clearTimeout(item.checkpoint);
      item.debounce = undefined;
      item.checkpoint = undefined;
    });
  }

  const host = document.createElement("div");
  host.id = "draftvault-assistant-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .dv-wrap { position: fixed; z-index: 2147483646; display: none; font: 13px/1.5 "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei UI", "Segoe UI Variable", system-ui, sans-serif; color: #2d2926; letter-spacing: .005em; }
    .dv-pill { width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.45); border-radius: 11px; color: white; cursor: pointer; background: linear-gradient(140deg,#d98561 0%,#b45a3c 58%,#88402e 100%); box-shadow: 0 9px 24px rgba(137,64,46,.3), inset 0 1px rgba(255,255,255,.28); font: 700 15px/1 "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; }
    .dv-pill:hover { transform: translateY(-1px); box-shadow: 0 11px 27px rgba(137,64,46,.36), inset 0 1px rgba(255,255,255,.28); }
    .dv-panel { width: 292px; margin-top: 8px; padding: 13px; border: 1px solid rgba(232,222,210,.9); border-radius: 17px; background: rgba(255,253,248,.98); box-shadow: 0 18px 55px rgba(71,46,32,.24); backdrop-filter: blur(18px); display: none; }
    .dv-panel.open { display: block; }
    .dv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
    .dv-brand { font: 680 14px/1.2 "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; letter-spacing: -.02em; }
    .dv-safe { font-size: 11px; color: #2e7460; background: #e7f2ed; padding: 4px 8px; border: 1px solid #c8e1d6; border-radius: 99px; }
    .dv-safe.saving { color: #88402e; background: #f7e9e3; border-color: #ead4c9; }
    .dv-safe.muted { color: #756b63; background: #f0ece5; border-color: #e1d6ca; }
    .dv-safe.error { color: #ad4b4b; background: #faeaea; border-color: #edcaca; }
    .dv-safe.warning { color: #a66d22; background: #fbf0d9; border-color: #f1d595; }
    .dv-section { border-top: 1px solid #e8ded2; padding-top: 10px; margin-top: 10px; }
    .dv-label { font-size: 10px; color: #756b63; margin-bottom: 6px; font-weight: 680; letter-spacing: .06em; }
    .dv-item { display: block; width: 100%; text-align: left; border: 1px solid #e8ded2; background: #f4f0e8; border-radius: 11px; padding: 9px 10px; margin-top: 6px; cursor: pointer; color: #433a34; transition: background .16s ease, border-color .16s ease, transform .16s ease; }
    .dv-item:hover { background: #fff9f3; border-color: #d7c2b5; transform: translateY(-1px); }
    .dv-item.warning { background: #fbf0d9; color: #805612; border-color: #f1d595; }
    .dv-actions { display: flex; gap: 6px; margin-top: 7px; }
    .dv-action { flex: 1; border: 0; border-radius: 9px; padding: 8px; cursor: pointer; font: inherit; font-size: 11px; transition: transform .16s ease, filter .16s ease; }
    .dv-action:hover { transform: translateY(-1px); filter: brightness(.98); }
    .dv-action.restore { color: white; background: linear-gradient(135deg,#c56d4d,#a94f35); box-shadow: 0 6px 14px rgba(169,79,53,.2); }
    .dv-action.dismiss { color: #756b63; background: #f0ece5; }
    .dv-title { display: block; font-weight: 680; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dv-preview { display: block; margin-top: 3px; color: #756b63; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dv-empty { color: #9a8f84; font-size: 12px; padding: 5px 0; }
    @media (prefers-color-scheme: dark) {
      .dv-panel { background: rgba(41,39,36,.98); border-color: #684238; color: #f4eee6; }
      .dv-brand { color: #f4eee6; } .dv-section { border-color: #49413a; }
      .dv-item { background: #322d29; color: #f4eee6; border-color: #49413a; } .dv-item:hover { background: #413832; border-color: #66594e; }
      .dv-safe.saving { color: #e4a88f; background: #4a3029; border-color: #684238; }
      .dv-safe.muted { color: #b8a99a; background: #322d29; border-color: #49413a; }
      .dv-safe.error { color: #e89a9a; background: #492c2e; border-color: #713d3f; }
      .dv-safe.warning { color: #e6b667; background: #4b3922; border-color: #72572d; }
      .dv-item.warning { background: #4b3922; color: #f0c77d; border-color: #72572d; }
      .dv-action.dismiss { color: #b8a99a; background: #322d29; }
      .dv-preview { color: #b8a99a; }
      .dv-empty { color: #9d9186; }
    }
  `;
  const wrap = document.createElement("div");
  wrap.className = "dv-wrap";
  wrap.innerHTML = `
    <button class="dv-pill" type="button" title="打开文栈">文</button>
    <div class="dv-panel">
      <div class="dv-head"><span class="dv-brand">文栈 SnipNest</span><span class="dv-safe saved">保护中</span></div>
      <div class="dv-content"></div>
    </div>`;
  shadow.append(style, wrap);
  document.documentElement.append(host);
  const pill = wrap.querySelector<HTMLButtonElement>(".dv-pill")!;
  const panel = wrap.querySelector<HTMLElement>(".dv-panel")!;
  const content = wrap.querySelector<HTMLElement>(".dv-content")!;
  const saveStatus = wrap.querySelector<HTMLElement>(".dv-safe")!;

  function setSaveStatus(text: string, stateName: "saved" | "saving" | "muted" | "error" | "warning"): void {
    saveStatus.textContent = text;
    saveStatus.className = `dv-safe ${stateName}`;
  }

  function positionAssistant(): void {
    if (!activeField || wrap.style.display === "none") return;
    const rect = activeField.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 304, Math.max(8, rect.right - 30));
    const top = Math.min(window.innerHeight - 40, Math.max(8, rect.top + 4));
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
  }

  function renderAssist(): void {
    content.replaceChildren();
    if (currentAssist.draft?.recovery && activeField) {
      const section = document.createElement("div");
      section.innerHTML = `<div class="dv-label">疑似误删保护</div>`;
      const preview = document.createElement("div");
      preview.className = "dv-item warning";
      preview.innerHTML = `<span class="dv-title">已保留删除前的 ${currentAssist.draft.recovery.beforeCharCount} 字</span><span class="dv-preview"></span>`;
      preview.querySelector<HTMLElement>(".dv-preview")!.textContent = currentAssist.draft.recovery.text.slice(0, 60);
      const actions = document.createElement("div");
      actions.className = "dv-actions";
      const restore = document.createElement("button");
      restore.className = "dv-action restore";
      restore.textContent = "恢复删除前内容";
      const dismiss = document.createElement("button");
      dismiss.className = "dv-action dismiss";
      dismiss.textContent = "忽略提醒";
      [restore, dismiss].forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));
      restore.addEventListener("click", () => {
        if (!activeField || !currentAssist.draft?.recovery) return;
        writeValue(activeField, currentAssist.draft.recovery.text);
        void chrome.runtime.sendMessage({ type: "DISMISS_DRAFT_RECOVERY", id: currentAssist.draft.id });
        delete currentAssist.draft.recovery;
        setSaveStatus("已恢复", "saved");
        renderAssist();
      });
      dismiss.addEventListener("click", () => {
        if (!currentAssist.draft) return;
        void chrome.runtime.sendMessage({ type: "DISMISS_DRAFT_RECOVERY", id: currentAssist.draft.id });
        delete currentAssist.draft.recovery;
        setSaveStatus("已忽略提醒", "muted");
        renderAssist();
      });
      actions.append(restore, dismiss);
      section.append(preview, actions);
      content.append(section);
    }
    if (currentAssist.draft && !currentAssist.draft.recovery && activeField && currentAssist.draft.latestText !== readValue(activeField)) {
      const section = document.createElement("div");
      section.innerHTML = `<div class="dv-label">可恢复草稿</div>`;
      const button = document.createElement("button");
      button.className = "dv-item";
      button.innerHTML = `<span class="dv-title">恢复上次内容</span><span class="dv-preview"></span>`;
      button.querySelector<HTMLElement>(".dv-preview")!.textContent = currentAssist.draft.latestText.slice(0, 60);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (activeField) writeValue(activeField, currentAssist.draft!.latestText);
        panel.classList.remove("open");
      });
      section.append(button);
      content.append(section);
    }
    if (currentAssist.suggestions.length) {
      const section = document.createElement("div");
      section.className = "dv-section";
      section.innerHTML = `<div class="dv-label">推荐片段</div>`;
      currentAssist.suggestions.forEach((suggestion) => {
        const button = document.createElement("button");
        button.className = "dv-item";
        const title = document.createElement("span");
        title.className = "dv-title";
        title.textContent = suggestion.snippet.title;
        const preview = document.createElement("span");
        preview.className = "dv-preview";
        preview.textContent = suggestion.snippet.content.slice(0, 60);
        button.append(title, preview);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          if (activeField) writeValue(activeField, suggestion.snippet.content);
          void chrome.runtime.sendMessage({
            type: "SNIPPET_USED",
            id: suggestion.snippet.id
          }).catch(() => undefined);
          panel.classList.remove("open");
        });
        section.append(button);
      });
      content.append(section);
    }
    if (!content.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "dv-empty";
      empty.textContent = "正在保护当前输入，暂无可恢复内容或推荐片段。";
      content.append(empty);
    }
  }

  async function focusField(element: Editable): Promise<void> {
    if (!enabled || isSensitive(element)) {
      wrap.style.display = "none";
      return;
    }
    activeField = element;
    activeContext = contextFor(element);
    const item = state.get(element) ?? {};
    item.lastValue = readValue(element);
    state.set(element, item);
    currentAssist = { suggestions: [] };
    setSaveStatus(autoSaveEnabled ? "保护中" : "误删保护中", autoSaveEnabled ? "saved" : "warning");
    renderAssist();
    wrap.style.display = "block";
    panel.classList.remove("open");
    positionAssistant();
    void chrome.runtime.sendMessage({ type: "FIELD_FOCUSED", field: activeContext });
    const response = await chrome.runtime.sendMessage({ type: "GET_FIELD_ASSIST", field: activeContext });
    if (response?.ok && activeContext?.fingerprint === contextFor(element).fingerprint) {
      currentAssist = { draft: response.draft, suggestions: response.suggestions ?? [] };
      renderAssist();
    }
  }

  pill.addEventListener("mousedown", (event) => event.preventDefault());
  pill.addEventListener("click", () => panel.classList.toggle("open"));
  panel.addEventListener("mousedown", (event) => event.preventDefault());
  window.addEventListener("scroll", positionAssistant, true);
  window.addEventListener("resize", positionAssistant);

  document.addEventListener("focusin", (event) => {
    if (isEditable(event.target)) void focusField(event.target);
  });
  document.addEventListener("input", (event) => {
    if (isEditable(event.target) && !isSensitive(event.target)) {
      const element = event.target;
      const item = state.get(element) ?? {};
      const currentText = readValue(element);
      const previousText = item.lastValue ?? currentText;
      item.lastValue = currentText;
      state.set(element, item);
      if (destructiveEdit(previousText, currentText)) {
        const field = contextFor(element);
        setSaveStatus("已保护误删内容", "warning");
        void chrome.runtime.sendMessage({
          type: "DRAFT_DESTRUCTIVE_EDIT",
          payload: {
            id: `draft_${field.fingerprint}`,
            field,
            previousText,
            currentText
          }
        }).then((response) => {
          if (response?.ok && response.draft) {
            currentAssist = { ...currentAssist, draft: response.draft };
            renderAssist();
            panel.classList.add("open");
          }
        }).catch(() => setSaveStatus("保护失败", "error"));
      }
      if (autoSaveEnabled) scheduleSave(element);
      else if (!destructiveEdit(previousText, currentText)) setSaveStatus("误删保护中", "warning");
    }
  });
  document.addEventListener("focusout", (event) => {
    if (autoSaveEnabled && isEditable(event.target) && !isSensitive(event.target)) void save(event.target, true);
    window.setTimeout(() => {
      const focused = document.activeElement;
      if (!isEditable(focused) && !panel.classList.contains("open")) wrap.style.display = "none";
    }, 120);
  });
  window.addEventListener("pagehide", () => {
    if (autoSaveEnabled) state.forEach((_value, element) => void save(element, true));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings?.newValue) return;
    const next = changes.settings.newValue as { autoSaveEnabled?: unknown };
    autoSaveEnabled = next.autoSaveEnabled !== false;
    if (!autoSaveEnabled) clearScheduledSaves();
    setSaveStatus(autoSaveEnabled ? "保护中" : "误删保护中", autoSaveEnabled ? "saved" : "warning");
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DRAFTVAULT_DISABLE") {
      enabled = false;
      delete scope[marker];
      wrap.remove();
      state.forEach((item) => {
        if (item.debounce) clearTimeout(item.debounce);
        if (item.checkpoint) clearTimeout(item.checkpoint);
      });
      state.clear();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "DRAFTVAULT_INSERT_TEXT") {
      if (activeField && document.contains(activeField)) {
        writeValue(activeField, String(message.text ?? ""));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "请先点击一个可编辑的长文本字段" });
      }
    }
  });
})();
