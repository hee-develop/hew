import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEW_ROOT } from "../src/core/paths.js";
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

  it("technical-manager 는 heka 규칙 10개, ticket-maker 는 6개를 가지고 나머지는 없다", () => {
    const roles = loadRoles();
    expect(roles["technical-manager"]?.heka).toHaveLength(10);
    expect(roles["technical-manager"]?.heka[0]).toBe("requirement-source-priority-figma-first");
    expect(roles["ticket-maker"]?.heka).toEqual([
      "jira-ticket-title-format",
      "jira-mo-ticket-body-format",
      "app-team-feature-flag-replaces-epic-branch",
      "app-feature-story-role-prefixed-subtasks",
      "small-commits",
      "commit-split-ui-and-feature",
    ]);
    for (const r of ROLE_NAMES.filter((n) => n !== "technical-manager" && n !== "ticket-maker")) expect(roles[r]?.heka).toEqual([]);
  });

  it("ticket-maker·ticket-sasu 의 refs 는 모두 존재하고 ticket-sasu 는 Read·Write·Bash 만 쓴다", () => {
    const roles = loadRoles();
    expect(roles["ticket-maker"]?.refs).toEqual(["refs/plan-format.md", "refs/plan.example.json", "rules/plan.yaml"]);
    expect(roles["ticket-sasu"]?.refs).toEqual(["refs/findings-format.md", "refs/findings.plan.example.json", "refs/sasu-batch.plan.example.json"]);
    expect(roles["ticket-sasu"]?.allowed_tools).toEqual(["Read", "Write", "Bash"]);
    for (const r of ["ticket-maker", "ticket-sasu"]) for (const ref of roles[r]?.refs ?? []) expect(existsSync(join(HEW_ROOT, ref))).toBe(true);
  });

  it("manager-sasu 는 형식 안내 세 개를 refs 로 가지고 대상 저장소 도구 없이 Read·Write·Bash 만 쓴다", () => {
    const sasu = loadRoles()["manager-sasu"];
    expect(sasu?.refs).toEqual(["refs/findings-format.md", "refs/findings.example.json", "refs/sasu-batch.example.json"]);
    expect(sasu?.allowed_tools).toEqual(["Read", "Write", "Bash"]);
    for (const ref of sasu?.refs ?? []) expect(existsSync(join(HEW_ROOT, ref))).toBe(true);
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
