import { describe, expect, it } from "vitest";
import {
  PENDING_ACTIVATION_TTL_MS,
  createPendingActivation,
  isPendingActivationValid,
  permissionCoversActivation
} from "./activation";

describe("一次点击授权握手", () => {
  it("保存包含端口的准确 origin，并设置短期有效期", () => {
    const pending = createPendingActivation("http://localhost:5173/page", 10, 20, 1000);
    expect(pending.origin).toBe("http://localhost:5173");
    expect(pending.expiresAt).toBe(1000 + PENDING_ACTIVATION_TTL_MS);
    expect(isPendingActivationValid(pending, pending.expiresAt - 1)).toBe(true);
    expect(isPendingActivationValid(pending, pending.expiresAt)).toBe(false);
  });

  it("用无端口的 MV3 权限匹配准确的待启用站点", () => {
    const pending = createPendingActivation("http://localhost:5173", 10, 20, 1000);
    expect(permissionCoversActivation(pending, ["http://localhost/*"])).toBe(true);
    expect(permissionCoversActivation(pending, ["https://localhost/*"])).toBe(false);
  });
});
