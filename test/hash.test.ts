import { describe, expect, it } from "vitest";
import { canonicalJson, hashJson, sha256Hex, shortHash } from "../src/core/hash.js";

describe("hash", () => {
  it("키 순서가 달라도 같은 해시", () => {
    expect(hashJson({ a: 1, b: { c: 2, d: 3 } })).toBe(hashJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("배열 순서는 유지한다", () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
  });
  it("정규화 JSON 은 공백이 없고 키가 정렬된다", () => {
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":1}');
  });
  it("sha256 알려진 값", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(shortHash(sha256Hex("abc"))).toHaveLength(12);
  });
});
