/**
 * Local `.http` diagnostics: request/header structure and JavaScript syntax in
 * `{% … %}` handlers. The table is filled without a backend round-trip, so it
 * also works before a project is open.
 */
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { METHODS } from "./model";

interface Handler {
  /** Offset of the first character after `{%`. */
  from: number;
  /** Offset of `%}`. */
  to: number;
  source: string;
}

function handlers(doc: Text): Handler[] {
  const text = doc.toString();
  const out: Handler[] = [];
  let searched = 0;
  while (searched < text.length) {
    const open = text.indexOf("{%", searched);
    if (open < 0) break;
    const start = open + 2;
    const close = text.indexOf("%}", start);
    if (close < 0) {
      out.push({ from: start, to: text.length, source: text.slice(start) });
      break;
    }
    out.push({ from: start, to: close, source: text.slice(start, close) });
    searched = close + 2;
  }
  return out;
}

function scriptErrors(blocks: Handler[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const block of blocks) {
    if (!block.source.trim()) continue;
    const tree = javascriptLanguage.parser.parse(block.source);
    tree.iterate({
      enter(node) {
        if (!node.type.isError) return;
        const from = block.from + node.from;
        out.push({
          from,
          to: Math.max(from + 1, block.from + node.to),
          severity: "error",
          source: "JavaScript",
          message: tx("JavaScript syntax error"),
        });
      },
    });
  }
  return out;
}

function structureErrors(doc: Text, blocks: Handler[]): Diagnostic[] {
  const inside = (pos: number) => blocks.some((b) => b.from - 2 <= pos && pos < b.to + 2);
  const out: Diagnostic[] = [];
  let phase: "preamble" | "headers" | "body" = "preamble";
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (inside(line.from)) continue;
    const text = line.text;
    const t = text.trim();
    if (t.startsWith("###")) {
      phase = "preamble";
      continue;
    }
    if (!t) {
      if (phase === "headers") phase = "body";
      continue;
    }
    if (/^(#|\/\/)/.test(t)) continue;
    if (t.startsWith("<") || t.startsWith(">")) continue;

    if (phase === "preamble") {
      if (/^@[\w.-]+\s*=/.test(t)) continue;
      const request = /^([A-Z]+)\s+(\S+)/.exec(t);
      if (!request) {
        // A bare URL is a GET request, as in the parser.
        if (/^(https?:\/\/|\/|\{\{)/.test(t)) {
          phase = "headers";
          continue;
        }
        out.push({
          from: line.from,
          to: line.from + Math.max(1, text.length),
          severity: "error",
          source: "HTTP",
          message: tx("Expected a method and URL, or a comment"),
        });
        continue;
      }
      if (!METHODS.includes(request[1]!)) {
        out.push({
          from: line.from,
          to: line.from + request[1]!.length,
          severity: "error",
          source: "HTTP",
          message: tx`Unknown HTTP method '${request[1]}'`,
        });
      }
      phase = "headers";
      continue;
    }

    if (phase === "headers") {
      if (/^\s+[?&/]/.test(text)) continue;
      if (!text.includes(":")) {
        out.push({
          from: line.from,
          to: line.from + Math.max(1, text.length),
          severity: "warning",
          source: "HTTP",
          message: tx("Expected a header name and value"),
        });
      }
    }
  }
  return out;
}

export function httpDiagnostics(doc: Text): Diagnostic[] {
  const blocks = handlers(doc);
  return [...structureErrors(doc, blocks), ...scriptErrors(blocks)];
}

export const httpLinter = linter((view: EditorView) => httpDiagnostics(view.state.doc), { delay: 300 });
