import { describe, expect, test } from "bun:test";
import { merge3, mergeBytes } from "../src/merge.ts";

const clean = (base: string, a: string, b: string) => {
  const r = merge3(base, a, b);
  if (!r.clean) throw new Error(`expected clean merge, got ${JSON.stringify(r.conflicts)}`);
  return r.text;
};
const conflicts = (base: string, a: string, b: string) => !merge3(base, a, b).clean;

describe("merge3", () => {
  const base = "# Title\n\none\ntwo\nthree\nfour\nfive\n";

  test("trivial cases", () => {
    expect(clean(base, base, base)).toBe(base);
    expect(clean(base, "x\n", base)).toBe("x\n");
    expect(clean(base, base, "y\n")).toBe("y\n");
    expect(clean(base, "same\n", "same\n")).toBe("same\n");
  });

  test("edits to different lines merge", () => {
    const a = base.replace("one", "ONE");
    const b = base.replace("five", "FIVE");
    expect(clean(base, a, b)).toBe("# Title\n\nONE\ntwo\nthree\nfour\nFIVE\n");
  });

  test("edits to adjacent lines merge", () => {
    const a = base.replace("two", "TWO");
    const b = base.replace("three", "THREE");
    expect(clean(base, a, b)).toBe(base.replace("two", "TWO").replace("three", "THREE"));
  });

  test("an insertion next to the other side's replacement merges, in base order", () => {
    const a = base.replace("two\n", "inserted\ntwo\n");
    const b = base.replace("two", "TWO");
    expect(clean(base, a, b)).toBe(base.replace("two\n", "inserted\nTWO\n"));
    expect(clean(base, b, a)).toBe(clean(base, a, b));
  });

  test("the same line changed differently conflicts", () => {
    expect(conflicts(base, base.replace("two", "2"), base.replace("two", "II"))).toBe(true);
  });

  test("the same line changed identically merges", () => {
    const both = base.replace("two", "2");
    expect(clean(base, both.replace("five", "5"), both)).toBe(both.replace("five", "5"));
  });

  test("different insertions at the same point conflict", () => {
    expect(conflicts(base, base + "a\n", base + "b\n")).toBe(true);
  });

  test("delete vs edit of the same line conflicts", () => {
    expect(conflicts(base, base.replace("two\n", ""), base.replace("two", "TWO"))).toBe(true);
  });

  test("create/create with empty ancestor", () => {
    expect(clean("", "same\n", "same\n")).toBe("same\n");
    expect(conflicts("", "a\n", "b\n")).toBe(true);
  });

  test("final newline edits", () => {
    expect(clean("a\nb", "A\nb", "a\nb\n")).toBe("A\nb\n");
    expect(conflicts("a\nb", "a\nb\n", "a\nB")).toBe(true);
  });

  test("never fuses an unterminated last line with lines appended after it", () => {
    // A drops the final newline, B appends a line: joining would give "x\nb\nc\n"
    // with A's edit silently gone (found by the fuzzer, seed 24389).
    expect(conflicts("x\nb\n", "x\nb", "x\nb\nc\n")).toBe(true);
  });

  test("CRLF lines are preserved byte for byte", () => {
    const crlf = "one\r\ntwo\r\nthree\r\n";
    expect(clean(crlf, "ONE\r\ntwo\r\nthree\r\n", "one\r\ntwo\r\nTHREE\r\n")).toBe("ONE\r\ntwo\r\nTHREE\r\n");
  });
});

describe("mergeBytes", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test("keeps a BOM", () => {
    const r = mergeBytes(enc("﻿a\nb\n"), enc("﻿A\nb\n"), enc("﻿a\nB\n"));
    expect(r.clean && [...r.bytes]).toEqual([...enc("﻿A\nB\n")]);
  });

  test("never merges invalid UTF-8 when both sides changed", () => {
    const bad = new Uint8Array([0x61, 0x0a, 0xff, 0x0a]);
    expect(mergeBytes(bad, enc("a\nx\n"), enc("b\n\xff\n")).clean).toBe(false);
  });

  test("invalid UTF-8 changed on one side only takes that side", () => {
    const bad = new Uint8Array([0x61, 0x0a, 0xff, 0x0a]);
    const edited = new Uint8Array([0x62, 0x0a, 0xff, 0x0a]);
    const r = mergeBytes(bad, edited, bad);
    expect(r.clean && [...r.bytes]).toEqual([...edited]);
  });
});

describe("merge3: one edit made twice", () => {
  test("a retried edit that has since grown does not repeat the lines it shares", () => {
    // v2 inserted "eggs"; v3 is v2 with the next line changed, sent again on base v1.
    const base = "# Shopping\nmilk\nend\n";
    const v2 = "# Shopping\neggs\nmilk\nend\n";
    const v3 = "# Shopping\neggs\nmilk x2\nend\n";
    expect(merge3(base, v2, v3)).toEqual({ clean: true, text: v3 });
    expect(merge3(base, v3, v2)).toEqual({ clean: true, text: v3 });
  });

  test("the same at the end of a replacement", () => {
    expect(merge3("a\nq\nc\n", "a\nq\nN\nc\n", "a\nQ\nN\nc\n")).toEqual({ clean: true, text: "a\nQ\nN\nc\n" });
  });

  test("an insertion next to a different change still merges", () => {
    expect(merge3("a\nq\nc\n", "a\nN\nq\nc\n", "a\nQ\nc\n")).toEqual({ clean: true, text: "a\nN\nQ\nc\n" });
  });
});
