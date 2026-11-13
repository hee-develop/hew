import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents } from "../src/core/events.js";
import { HewError } from "../src/core/errors.js";
import { loadManifest } from "../src/core/manifest.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { addSource, doneSources, listSources, requestSource } from "../src/core/sources.js";
import { writeUnits } from "../src/core/units/index.js";
import { FIGMA_META_JSON, PRD_MD, writeFixture } from "./source-fixtures.js";
import { makeRun, useTempRunsDir } from "./helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");

const codeOf = (fn: () => unknown): number | null => {
  try {
    fn();
  } catch (e) {
    return e instanceof HewError ? e.exitCode : -1;
  }
  return null;
};

function addPrdAndCode(dir: string, md = PRD_MD): void {
  const file = writeFixture(dir, "in/prd.md", md);
  addSource({ runDir: dir, kind: "prd", ref: "123", version: "5", file });
  addSource({ runDir: dir, kind: "code", ref: "/repo/app", baseSha: "abc123" });
}

describe("source add", () => {
  it("파일을 바이트 그대로 복사하고 해시·크기를 적는다", () => {
    const { dir } = makeRun();
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0x00, 0xff]);
    const file = writeFixture(dir, "in/raw.md", bytes);
    const { source } = addSource({ runDir: dir, kind: "prd", ref: "https://x.test/pages/123", version: "5", title: "제목", file });
    expect(source).toMatchObject({ id: "S-1", kind: "prd", version: "5", title: "제목", bytes: 7 });
    expect(source.path).toMatch(/^sources\/prd\/prd-.*-v5\.md$/);
    expect(source.path).not.toMatch(/[:?]/);
    expect(readFileSync(join(dir, source.path as string))).toEqual(bytes);
    expect(source.sha256).toHaveLength(64);
    expect(loadManifest(dir).sources).toHaveLength(1);
    expect(readEvents(runPaths(dir).events).map((e) => e.type)).toContain("source_added");
  });

  it("종류별 하위 폴더", () => {
    const { dir } = makeRun();
    const f = writeFixture(dir, "in/a.json", "[]");
    const paths = [
      addSource({ runDir: dir, kind: "ticket", ref: "ABC-1", file: f }),
      addSource({ runDir: dir, kind: "figma_meta", ref: "KEY", file: f }),
      addSource({ runDir: dir, kind: "figma_shot", ref: "KEY", node: "1:2", file: f }),
      addSource({ runDir: dir, kind: "related", ref: "adr", file: f }),
      addSource({ runDir: dir, kind: "openapi", ref: "api", env: "staging", file: f }),
    ].map((r) => r.source.path?.split("/")[1]);
    expect(paths).toEqual(["ticket", "figma", "figma", "related", "openapi"]);
  });

  it("code 는 파일 없이 meta 에 base_sha 를 적는다", () => {
    const { dir } = makeRun();
    const { source } = addSource({ runDir: dir, kind: "code", ref: "/repo/app", baseSha: "abc" });
    expect(source.path).toBeUndefined();
    expect(source.meta).toEqual({ base_sha: "abc" });
  });

  it("같은 kind+ref+version 은 같은 id 를 유지하고 내용을 바꾼다", () => {
    const { dir } = makeRun();
    const a = writeFixture(dir, "in/a.md", "첫째");
    const b = writeFixture(dir, "in/b.md", "둘째");
    const first = addSource({ runDir: dir, kind: "prd", ref: "1", version: "1", file: a });
    const same = addSource({ runDir: dir, kind: "prd", ref: "1", version: "1", file: a });
    expect(same).toMatchObject({ replaced: true, unchanged: true });
    const changed = addSource({ runDir: dir, kind: "prd", ref: "1", version: "1", file: b });
    expect(changed.source.id).toBe(first.source.id);
    expect(changed).toMatchObject({ replaced: true, unchanged: false });
    expect(readFileSync(join(dir, changed.source.path as string), "utf8")).toBe("둘째");
    const other = addSource({ runDir: dir, kind: "prd", ref: "1", version: "2", file: a });
    expect(other.source.id).toBe("S-2");
    expect(loadManifest(dir).sources).toHaveLength(2);
  });

  it("figma_shot 은 node 가 다르면 다른 원천이다", () => {
    const { dir } = makeRun();
    const f = writeFixture(dir, "in/s.png", "png");
    const a = addSource({ runDir: dir, kind: "figma_shot", ref: "KEY", node: "1:2", file: f });
    const b = addSource({ runDir: dir, kind: "figma_shot", ref: "KEY", node: "KEY0123456789012345678:1:3", file: f });
    expect(a.source.id).not.toBe(b.source.id);
    expect(b.source.meta.node).toBe("1:3");
    expect(a.source.path).not.toBe(b.source.path);
  });

  it("상태가 init 이 아니어도 받고 상태는 바꾸지 않으며 revision 을 갱신한다", () => {
    const { dir } = makeRun("analyzed");
    const before = loadRun(dir).revision;
    addSource({ runDir: dir, kind: "related", ref: "adr", file: writeFixture(dir, "in/a.md", "x") });
    const run = loadRun(dir);
    expect(run.state).toBe("analyzed");
    expect(run.revision).not.toBe(before);
  });

  it("필수 인자가 모자라면 사용법 오류(종료 2)", () => {
    const { dir } = makeRun();
    const f = writeFixture(dir, "in/a.md", "x");
    const base = { runDir: dir, ref: "r" };
    expect(codeOf(() => addSource({ ...base, kind: "weird", file: f }))).toBe(2);
    expect(codeOf(() => addSource({ ...base, kind: "prd" }))).toBe(2);
    expect(codeOf(() => addSource({ ...base, kind: "prd", file: join(dir, "없음") }))).toBe(2);
    expect(codeOf(() => addSource({ ...base, kind: "figma_shot", file: f }))).toBe(2);
    expect(codeOf(() => addSource({ ...base, kind: "openapi", file: f }))).toBe(2);
    expect(codeOf(() => addSource({ ...base, kind: "code" }))).toBe(2);
    expect(codeOf(() => addSource({ ...base, kind: "prd", file: f, node: "zz" }))).toBe(2);
    expect(loadManifest(dir).sources).toHaveLength(0);
  });
});

describe("source list·request", () => {
  it("목록과 추가 수집 요청(상태 불변)", () => {
    const { dir } = makeRun();
    addPrdAndCode(dir);
    expect(listSources(dir).map((s) => s.id)).toEqual(["S-1", "S-2"]);
    requestSource({ runDir: dir, what: "스크린샷 더", node: "12-34" });
    requestSource({ runDir: dir, what: "ADR" });
    const lines = readFileSync(runPaths(dir).requests, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ what: "스크린샷 더", node: "12:34" });
    expect(lines[1].node).toBeUndefined();
    expect(loadRun(dir).state).toBe("init");
    expect(codeOf(() => requestSource({ runDir: dir, what: " " }))).toBe(2);
  });
});

describe("source done", () => {
  it("PRD·코드가 없으면 종료 3 과 없는 목록, 상태 불변", () => {
    const { dir } = makeRun();
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HewError);
      const err = e as HewError;
      expect(err.exitCode).toBe(3);
      expect(err.issues.map((i) => i.ref)).toEqual(["prd", "code"]);
    }
    expect(loadRun(dir).state).toBe("init");
    expect(existsSync(runPaths(dir).units)).toBe(false);
  });

  it("본문에 figma.com 링크가 있으면 figma_meta 도 필수", () => {
    const { dir } = makeRun();
    addPrdAndCode(dir);
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      expect((e as HewError).issues.map((i) => i.ref)).toEqual(["figma_meta"]);
    }
    addSource({ runDir: dir, kind: "figma_meta", ref: "FigmaFileKeyExample001", node: "1:1", file: writeFixture(dir, "in/m.json", FIGMA_META_JSON) });
    expect(doneSources(dir).state).toBe("collected");
  });

  it("링크가 없으면 figma_meta 없이도 통과하고 init → collected, units 생성, revision 변화", () => {
    const { dir } = makeRun();
    addPrdAndCode(dir, "## 제목\n\n- 항목\n");
    const before = loadRun(dir).revision;
    const result = doneSources(dir);
    expect(result).toMatchObject({ previous_state: "init", state: "collected", units: 1, screens: 0 });
    const run = loadRun(dir);
    expect(run.state).toBe("collected");
    expect(run.revision).toBe(result.revision);
    expect(run.revision).toBe(before);
    expect(JSON.parse(readFileSync(runPaths(dir).units, "utf8")).units).toHaveLength(1);
    expect(existsSync(runPaths(dir).inventory)).toBe(false);
    expect(readEvents(runPaths(dir).events).map((e) => e.type)).toContain("sources_done");
  });

  it("이미 지난 상태면 단위만 다시 만들고 상태는 그대로", () => {
    const { dir } = makeRun();
    addPrdAndCode(dir, "- 하나\n");
    doneSources(dir);
    const before = loadRun(dir).revision;
    addSource({ runDir: dir, kind: "prd", ref: "123", version: "5", file: writeFixture(dir, "in/p2.md", "- 하나\n- 둘\n") });
    expect(doneSources(dir)).toMatchObject({ previous_state: "collected", state: "collected", units: 2 });
    expect(loadRun(dir).revision).not.toBe(before);
  });

  it("Figma 가 있으면 inventory 와 figma 단위, 스크린샷 image 가 생긴다", () => {
    const { dir } = makeRun();
    addPrdAndCode(dir);
    addSource({ runDir: dir, kind: "figma_meta", ref: "FigmaFileKeyExample001", file: writeFixture(dir, "in/m.json", FIGMA_META_JSON) });
    const shot = addSource({ runDir: dir, kind: "figma_shot", ref: "FigmaFileKeyExample001", node: "4:1", file: writeFixture(dir, "in/s.png", "png") });
    const result = doneSources(dir);
    expect(result.screens).toBe(6);
    const inventory = JSON.parse(readFileSync(runPaths(dir).inventory, "utf8"));
    expect(inventory.files[0]).toMatchObject({ source_id: "S-3", file_key: "FigmaFileKeyExample001" });
    const units = JSON.parse(readFileSync(runPaths(dir).units, "utf8")).units;
    const home = units.find((u: any) => u.locator.node_id === "4:1");
    expect(home).toMatchObject({ kind: "figma_screen", platform: "app", text: "앱/홈", image: shot.source.path });
    expect(units.find((u: any) => u.locator.node_id === "4:3").image).toBeUndefined();
    expect(units.find((u: any) => u.kind === "figma_desc")).toMatchObject({ text: "첫 줄 설명\n둘째 줄 설명", platform: "unknown" });
  });

  it("티켓 입력이면 ticket 원천이 필요하다", () => {
    const { dir } = makeRun("init", { input: { kind: "ticket", url: "https://x.test/browse/A-1" } });
    addPrdAndCode(dir, "- 항목\n");
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      expect((e as HewError).issues.map((i) => i.ref)).toEqual(["ticket"]);
    }
  });
});

describe("units 결정성", () => {
  it("두 번 돌려 같은 결과이고 id 는 원천 순서·문서 순서로 U-1 부터", () => {
    const { dir } = makeRun();
    addPrdAndCode(dir);
    addSource({ runDir: dir, kind: "figma_meta", ref: "FigmaFileKeyExample001", file: writeFixture(dir, "in/m.json", FIGMA_META_JSON) });
    const a = writeUnits(dir).units;
    const bytes = readFileSync(runPaths(dir).units, "utf8");
    const b = writeUnits(dir).units;
    expect(b).toEqual(a);
    expect(readFileSync(runPaths(dir).units, "utf8")).toBe(bytes);
    expect(a.units.map((u) => u.id)).toEqual(a.units.map((_, i) => `U-${i + 1}`));
    expect(a.units[0]?.source_id).toBe("S-1");
    expect(a.units.at(-1)?.source_id).toBe("S-3");
  });

  it("JSON 원본 PRD 도 Markdown 본문으로 파싱한다", () => {
    const { dir } = makeRun();
    addSource({ runDir: dir, kind: "prd", ref: "1", file: writeFixture(dir, "in/p.json", JSON.stringify([{ type: "text", text: "## 장\n\n- 가\n" }])) });
    const { units } = writeUnits(dir).units;
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: "bullet", text: "가", locator: { section: ["장"], index: 1 } });
  });
});

describe("CLI: init → source add → source done → status", () => {
  it("bin/hew 로 collected 에 도달하고 units.json 이 생긴다", () => {
    const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
    const prd = writeFixture(runs.dir, "in/prd.md", "## 제목\n\n- 항목\n");
    expect(hew(["init", "--prd", "https://x.atlassian.net/wiki/spaces/X/pages/123/T", "--run-id", "e2e"]).status).toBe(0);
    expect(hew(["--json", "source", "add", "--run", "e2e", "--kind", "prd", "--ref", "123", "--file", prd]).status).toBe(0);
    const missing = hew(["--json", "source", "done", "--run", "e2e"]);
    expect(missing.status).toBe(3);
    expect(JSON.parse(missing.stdout).errors.map((e: any) => e.ref)).toContain("code");
    expect(hew(["source", "add", "--run", "e2e", "--kind", "code", "--ref", "/repo", "--base-sha", "abc"]).status).toBe(0);
    expect(hew(["--json", "source", "add", "--run", "e2e", "--kind", "prd"]).status).toBe(2);
    const done = hew(["--json", "source", "done", "--run", "e2e"]);
    expect(done.status).toBe(0);
    expect(JSON.parse(done.stdout).data.state).toBe("collected");
    expect(JSON.parse(hew(["--json", "status", "--run", "e2e"]).stdout).data.state).toBe("collected");
    expect(existsSync(join(runs.dir, "e2e", "sources", "units.json"))).toBe(true);
    expect(JSON.parse(hew(["--json", "units", "--run", "e2e"]).stdout).data.units).toBe(1);
    expect(hew(["source", "list", "--run", "e2e"]).stdout).toContain("S-2");
    expect(hew(["--json", "source", "request", "--run", "e2e", "--what", "더"]).status).toBe(0);
  });
});
