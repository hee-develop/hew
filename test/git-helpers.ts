/** 테스트용 임시 git 저장소 만들기. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  dir: string;
  head: string;
  /** 첫 커밋에 둔 develop 브랜치의 SHA(HEAD 보다 하나 앞선다). */
  develop: string;
}

/** 커밋 두 개와 develop 브랜치가 있는 저장소를 임시 폴더에 만든다. */
export function makeGitRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "hew-gitrepo-"));
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1");
  git("add", ".");
  git("commit", "-q", "-m", "첫째");
  git("branch", "develop");
  writeFileSync(join(dir, "a.txt"), "2");
  git("commit", "-q", "-am", "둘째");
  return { dir, head: git("rev-parse", "HEAD"), develop: git("rev-parse", "develop") };
}
