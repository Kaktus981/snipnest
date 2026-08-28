const sampleTexts = {
  intro: [
    "我是一名喜欢把复杂问题整理清楚的前端开发者，拥有三年项目经验，曾负责企业管理平台的组件库和权限系统建设。",
    "测"
  ],
  history: [
    "我参与了企业管理平台的开发，主要负责页面实现和日常问题修复，这是项目经历的第一个测试版本。",
    "我负责企业管理平台的前端架构和组件库建设，通过统一设计规范减少了重复开发，这是修改后的第二个测试版本。",
    "我主导企业管理平台的组件库和权限系统建设，并推动自动化测试落地，使常用页面的交付效率得到提升，这是最终测试版本。"
  ],
  rich: [
    "这个项目从需求梳理开始，经过原型验证、功能开发和质量检查，最终按计划完成交付。这是一段用于测试富文本保护的虚构内容。"
  ],
  dynamic: [
    "这是页面加载完成后才创建的动态输入框，用来确认文栈能够识别后来出现的表单元素并正常保存草稿。"
  ]
};

const checks = [...document.querySelectorAll("[data-test-check]")];
const progressStorageKey = "snipnest-test-progress";
const legacyProgressStorageKey = "draftvault-test-progress";
const progressNumber = document.getElementById("progress-number");
const progressBar = document.getElementById("progress-bar");
const progressMessage = document.getElementById("progress-message");
const successPanel = document.getElementById("success-panel");
const toast = document.getElementById("toast");
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function updateProgress() {
  const completed = checks.filter((check) => check.checked).length;
  progressNumber.textContent = `${completed} / ${checks.length}`;
  progressBar.style.width = `${(completed / checks.length) * 100}%`;
  progressMessage.textContent = completed === checks.length
    ? "全部完成，你已经走通文栈的核心使用流程。"
    : `还有 ${checks.length - completed} 项，按页面顺序继续即可。`;
  successPanel.hidden = completed !== checks.length;
  localStorage.setItem(progressStorageKey, JSON.stringify(checks.map((check) => check.checked)));
}

try {
  const saved = JSON.parse(
    localStorage.getItem(progressStorageKey) || localStorage.getItem(legacyProgressStorageKey) || "[]"
  );
  checks.forEach((check, index) => { check.checked = Boolean(saved[index]); });
} catch {}
checks.forEach((check) => check.addEventListener("change", updateProgress));
updateProgress();

document.getElementById("reset-progress").addEventListener("click", () => {
  checks.forEach((check) => { check.checked = false; });
  updateProgress();
  showToast("测试进度已重置，插件中的草稿和片段没有被删除。 ");
});

function setFieldValue(element, value) {
  if (element.isContentEditable) element.textContent = value;
  else element.value = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.focus();
  setTimeout(() => element.blur(), 120);
}

document.querySelectorAll("[data-fill]").forEach((button) => {
  button.addEventListener("click", () => {
    const group = button.dataset.fill;
    const version = Number(button.dataset.version || 1) - 1;
    const targets = { intro: "intro", history: "history-text", rich: "rich-editor" };
    const target = document.getElementById(targets[group]);
    setFieldValue(target, sampleTexts[group][version]);
    showToast("已填入虚构测试文字。请等待2秒，或继续下一步。 ");
  });
});

const intro = document.getElementById("intro");
intro.addEventListener("input", () => {
  document.getElementById("intro-count").textContent = `${intro.value.length} 字`;
  const status = document.getElementById("intro-status");
  status.textContent = intro.value.trim().length >= 1 ? "符合保存条件" : "等待输入";
  status.classList.toggle("active", intro.value.trim().length >= 1);
});

document.getElementById("reload-page").addEventListener("click", () => {
  showToast("2秒后刷新页面，请不要关闭测试网站窗口。 ");
  setTimeout(() => location.reload(), 2000);
});

const historyField = document.getElementById("history-text");
historyField.addEventListener("input", () => {
  const output = document.getElementById("history-event");
  output.textContent = `收到 input 事件，当前 ${historyField.value.length} 字`;
  output.parentElement.classList.add("success");
});

document.getElementById("clear-history").addEventListener("click", () => {
  if (historyField.value.trim().length < 20) {
    showToast("请先点击第三版按钮并等待2秒，再测试误删保护。 ");
    return;
  }
  setFieldValue(historyField, "");
  showToast("已模拟一次性清空。请查看“文”面板或侧边栏中的疑似误删提示。 ");
});

document.getElementById("add-dynamic").addEventListener("click", (event) => {
  const container = document.getElementById("dynamic-field");
  if (container.querySelector("textarea")) {
    container.querySelector("textarea").focus();
    return;
  }
  const label = document.createElement("label");
  label.htmlFor = "dynamic-notes";
  label.textContent = "动态补充说明";
  const textarea = document.createElement("textarea");
  textarea.id = "dynamic-notes";
  textarea.name = "dynamic_notes";
  textarea.placeholder = "这是页面加载后才出现的输入框";
  const fill = document.createElement("button");
  fill.type = "button";
  fill.className = "soft-button full";
  fill.textContent = "填入动态字段测试文字";
  fill.addEventListener("click", () => setFieldValue(textarea, sampleTexts.dynamic[0]));
  container.append(label, textarea, fill);
  event.currentTarget.textContent = "✓ 动态输入框已创建";
  event.currentTarget.disabled = true;
  textarea.focus();
  showToast("动态输入框已创建，文栈应该能够识别它。 ");
});

const insertTarget = document.getElementById("intro-target");
insertTarget.addEventListener("input", (event) => {
  const output = document.getElementById("insert-event");
  const consoleBox = output.parentElement;
  output.textContent = event.isTrusted
    ? `收到人工输入事件，当前 ${insertTarget.value.length} 字`
    : `成功收到插件触发的 input 事件，当前 ${insertTarget.value.length} 字`;
  consoleBox.classList.add("success");
});
