import { describe, expect, it } from "vitest";
import {
  hostPermissionPattern,
  isDestructiveEdit,
  isLikelySensitiveField,
  isLikelySensitiveUrl,
  makeFieldFingerprint,
  normalizePathname,
  normalizeSettings,
  rankSuggestions,
  trimVersions
} from "./logic";
import type { DraftVersion, FieldContext, Snippet } from "./types";

function field(overrides: Partial<FieldContext> = {}): FieldContext {
  return {
    origin: "https://jobs.example.com",
    pathname: "/apply/123456",
    pageUrl: "https://jobs.example.com/apply/123456",
    pageTitle: "前端工程师申请",
    label: "个人介绍",
    ariaLabel: "",
    placeholder: "请简单介绍你的工作经验",
    name: "introduction",
    inputType: "textarea",
    maxLength: 300,
    domHint: "#intro",
    fingerprint: "field_test",
    ...overrides
  };
}

function snippet(overrides: Partial<Snippet> = {}): Snippet {
  return {
    id: "snippet_1",
    title: "个人介绍",
    content: "我拥有三年前端开发经验，曾负责企业管理平台的组件库建设。",
    category: "求职",
    tags: ["工作经验", "前端"],
    useCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe("敏感信息过滤", () => {
  it("排除密码、验证码和银行卡字段", () => {
    expect(isLikelySensitiveField({ type: "password" })).toBe(true);
    expect(isLikelySensitiveField({ label: "短信验证码" })).toBe(true);
    expect(isLikelySensitiveField({ autocomplete: "cc-number" })).toBe(true);
    expect(isLikelySensitiveField({ label: "个人介绍", type: "text" })).toBe(false);
  });

  it("识别支付与安全页面", () => {
    expect(isLikelySensitiveUrl("https://shop.example.com/checkout/payment")).toBe(true);
    expect(isLikelySensitiveUrl("https://example.com/article/hello")).toBe(false);
  });
});

describe("网站权限匹配", () => {
  it("移除本地测试站端口，生成有效的 MV3 匹配规则", () => {
    expect(hostPermissionPattern("http://127.0.0.1:4173")).toBe("http://127.0.0.1/*");
    expect(hostPermissionPattern("https://example.com:8443")).toBe("https://example.com/*");
  });

  it("拒绝浏览器内部协议", () => {
    expect(() => hostPermissionPattern("edge://extensions")).toThrow();
  });
});

describe("字段指纹", () => {
  it("规范化动态数字和 UUID 路径", () => {
    expect(normalizePathname("/apply/123456/")).toBe("/apply/:id");
    expect(normalizePathname("/form/a3d79f29-24de-4d7b-9618-abc123456789")).toBe("/form/:id");
  });

  it("相同语义字段获得稳定指纹", () => {
    const value = field();
    const { fingerprint: _ignored, ...input } = value;
    expect(makeFieldFingerprint(input)).toBe(makeFieldFingerprint(input));
  });
});

describe("片段推荐", () => {
  it("优先推荐标题和标签匹配的片段", () => {
    const results = rankSuggestions(field(), [
      snippet(),
      snippet({ id: "snippet_2", title: "售后投诉", category: "购物", tags: ["退款"] })
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].snippet.id).toBe("snippet_1");
    expect(results[0].score).toBeGreaterThanOrEqual(70);
    expect(results[0].reasons.length).toBeGreaterThan(0);
  });

  it("不推荐没有上下文交集的片段", () => {
    expect(
      rankSuggestions(field(), [snippet({ title: "售后退款", category: "购物", tags: ["物流"] })])
    ).toEqual([]);
  });
});

describe("历史版本", () => {
  it("只保留最新的指定数量", () => {
    const versions: DraftVersion[] = Array.from({ length: 8 }, (_, index) => ({
      id: String(index), text: String(index), charCount: 1, createdAt: index
    }));
    const result = trimVersions(versions, 5);
    expect(result).toHaveLength(5);
    expect(result.map((version) => version.createdAt)).toEqual([7, 6, 5, 4, 3]);
  });
});

describe("短文本与误删保护", () => {
  it("将旧版设置迁移为1字并补充分组方式", () => {
    expect(normalizeSettings({ retentionDays: 7, minChars: 20, maxVersions: 5 })).toMatchObject({
      minChars: 1,
      draftGrouping: "site"
    });
    expect(normalizeSettings({ retentionDays: 7, minChars: 10, maxVersions: 5, draftGrouping: "field" })).toMatchObject({
      minChars: 10,
      draftGrouping: "field"
    });
  });

  it("只识别一次性减少80%以上的大幅删除", () => {
    const original = "这是一段至少包含二十个字符的测试内容，用于验证意外删除保护功能。";
    expect(isDestructiveEdit(original, "短文")).toBe(true);
    expect(isDestructiveEdit(original, "")).toBe(true);
    expect(isDestructiveEdit(original, original.slice(0, Math.ceil(original.length * 0.5)))).toBe(false);
    expect(isDestructiveEdit("不足二十字", "")).toBe(false);
  });
});
