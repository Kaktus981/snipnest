import { describe, expect, it } from "vitest";
import { groupDrafts, isShortDraft } from "./draft-organize";
import type { Draft } from "./types";

function draft(id: string, overrides: Partial<Draft> = {}): Draft {
  return {
    id,
    origin: "https://example.com",
    pathname: "/form",
    pageUrl: "https://example.com/form",
    pageTitle: "报名表",
    field: {
      origin: "https://example.com",
      pathname: "/form",
      pageUrl: "https://example.com/form",
      pageTitle: "报名表",
      label: "个人介绍",
      ariaLabel: "",
      placeholder: "",
      name: "intro",
      inputType: "textarea",
      maxLength: null,
      domHint: "#intro",
      fingerprint: `field_${id}`
    },
    latestText: "普通草稿内容",
    versions: [],
    status: "temporary",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 999,
    ...overrides
  };
}

describe("草稿整理", () => {
  it("识别1至9字短草稿", () => {
    expect(isShortDraft(draft("short", { latestText: "短文字" }))).toBe(true);
    expect(isShortDraft(draft("long", { latestText: "这是一段十个字以上的草稿内容" }))).toBe(false);
  });

  it("支持网站和字段分组", () => {
    const values = [
      draft("a"),
      draft("b", { origin: "https://other.example", field: { ...draft("b").field, label: "项目经历" } })
    ];
    expect(groupDrafts(values, "site")).toHaveLength(2);
    expect(groupDrafts(values, "field").map((group) => group.label)).toEqual(["个人介绍", "项目经历"]);
  });

  it("日期分组按今天、昨天、近7天和更早排序", () => {
    const now = new Date("2026-08-25T12:00:00+08:00").getTime();
    const day = 24 * 60 * 60 * 1000;
    const values = [
      draft("old", { updatedAt: now - 10 * day }),
      draft("today", { updatedAt: now }),
      draft("week", { updatedAt: now - 3 * day }),
      draft("yesterday", { updatedAt: now - day })
    ];
    expect(groupDrafts(values, "date", now).map((group) => group.label)).toEqual([
      "今天",
      "昨天",
      "近7天",
      "更早"
    ]);
  });
});
