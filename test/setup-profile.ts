/** 모든 테스트가 저장소의 예시 프로필을 쓰게 고정한다(개발자 홈의 실제 프로필이 섞이지 않게). */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HEW_PROFILE_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "profiles", "example");
