/**
 * Suggestions for `.http` files: methods, headers, `{{variables}}`, handler
 * snippets, and the `client` / `request` / `response` APIs inside scripts.
 */
import { snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import {
  COMMON_HEADERS,
  DYNAMIC_VARIABLES,
  HEADER_DOCS,
  JS_KEYWORDS,
  MEMBER_DOCS,
  METHOD_DOCS,
  METHODS,
  SCRIPT_MEMBERS,
  VARIABLE_DOCS,
} from "./model";

function option(label: string, type: Completion["type"], info?: string): Completion {
  return { label, type, info };
}

function apply(label: string, text: string, info?: string): Completion {
  return { label, type: "keyword", apply: text, info };
}

function snippetOption(label: string, text: string, info?: string): Completion {
  return { label, type: "function", apply: snippet(text), info };
}

/** Signature shown in the suggestion list and the insert template. */
const MEMBER_SIGNATURES: Record<string, string> = {
  "client.log": "log(...values)",
  "client.global.set": "set(name, value)",
  "client.global.get": "get(name)",
  "client.global.clear": "clear(name)",
  "client.global.clearAll": "clearAll()",
  "client.global.isEmpty": "isEmpty()",
  "request.variables.set": "set(name, value)",
  "request.variables.get": "get(name)",
};

/** What a member inserts at the caret after `client.`, `request.` or `response.`. */
const MEMBER_TEMPLATES: Record<string, string> = {
  "client.log": "log(${1:value})",
  "client.global.set": 'set("${1:name}", ${2:value})',
  "client.global.get": 'get("${1:name}")',
  "client.global.clear": 'clear("${1:name}")',
  "client.global.clearAll": "clearAll()",
  "client.global.isEmpty": "isEmpty()",
  "request.variables.set": 'set("${1:name}", ${2:value})',
  "request.variables.get": 'get("${1:name}")',
};

const SCRIPT_GLOBALS: Completion[] = [
  option("client", "variable", "The HTTP Client script API: globals and logging."),
  option("request", "variable", "The request being sent: method, URL, headers and variables."),
  option("response", "variable", "The response that arrived: status, headers and body."),
];

const SCRIPT_SNIPPETS: Completion[] = [
  snippetOption("client.global.set", 'client.global.set("${1:name}", ${2:value})', MEMBER_DOCS["client.global.set"]),
  snippetOption("client.log", "client.log(${1:value})", MEMBER_DOCS["client.log"]),
  snippetOption(
    "request.variables.set",
    'request.variables.set("${1:name}", ${2:value})',
    MEMBER_DOCS["request.variables.set"],
  ),
];

const HANDLER_SNIPPETS: Completion[] = [
  apply("> {%", "> {%\n  \n%}", "Run JavaScript after the response arrives (response handler)."),
  apply("< {%", "< {%\n  \n%}", "Run JavaScript before the request is prepared (pre-request script)."),
  apply("> ./handler.js", "> ./handler.js", "Read the response handler from a file next to this .http file."),
  apply("< ./pre-request.js", "< ./pre-request.js", "Read the pre-request script from a file next to this .http file."),
];

function phaseBefore(doc: Text, pos: number): "preamble" | "headers" | "body" {
  const current = doc.lineAt(pos).number;
  let phase: "preamble" | "headers" | "body" = "preamble";
  for (let n = 1; n < current; n++) {
    const line = doc.line(n);
    const t = line.text.trim();
    if (t.startsWith("###")) {
      phase = "preamble";
      continue;
    }
    if (!t) {
      if (phase === "headers") phase = "body";
      continue;
    }
    if (/^(#|\/\/)/.test(t) || /^@/.test(t)) continue;
    if (phase === "preamble") {
      phase = "headers";
      continue;
    }
    if (phase === "headers" && /^\s+[?&/]/.test(line.text)) continue;
  }
  return phase;
}

function variableNames(doc: Text): string[] {
  const names = new Set<string>();
  for (const match of doc.toString().matchAll(/^\s*@([\w.-]+)\s*=/gm)) names.add(match[1]!);
  return [...names, ...DYNAMIC_VARIABLES];
}

function scriptCompletions(ctx: CompletionContext, before: string): CompletionResult | null {
  const member = /(client(?:\.global)?|request(?:\.variables)?|response)\.\s*([\w$]*)$/.exec(before);
  if (member) {
    const path = member[1]!;
    const typed = member[2]!;
    return {
      from: ctx.pos - typed.length,
      options: SCRIPT_MEMBERS[path]!.map((label) => {
        const key = `${path}.${label}`;
        const template = MEMBER_TEMPLATES[key];
        return {
          label,
          type: template ? "function" : "property",
          detail: MEMBER_SIGNATURES[key] ?? key,
          info: MEMBER_DOCS[key] ?? MEMBER_DOCS[path],
          apply: template ? snippet(template) : undefined,
        };
      }),
    };
  }
  const word = ctx.matchBefore(/[\w$]*$/);
  if (!word) return null;
  return {
    from: word.from,
    options: [
      ...SCRIPT_GLOBALS,
      ...JS_KEYWORDS.map((label) => ({ label, type: "keyword" as const })),
      ...SCRIPT_SNIPPETS,
    ],
  };
}

export function httpCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = ctx.state.sliceDoc(line.from, ctx.pos);
  const text = ctx.state.sliceDoc(0, ctx.pos);
  const handler = text.lastIndexOf("{%") > text.lastIndexOf("%}");

  if (handler) return scriptCompletions(ctx, before);

  const variable = ctx.matchBefore(/\{\{\s*[\w$.-]*$/);
  if (variable) {
    const open = variable.text.lastIndexOf("{{");
    const after = variable.text.slice(open + 2);
    const from = variable.from + open + 2 + (after.length - after.trimStart().length);
    return {
      from,
      options: variableNames(ctx.state.doc).map((label) => ({
        label,
        type: "variable",
        info: VARIABLE_DOCS[label] ?? "Defined by an @name = value line in this file.",
      })),
    };
  }

  const phase = phaseBefore(ctx.state.doc, ctx.pos);
  if (phase === "preamble" && /^\s*[A-Za-z]*$/.test(before)) {
    return {
      from: line.from + (before.length - before.trimStart().length),
      options: METHODS.map((label) => ({ label, type: "keyword", info: METHOD_DOCS[label] })),
    };
  }

  if (phase === "headers" && !before.includes(":")) {
    return {
      from: line.from + (before.length - before.trimStart().length),
      options: COMMON_HEADERS.map((label) => ({
        label,
        type: "property",
        apply: `${label}: `,
        info: HEADER_DOCS[label],
      })),
    };
  }

  if (phase === "body" && /^\s*$/.test(before)) {
    return { from: ctx.pos, options: HANDLER_SNIPPETS };
  }
  return null;
}
