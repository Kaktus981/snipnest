import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { hostPermissionPattern, isLikelySensitiveUrl } from "../shared/logic";
import "../styles.css";

interface TabInfo {
  id: number;
  windowId: number;
  url: string;
  title: string;
  origin: string;
}

function patternFor(origin: string): string {
  return hostPermissionPattern(origin);
}

function Popup(): React.ReactElement {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [granted, setGranted] = useState(false);
  const [permitted, setPermitted] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.id || active.windowId === undefined || !active.url || !/^https?:/.test(active.url)) {
        setBusy(false);
        return;
      }
      const origin = new URL(active.url).origin;
      setTab({ id: active.id, windowId: active.windowId, url: active.url, title: active.title ?? origin, origin });
      const status = await chrome.runtime.sendMessage({ type: "GET_SITE_STATUS", origin });
      setGranted(Boolean(status?.ok && status.enabled));
      setPermitted(Boolean(status?.ok && status.permitted));
      if (status?.ok && !status.enabled && !isLikelySensitiveUrl(active.url)) {
        const prepared = await chrome.runtime.sendMessage({
          type: "PREPARE_SITE_ACTIVATION",
          origin,
          tabId: active.id,
          windowId: active.windowId
        });
        if (!prepared?.ok) throw new Error(prepared?.error ?? "准备网站授权失败");
      }
      setBusy(false);
    })().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "读取当前网页失败");
      setBusy(false);
    });
  }, []);

  const risky = useMemo(() => (tab ? isLikelySensitiveUrl(tab.url) : false), [tab]);

  async function enableSite(): Promise<void> {
    if (!tab) return;
    setBusy(true);
    setError("");
    try {
      // Both calls must begin in the original click task. Either one may close
      // the popup, so the background permission listener completes activation.
      const panelPromise = chrome.sidePanel.open({ windowId: tab.windowId });
      if (!permitted) {
        const permissionPromise = chrome.permissions.request({ origins: [patternFor(tab.origin)] });
        const [accepted] = await Promise.all([permissionPromise, panelPromise]);
        if (!accepted) {
          await chrome.runtime.sendMessage({ type: "CANCEL_SITE_ACTIVATION", origin: tab.origin });
          throw new Error("你取消了网站授权，网站没有被启用");
        }
        setPermitted(true);
      } else {
        await panelPromise;
      }
      const response = await chrome.runtime.sendMessage({ type: "REGISTER_SITE", origin: tab.origin });
      if (!response?.ok) throw new Error(response?.error ?? "启用失败");
      setGranted(true);
      window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "启用失败");
    } finally {
      setBusy(false);
    }
  }

  async function disableSite(): Promise<void> {
    if (!tab) return;
    setBusy(true);
    setError("");
    try {
      const response = await chrome.runtime.sendMessage({ type: "UNREGISTER_SITE", origin: tab.origin });
      if (!response?.ok) throw new Error(response?.error ?? "停用失败");
      setGranted(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停用失败");
    } finally {
      setBusy(false);
    }
  }

  async function openPanel(): Promise<void> {
    if (!tab) return;
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  }

  return (
    <div className="app-shell" style={{ width: 350, minHeight: 410 }}>
      <header className="topbar">
        <div className="brand-mark">文</div>
        <div className="brand-copy">
          <h1 className="brand-title">文栈 SnipNest</h1>
          <div className="brand-subtitle">本地写作保护</div>
        </div>
      </header>
      <main className="content">
        {busy && !tab ? <div className="notice">正在读取当前网页…</div> : null}
        {!busy && !tab ? (
          <div className="card">
            <div className="empty">
              <div className="empty-icon">◇</div>
              <strong>当前页面无法启用保护</strong>
              Edge 设置页、新标签页和扩展商店等内部页面不允许扩展读取。
            </div>
          </div>
        ) : null}
        {tab ? (
          <>
            <section className="card site-card">
              <div className="row-between">
                <div className="grow">
                  <div className="section-label">当前网站</div>
                  <h2 className="card-title truncate">{tab.title}</h2>
                  <div className="card-description truncate">{tab.origin}</div>
                </div>
                <span className={`status ${risky ? "warning" : granted ? "success" : "muted"}`}>
                  {risky ? "敏感页面" : granted ? "保护中" : "未启用"}
                </span>
              </div>
              <div className={`notice ${risky ? "warning" : ""}`} style={{ marginTop: 13 }}>
                {risky
                  ? "当前网址疑似涉及支付或安全操作。文栈会额外过滤敏感字段，建议仅在确有需要时启用。"
                  : granted
                    ? "仅在这个网站保存符合条件的长文本，密码、验证码和支付字段不会记录。"
                    : "文栈尚未获得这个网站的读取权限，不会访问或保存页面输入。"}
              </div>
              <div className="button-row">
                {granted ? (
                  <button className="button danger" disabled={busy} onClick={() => void disableSite()}>
                    停止保护
                  </button>
                ) : (
                  <button className="button primary" disabled={busy || risky} onClick={() => void enableSite()}>
                    {risky ? "此页面自动禁用" : busy ? "正在启用…" : "保护并打开文栈"}
                  </button>
                )}
                <button className="button secondary" onClick={() => void openPanel()}>
                  打开文栈
                </button>
              </div>
            </section>
            <section className="local-disclosure">
              <span className="local-dot" aria-hidden="true" />
              <p>草稿仅保存在当前浏览器，临时内容默认 7 天后删除。</p>
            </section>
          </>
        ) : null}
        {error ? <div className="notice warning" style={{ marginTop: 12 }}>{error}</div> : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
);
