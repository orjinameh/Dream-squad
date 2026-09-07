import { describe, expect, it } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards against `\uXXXX` escapes sitting in raw JSX text. Inside JSX, text
 * is literal — a bare `\u2014` renders as the six characters "\u2014" instead
 * of "—". Escapes must live inside a JS string or an expression container:
 *   wrong:  <p>POT \u2014 COVERED</p>
 *   right:  <p>POT {"\u2014"} COVERED</p>
 *
 * Detection: single pass over the source; anything matching `\uXXXX` outside
 * string literals, comments, and `{…}` expression spans is a hit. (A bare
 * escape anywhere else in TSX is either JSX text or a syntax error, and this
 * tree compiles — so every hit is JSX text.)
 */
function findBareEscapes(src: string): { line: number; snippet: string }[] {
  const hits: { line: number; snippet: string }[] = [];
  const isHex = (ch: string) => /[0-9a-fA-F]/.test(ch);
  let i = 0;
  let line = 1;
  // mode stack: "code" | "squote" | "dquote" | "tpl" | "tplExpr"
  const mode: string[] = ["code"];
  const cur = () => mode[mode.length - 1];
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    const m = cur();
    if (m === "squote" || m === "dquote") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if ((m === "squote" && ch === "'") || (m === "dquote" && ch === '"')) mode.pop();
      i++;
      continue;
    }
    if (m === "tpl") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        mode.pop();
        i++;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        mode.push("tplExpr");
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // code or tplExpr
    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      mode.push("squote");
      i++;
      continue;
    }
    if (ch === '"') {
      mode.push("dquote");
      i++;
      continue;
    }
    if (ch === "`") {
      mode.push("tpl");
      i++;
      continue;
    }
    if (ch === "{") {
      mode.push("code");
      i++;
      continue;
    }
    if (ch === "}") {
      if (mode.length > 1) mode.pop();
      i++;
      continue;
    }
    if (ch === "\\" && src[i + 1] === "u" && isHex(src[i + 2] ?? "") && isHex(src[i + 3] ?? "") && isHex(src[i + 4] ?? "") && isHex(src[i + 5] ?? "")) {
      const snippet = src.slice(Math.max(0, i - 30), i + 12).replace(/\n/g, " ");
      hits.push({ line, snippet });
      i += 6;
      continue;
    }
    i++;
  }
  return hits;
}

describe("JSX unicode escapes", () => {
  it("has no bare \\uXXXX escapes in raw JSX text", () => {
    const files = globSync(join(__dirname, "..", "src", "**", "*.tsx"));
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const h of findBareEscapes(src)) {
        bad.push(`${f.split("src/")[1]}:${h.line}: ${h.snippet}`);
      }
    }
    expect(bad, `bare unicode escapes in JSX text:\n${bad.join("\n")}`).toEqual([]);
  });
});
