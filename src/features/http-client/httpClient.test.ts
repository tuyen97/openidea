import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, getIndentation, indentService, indentUnit } from "@codemirror/language";
import { httpCompletionSource } from "./completion";
import { handlerIndent } from "./editor";
import { bodyKind, formatMs, formatSize, prettyBody, prettyMarkup } from "./format";
import { httpDiagnostics } from "./lint";
import { httpLanguage } from "./language";

describe("response bodies", () => {
  it("detects the kind from the content type, else the content", () => {
    expect(bodyKind("application/json; charset=utf-8", "x")).toBe("json");
    expect(bodyKind("application/problem+json", "x")).toBe("json");
    expect(bodyKind("text/html", "")).toBe("html");
    expect(bodyKind("application/xml", "")).toBe("xml");
    expect(bodyKind(null, ' {"a":1}')).toBe("json");
    expect(bodyKind(null, "{not json")).toBe("text");
    expect(bodyKind(null, "<!DOCTYPE html><html></html>")).toBe("html");
    expect(bodyKind(null, "<?xml version='1.0'?><a/>")).toBe("xml");
    expect(bodyKind(null, "plain")).toBe("text");
  });

  it("pretty-prints JSON and leaves invalid JSON alone", () => {
    expect(prettyBody("json", '{"a":[1,2],"b":null}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}');
    expect(prettyBody("json", "{oops")).toBe("{oops");
  });

  it("re-indents XML, keeping text-only elements on one line", () => {
    expect(prettyMarkup('<?xml version="1.0"?><a><b>1</b><c/><d><e>x</e></d><f></f></a>')).toBe(
      [
        '<?xml version="1.0"?>',
        "<a>",
        "  <b>1</b>",
        "  <c/>",
        "  <d>",
        "    <e>x</e>",
        "  </d>",
        "  <f></f>",
        "</a>",
      ].join("\n"),
    );
  });

  it("re-indents HTML with void elements and raw script contents", () => {
    const html =
      "<html><head><meta charset=utf-8><script>if (a < b) { x(); }</script></head><body><p>Hi</p><br></body></html>";
    expect(prettyMarkup(html, true)).toBe(
      [
        "<html>",
        "  <head>",
        "    <meta charset=utf-8>",
        "    <script>if (a < b) { x(); }</script>",
        "  </head>",
        "  <body>",
        "    <p>Hi</p>",
        "    <br>",
        "  </body>",
        "</html>",
      ].join("\n"),
    );
  });

  it("formats sizes and durations", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(null)).toBe("0 B");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(1500)).toBe("1.50 s");
  });
});

describe("http highlighting", () => {
  function tokens(text: string): Array<[string, string]> {
    const state = EditorState.create({ doc: text, extensions: httpLanguage });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const out: Array<[string, string]> = [];
    tree.iterate({
      enter: (n) => {
        if (n.name !== "Document" && n.from < n.to) out.push([n.name, state.sliceDoc(n.from, n.to)]);
      },
    });
    return out;
  }

  it("tags separators, methods, URLs, headers, variables and comments", () => {
    const t = tokens('### Users\n# @name list\nGET https://{{host}}/users\nAccept: json\n\n{"a": 1}\n');
    const has = (name: string, text: string) => t.some(([n, s]) => n.includes(name) && s === text);
    expect(has("heading", "### Users")).toBe(true);
    expect(has("keyword", "GET")).toBe(true);
    expect(has("link", "https://")).toBe(true);
    expect(has("variableName", "{{host}}")).toBe(true);
    expect(has("propertyName", "Accept")).toBe(true);
    expect(has("string", " json")).toBe(true);
    expect(has("string", '"a"')).toBe(true);
    expect(has("number", "1")).toBe(true);
    expect(has("meta", "# @name")).toBe(true);
  });

  it("tags JavaScript inside handlers", () => {
    const t = tokens('GET https://x\n\n> {%\n  const token = response.body.token;\n  client.log("hi"); // note\n%}\n');
    const has = (name: string, text: string) => t.some(([n, s]) => n.includes(name) && s === text);
    expect(has("keyword", "const")).toBe(true);
    expect(has("typeName", "response")).toBe(true);
    expect(has("propertyName", "body")).toBe(true);
    expect(has("propertyName", "token")).toBe(true);
    expect(has("string", '"hi"')).toBe(true);
    expect(has("comment", "// note")).toBe(true);
  });

  it("indents JavaScript inside handlers", () => {
    const doc = "GET https://x\n\n> {%\nif (x) {\nclient.log(1);\n}\n%}";
    const state = EditorState.create({
      doc,
      extensions: [indentUnit.of("  "), indentService.of(handlerIndent)],
    });
    expect(getIndentation(state, state.doc.line(5).from)).toBe(2);
    expect(getIndentation(state, state.doc.line(6).from)).toBe(0);
    expect(getIndentation(state, state.doc.line(7).from)).toBe(0);
  });
});

describe("http suggestions", () => {
  function complete(doc: string, pos = doc.length) {
    return httpCompletionSource(new CompletionContext(EditorState.create({ doc }), pos, true));
  }
  const labels = (doc: string, pos = doc.length) => complete(doc, pos)?.options.map((o) => o.label) ?? [];

  it("offers methods at the start of a request and headers after it", () => {
    expect(labels("GE")).toContain("GET");
    expect(labels("GET https://x\nAcc")).toContain("Accept");
    expect(complete("GE")?.options.find((o) => o.label === "GET")?.info).toContain("Retrieve");
  });

  it("offers file variables and dynamic variables inside {{…}}", () => {
    const found = labels("@host = example.com\nGET https://x/{{ho");
    expect(found).toContain("host");
    expect(found).toContain("$timestamp");
  });

  it("offers the handler API inside a script", () => {
    const doc = "GET https://x\n\n> {%\n  client.\n%}";
    const pos = doc.indexOf("client.") + "client.".length;
    const found = labels(doc, pos);
    const options = complete(doc, pos)?.options;
    expect(found).toEqual(["global", "log"]);
    expect(options?.find((o) => o.label === "global")?.info).toContain("shared");
    expect(options?.find((o) => o.label === "log")?.detail).toBe("log(...values)");
    expect(typeof options?.find((o) => o.label === "log")?.apply).toBe("function");

    const globalDoc = "GET https://x\n\n> {%\n  client.global.\n%}";
    const globalPos = globalDoc.indexOf("client.global.") + "client.global.".length;
    const set = complete(globalDoc, globalPos)?.options.find((o) => o.label === "set");
    expect(set?.detail).toBe("set(name, value)");
    expect(typeof set?.apply).toBe("function");
    expect(labels("GET https://x\n\n> {%\n  response.\n%}", "GET https://x\n\n> {%\n  response.".length)).toContain(
      "status",
    );
  });
});

describe("http diagnostics", () => {
  const diagnose = (doc: string) => httpDiagnostics(EditorState.create({ doc }).doc);

  it("accepts a valid request, including a bare URL", () => {
    expect(diagnose('GET https://x\nAccept: application/json\n\n{"a":1}\n> {% client.log(1) %}\n')).toEqual([]);
    expect(diagnose("https://x\nAccept: application/json\n")).toEqual([]);
  });

  it("reports unknown methods and malformed headers", () => {
    expect(diagnose("FOO /x\n").some((d) => d.message.includes("Unknown HTTP method"))).toBe(true);
    expect(diagnose("GET https://x\nnot-a-header\n").some((d) => d.message.includes("header"))).toBe(true);
  });

  it("reports JavaScript syntax errors in handlers", () => {
    expect(diagnose("GET https://x\n\n> {%\n  client.log(\n%}\n").some((d) => d.source === "JavaScript")).toBe(true);
  });
});
