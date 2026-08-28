import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanupExpired,
  clearAllData,
  deleteDrafts,
  dismissDraftRecovery,
  extendDrafts,
  exportData,
  getDraft,
  listDrafts,
  listSnippets,
  promoteDraft,
  protectDraftRecovery,
  upsertDraft
} from "./db";
import { DEFAULT_SETTINGS, type DraftUpdatePayload, type FieldContext } from "./types";

function field(): FieldContext {
  return {
    origin: "https://example.com",
    pathname: "/form",
    pageUrl: "https://example.com/form",
    pageTitle: "报名表",
    label: "个人介绍",
    ariaLabel: "",
    placeholder: "请输入个人介绍",
    name: "intro",
    inputType: "textarea",
    maxLength: null,
    domHint: "#intro",
    fingerprint: "field_intro"
  };
}

function update(text: string, checkpoint = true): DraftUpdatePayload {
  return { id: "draft_field_intro", field: field(), text, checkpoint };
}

beforeEach(async () => {
  await clearAllData();
});

describe("草稿数据库", () => {
  it("更新最新文本并限制历史版本为5份", async () => {
    for (let index = 0; index < 7; index += 1) {
      await upsertDraft(update(`第${index}次填写的个人介绍，内容长度已经超过二十个字符。`), DEFAULT_SETTINGS, 1000 + index);
    }
    const draft = await getDraft("draft_field_intro");
    expect(draft?.versions).toHaveLength(5);
    expect(draft?.latestText).toContain("第6次");
    expect(draft?.versions[0].text).toContain("第6次");
  });

  it("清理过期草稿但保留未过期草稿", async () => {
    await upsertDraft(update("这是一段需要在网页刷新后恢复的足够长的个人介绍内容。"), DEFAULT_SETTINGS, 1000);
    expect(await cleanupExpired(999)).toBe(0);
    expect(await cleanupExpired(1000 + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await listDrafts()).toEqual([]);
  });

  it("将草稿升级为永久片段并删除原草稿", async () => {
    await upsertDraft(update("我拥有三年前端开发经验，负责过组件库和权限系统。"), DEFAULT_SETTINGS, 1000);
    const snippet = await promoteDraft("draft_field_intro", "前端个人介绍", "求职", ["前端", "经验"]);
    expect(snippet?.title).toBe("前端个人介绍");
    expect(await getDraft("draft_field_intro")).toBeUndefined();
    expect(await listSnippets()).toHaveLength(1);
  });

  it("导出带版本标记的本地数据", async () => {
    await upsertDraft(update("这是一段用于验证导出结构的长文本草稿内容。"), DEFAULT_SETTINGS, 1000);
    const data = await exportData(DEFAULT_SETTINGS);
    expect(data.format).toBe("draftvault-export");
    expect(data.version).toBe(1);
    expect(data.drafts).toHaveLength(1);
  });

  it("保存1字草稿并跳过相同内容的重复写入", async () => {
    const first = await upsertDraft(update("文", false), DEFAULT_SETTINGS, 1000);
    const duplicate = await upsertDraft(update("文", true), DEFAULT_SETTINGS, 2000);
    expect(first.latestText).toBe("文");
    expect(duplicate.updatedAt).toBe(1000);
    expect(duplicate.versions).toEqual([]);
  });

  it("保存、忽略意外清空恢复快照", async () => {
    const previousText = "这是一段至少二十个字符的内容，用于确认意外清空时不会丢失。";
    const payload = {
      id: "draft_field_intro",
      field: field(),
      previousText,
      currentText: ""
    };
    const protectedDraft = await protectDraftRecovery(payload, DEFAULT_SETTINGS, 1000);
    expect(protectedDraft.recovery?.text).toBe(previousText);
    expect(protectedDraft.latestText).toBe(previousText);
    const dismissed = await dismissDraftRecovery(protectedDraft.id);
    expect(dismissed?.recovery).toBeUndefined();
  });

  it("批量延长和删除草稿", async () => {
    await upsertDraft(update("甲", false), DEFAULT_SETTINGS, 1000);
    await upsertDraft({ ...update("乙", false), id: "draft_other" }, DEFAULT_SETTINGS, 1001);
    expect(await extendDrafts(["draft_field_intro", "draft_other"], 2000)).toBe(2);
    expect((await listDrafts()).every((draft) => draft.status === "extended")).toBe(true);
    expect(await deleteDrafts(["draft_field_intro", "draft_other"])).toBe(2);
    expect(await listDrafts()).toEqual([]);
  });
});
