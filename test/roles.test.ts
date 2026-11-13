import { describe, expect, it } from "vitest";
import { ROLE_NAMES, envSuffix, loadRoles, roleConfig } from "../src/core/roles.js";

describe("roles.yaml", () => {
  it("여섯 역할의 초기값", () => {
    const roles = loadRoles();
    expect(Object.keys(roles).sort()).toEqual([...ROLE_NAMES].sort());
    expect(roles["technical-manager"]).toMatchObject({ model: "claude-opus-5-5", effort: "high", isolated: true, timeout_minutes: 90 });
    expect(roles["qa-designer"]).toMatchObject({ model: "claude-opus-5-5", effort: "high", isolated: true, timeout_minutes: 60 });
    expect(roles["ticket-maker"]).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", isolated: true, timeout_minutes: 45 });
    for (const r of ["manager-sasu", "ticket-sasu"]) expect(roles[r]).toMatchObject({ model: "claude-haiku-5-5", effort: null, isolated: true, timeout_minutes: 20 });
    expect(roles.collector).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", isolated: false, timeout_minutes: 45 });
  });

  it("technical-manager 만 heka 규칙 10개를 가진다", () => {
    const roles = loadRoles();
    expect(roles["technical-manager"]?.heka).toHaveLength(10);
    expect(roles["technical-manager"]?.heka[0]).toBe("requirement-source-priority-figma-first");
    for (const r of ROLE_NAMES.filter((n) => n !== "technical-manager")) expect(roles[r]?.heka).toEqual([]);
  });

  it("환경 변수로 모델·effort 를 덮어쓴다", () => {
    expect(envSuffix("technical-manager")).toBe("TECHNICAL_MANAGER");
    const cfg = roleConfig("technical-manager", { HEW_MODEL_TECHNICAL_MANAGER: "m-x", HEW_EFFORT_TECHNICAL_MANAGER: "low" });
    expect(cfg).toMatchObject({ model: "m-x", effort: "low" });
    const sasu = roleConfig("manager-sasu", { HEW_EFFORT_MANAGER_SASU: "medium" });
    expect(sasu).toMatchObject({ model: "claude-haiku-5-5", effort: "medium" });
    expect(roleConfig("qa-designer", {}).model).toBe("claude-opus-5-5");
  });

  it("알 수 없는 역할은 사용법 오류", () => {
    expect(() => roleConfig("nobody")).toThrow(/알 수 없는 역할/);
  });
});
