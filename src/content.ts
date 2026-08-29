void (async () => {
  const marker = "__draftvaultInitialized";
  const assistantHostId = "draftvault-assistant-host";
  const assistantUiVersion = "snipnest-assistant-v3";
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  const existingAssistantHosts = document.querySelectorAll(`#${assistantHostId}`);
  if (scope[marker] === assistantUiVersion && existingAssistantHosts.length === 1) return;

  // Extension reloads can invalidate the old isolated world while leaving its
  // closed-shadow host in the page DOM. Remove every stale host before mounting
  // the current UI so multiple assistant versions can never overlap visually.
  existingAssistantHosts.forEach((node) => node.remove());
  scope[marker] = assistantUiVersion;

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
      setSaveStatus("误删时可恢复", "warning");
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
        setSaveStatus("误删时可恢复", "warning");
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
  host.id = assistantHostId;
  host.dataset.snipnestAssistantVersion = assistantUiVersion;
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .dv-wrap { position: fixed; z-index: 2147483646; display: none; width: 26px; font: 13px/1.5 "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei UI", "Segoe UI Variable", system-ui, sans-serif; color: #1e2b2d; letter-spacing: .005em; }
    .dv-pill { box-sizing: border-box; display: grid; width: 26px; height: 26px; overflow: hidden; padding: 0; place-items: center; border: 0; border-radius: 6px; cursor: pointer; background: transparent; box-shadow: none; transition: transform .14s ease, filter .14s ease; }
    .dv-pill:hover { filter: brightness(.96) saturate(1.05); transform: translateY(-1px); }
    .dv-pill:focus-visible { outline: 2px solid rgba(96,109,161,.38); outline-offset: 2px; }
    .dv-pill svg { display: block; width: 26px; height: 26px; }
    .dv-panel { box-sizing: border-box; position: absolute; top: 34px; right: 0; width: 292px; margin: 0; padding: 13px; border: 1px solid #bec9c9; border-radius: 8px; background: #fcfaf4; display: none; }
    .dv-panel.open { display: block; }
    .dv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
    .dv-brand { font: 680 14px/1.2 "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; letter-spacing: -.02em; }
    .dv-safe { font-size: 11px; color: #55745f; background: #e4ede5; padding: 4px 8px; border: 1px solid #c5d8c9; border-radius: 99px; }
    .dv-safe.saving { color: #1f4352; background: #dce7e9; border-color: #b7c9cc; }
    .dv-safe.muted { color: #708086; background: #f3f6f2; border-color: #d8d8ce; }
    .dv-safe.error { color: #a45143; background: #f5e5e0; border-color: #dfbdb5; }
    .dv-safe.warning { color: #936c2f; background: #f3ead8; border-color: #ddc99d; }
    .dv-section { border-top: 1px solid #d8d8ce; padding-top: 10px; margin-top: 10px; }
    .dv-label { font-size: 10px; color: #708086; margin-bottom: 6px; font-weight: 680; letter-spacing: .06em; }
    .dv-item { display: block; width: 100%; text-align: left; border: 1px solid #d8d8ce; background: #f3f6f2; border-radius: 5px; padding: 9px 10px; margin-top: 6px; cursor: pointer; color: #1f4352; transition: background .16s ease, border-color .16s ease; }
    .dv-item:hover { background: #dce7e9; border-color: #b58a45; }
    .dv-item.warning { background: #f3ead8; color: #765a2b; border-color: #d9bf82; }
    .dv-actions { display: flex; gap: 6px; margin-top: 7px; }
    .dv-action { flex: 1; border: 1px solid transparent; border-radius: 5px; padding: 8px; cursor: pointer; font: inherit; font-size: 11px; transition: background .16s ease, border-color .16s ease; }
    .dv-action:hover { filter: brightness(.98); }
    .dv-action.restore { color: #fff; background: #1f4352; border-color: #b58a45; }
    .dv-action.dismiss { color: #708086; background: #f3f6f2; border-color: #d8d8ce; }
    .dv-title { display: block; font-weight: 680; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dv-preview { display: block; margin-top: 3px; color: #708086; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dv-empty { color: #8a9694; font-size: 12px; padding: 5px 0; }
    @media (prefers-color-scheme: dark) {
      .dv-panel { background: #223237; border-color: #5b7073; color: #edf1e9; }
      .dv-brand { color: #edf1e9; } .dv-section { border-color: #3c5054; }
      .dv-item { background: #19272b; color: #edf1e9; border-color: #3c5054; } .dv-item:hover { background: #29434c; border-color: #c5a05b; }
      .dv-safe.saving { color: #c3d6d8; background: #29434c; border-color: #52727b; }
      .dv-safe.muted { color: #a8b6b5; background: #19272b; border-color: #3c5054; }
      .dv-safe.error { color: #e9aaa0; background: #452d2b; border-color: #754c46; }
      .dv-safe.warning { color: #e1bd76; background: #463b28; border-color: #725e35; }
      .dv-item.warning { background: #463b28; color: #e5c17b; border-color: #725e35; }
      .dv-action.dismiss { color: #a8b6b5; background: #19272b; border-color: #3c5054; }
      .dv-preview { color: #a8b6b5; }
      .dv-empty { color: #96a3a1; }
    }
  `;
  const wrap = document.createElement("div");
  wrap.className = "dv-wrap";
  wrap.innerHTML = `
    <button class="dv-pill" type="button" title="打开文栈" aria-label="打开文栈">
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <rect width="128" height="128" rx="24" fill="#606DA1"/>
        <g transform="translate(8 8) scale(.108)">
          <g transform="translate(0 850) scale(1 -1)">
            <path d="M71 -55 122 -34Q252 22 343 93Q410 145 456 198L466 212L457 221L342 339Q334 347 322 355Q310 363 299 370L287 379L280 388L330 407L333 408Q337 408 344 403L359 387Q405 336 454 286L493 246L503 259Q567 360 586 445Q591 468 591 488Q591 502 590 509L602 516L612 507L667 452L676 440L666 428Q656 416 647 399Q622 345 564 253L535 211L545 201Q634 124 705 76Q789 20 875 -5L933 -19L936 -38L902 -42L733 -57Q721 -57 712 -48L623 48L513 163L503 173L497 165Q397 53 239 -20Q171 -50 85 -78L80 -79Z" fill="#FFFAF7" stroke="#FFFAF7" stroke-width="24" stroke-linejoin="round"/>
            <path d="M91 528 97 541H121Q167 540 257 546L461 560L561 569Q588 571 615 575L644 578L719 588Q780 596 829 624L895 568L902 558Q904 554 904 552Q904 544 897 542Q894 541 887 540L729 535Q693 534 616 528L516 522L430 514L352 508L257 498Q235 496 161 485Z" fill="#FFFAF7" stroke="#FFFAF7" stroke-width="18" stroke-linejoin="round"/>
            <path d="M538 618Q533 618 526 623L523 627Q468 707 393 765L385 772V774L391 787L425 776L537 733L547 727Q564 718 565 699Q565 659 560 640Q557 625 544 619Q542 618 538 618Z" fill="#FB9966" stroke="#FB9966" stroke-width="18" stroke-linejoin="round"/>
          </g>
        </g>
      </svg>
    </button>
    <div class="dv-panel">
      <div class="dv-head"><span class="dv-brand">文栈 SnipNest</span><span class="dv-safe saved">自动保存中</span></div>
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
    const pillSize = 26;
    const edgeGap = 8;
    const fieldInset = 3;
    const centeredOffset = Math.max(0, (rect.height - pillSize) / 2);
    const topOffset = Math.min(6, centeredOffset);
    const left = Math.min(window.innerWidth - pillSize - edgeGap, Math.max(edgeGap, rect.right - pillSize - fieldInset));
    const top = Math.min(window.innerHeight - pillSize - edgeGap, Math.max(edgeGap, rect.top + topOffset));
    wrap.style.left = `${Math.round(left)}px`;
    wrap.style.top = `${Math.round(top)}px`;

    const alignPanelRight = left + pillSize >= panel.offsetWidth + edgeGap;
    panel.style.right = alignPanelRight ? "0" : "auto";
    panel.style.left = alignPanelRight ? "auto" : "0";

    const panelGap = 8;
    const panelHeight = panel.offsetHeight;
    const placeAbove = panel.classList.contains("open")
      && top + pillSize + panelGap + panelHeight > window.innerHeight - edgeGap
      && top - panelGap - panelHeight >= edgeGap;
    panel.style.top = placeAbove ? "auto" : `${pillSize + panelGap}px`;
    panel.style.bottom = placeAbove ? `${pillSize + panelGap}px` : "auto";
  }

  function renderAssist(): void {
    content.replaceChildren();
    if (currentAssist.draft?.recovery && activeField) {
      const section = document.createElement("div");
      section.innerHTML = `<div class="dv-label">可能误删</div>`;
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
      section.innerHTML = `<div class="dv-label">上次保存的内容</div>`;
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
      section.innerHTML = `<div class="dv-label">可插入的常用内容</div>`;
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
      empty.textContent = "输入后停顿片刻，文栈会自动保存一份本地备份。";
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
    setSaveStatus(autoSaveEnabled ? "自动保存中" : "误删时可恢复", autoSaveEnabled ? "saved" : "warning");
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
  pill.addEventListener("click", () => {
    panel.classList.toggle("open");
    positionAssistant();
  });
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
        setSaveStatus("已保留删除前内容", "warning");
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
        }).catch(() => setSaveStatus("保存失败", "error"));
      }
      if (autoSaveEnabled) scheduleSave(element);
      else if (!destructiveEdit(previousText, currentText)) setSaveStatus("误删时可恢复", "warning");
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
    setSaveStatus(autoSaveEnabled ? "自动保存中" : "误删时可恢复", autoSaveEnabled ? "saved" : "warning");
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
        sendResponse({ ok: false, error: "请先点击网页里的输入框" });
      }
    }
  });
})();
