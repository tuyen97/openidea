/**
 * Highlighting for `.http` / `.rest` request files (registered for the
 * `HTTP` ui-mode): `###` separators, comments and `# @name`, `@var = value`,
 * request lines, headers, `{{variables}}`, `< file` includes and `> {% %}`
 * handler blocks.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { httpCompletionSource } from "./completion";
import { METHODS } from "./model";

export { METHODS };

interface State {
  phase: "preamble" | "headers" | "body";
  /** Inside a `> {% … %}` handler script. */
  handler: boolean;
  /** An unterminated block comment inside a handler. */
  handlerComment: boolean;
  /** The quote of an unterminated handler string. */
  handlerQuote: '"' | "'" | "`" | null;
  /** The previous handler token was a member-access dot. */
  handlerDot: boolean;
  /** Position within the current line's structure. */
  part: "start" | "url" | "headerValue" | "rest";
}

function variable(stream: Parameters<StreamParser<State>["token"]>[0]): string | null {
  if (stream.match("{{")) {
    stream.match(/^[^}]*/);
    stream.match("}}");
    return "variableName.special";
  }
  return null;
}

export const httpParser: StreamParser<State> = {
  name: "http",
  startState: () => ({
    phase: "preamble",
    handler: false,
    handlerComment: false,
    handlerQuote: null,
    handlerDot: false,
    part: "start",
  }),
  copyState: (s) => ({ ...s }),
  blankLine(state) {
    if (state.phase === "headers" || (state.phase === "preamble" && state.part === "url")) state.phase = "body";
  },
  token(stream, state) {
    if (stream.sol()) {
      // The line after the request line starts the headers.
      if (state.phase === "preamble" && state.part === "url") state.phase = "headers";
      state.part = "start";
      if (stream.match(/^\s*###/)) {
        stream.skipToEnd();
        state.phase = "preamble";
        state.handler = false;
        state.handlerComment = false;
        state.handlerQuote = null;
        state.handlerDot = false;
        return "heading";
      }
    }
    if (state.handler) return handlerToken(stream, state);
    const v = variable(stream);
    if (v) return v;

    if (state.phase === "preamble") {
      if (state.part === "start") {
        if (stream.eatSpace()) return null;
        if (stream.match(/^(#|\/\/)\s*@name\b/)) {
          state.part = "rest";
          return "meta";
        }
        if (stream.match(/^(#|\/\/)/)) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match(/^@[\w.-]+/)) {
          state.part = "rest";
          return "variableName.definition";
        }
        const method = stream.match(new RegExp(`^(${METHODS.join("|")})(?=\\s)`));
        if (method) {
          state.part = "url";
          return "keyword";
        }
        if (stream.match(/^(https?:\/\/|\/)/, false)) {
          state.part = "url";
          return null;
        }
        stream.skipToEnd();
        return null;
      }
      if (state.part === "url") {
        if (stream.match(/^\s+HTTP\/[\d.]+\s*$/)) return "meta";
        if (stream.eatSpace()) return null;
        if (!stream.match(/^[^\s{]+/)) stream.next();
        return "link";
      }
      // `@name` / `@var` remainder.
      if (stream.match(/^\s*=\s*/)) return "operator";
      if (!stream.match(/^[^{]+/)) stream.next();
      return "string";
    }

    if (state.phase === "headers") {
      if (state.part === "start") {
        if (stream.match(/^\s+[?&/]/)) {
          state.part = "url";
          return "link";
        }
        if (stream.match(/^(#|\/\/)/)) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match(/^[^:\s]+(?=:)/)) {
          state.part = "headerValue";
          return "propertyName";
        }
        stream.skipToEnd();
        return null;
      }
      if (state.part === "url") {
        if (!stream.match(/^[^\s{]+/)) stream.next();
        return "link";
      }
      if (stream.eat(":")) return "punctuation";
      if (!stream.match(/^[^{]+/)) stream.next();
      return "string";
    }

    // Body.
    if (state.part === "start") {
      state.part = "rest";
      if (stream.match(/^\s*[<>]\s*\{%/)) {
        state.handler = true;
        state.handlerDot = false;
        return "meta";
      }
      if (stream.match(/^\s*(<>|>>|>|<)\s/)) {
        stream.skipToEnd();
        return "meta";
      }
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?\b/)) return "number";
    if (stream.match(/^(true|false|null)\b/)) return "atom";
    if (!stream.match(/^[^"{\d\-tfn]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" }, indentOnInput: /^\s*[})\]]$/ },
};

/** JavaScript-ish tokens inside `{% … %}` handlers. */
function handlerToken(stream: Parameters<StreamParser<State>["token"]>[0], state: State): string | null {
  if (state.handlerComment) {
    if (stream.match(/^.*?\*\//)) state.handlerComment = false;
    else stream.skipToEnd();
    state.handlerDot = false;
    return "comment";
  }
  if (state.handlerQuote) {
    const quote = state.handlerQuote;
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") stream.next();
      else if (ch === quote) {
        state.handlerQuote = null;
        break;
      }
    }
    if (stream.eol() && quote !== "`") state.handlerQuote = null;
    return "string";
  }
  if (stream.match(/^\s*%\}/)) {
    state.handler = false;
    state.handlerDot = false;
    return "meta";
  }
  if (stream.match(/^\/\/.*/)) {
    state.handlerDot = false;
    return "comment";
  }
  if (stream.match(/^\/\*/)) {
    state.handlerComment = true;
    state.handlerDot = false;
    return "comment";
  }
  const quote = stream.peek();
  if (quote === '"' || quote === "'" || quote === "`") {
    state.handlerQuote = quote;
    state.handlerDot = false;
    stream.next();
    return "string";
  }
  if (stream.match(/^\s+/)) return null;
  if (stream.match(/^(true|false|null|undefined|this)\b/)) {
    state.handlerDot = false;
    return "atom";
  }
  if (
    stream.match(
      /^(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|try|catch|finally|throw|typeof|instanceof|in|of|async|await|class|extends|super|delete|void)\b/,
    )
  ) {
    state.handlerDot = false;
    return "keyword";
  }
  if (stream.match(/^(client|request|response)\b/)) {
    state.handlerDot = false;
    return "typeName";
  }
  if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?\b/)) {
    state.handlerDot = false;
    return "number";
  }
  if (stream.match(/^[A-Za-z_$][\w$]*/)) {
    const property = state.handlerDot;
    state.handlerDot = false;
    return property ? "propertyName" : "variableName";
  }
  if (stream.match(/^\s*\.\s*/)) {
    state.handlerDot = true;
    return "punctuation";
  }
  if (stream.match(/^[=+\-*/%<>!&|?:]+/)) {
    state.handlerDot = false;
    return "operator";
  }
  if (stream.match(/^[()[\]{},;]/)) {
    state.handlerDot = false;
    return "punctuation";
  }
  stream.next();
  return null;
}

export const httpLanguage = StreamLanguage.define(httpParser);

export const httpLanguageDescription = LanguageDescription.of({
  name: "HTTP",
  extensions: ["http", "rest"],
  support: new LanguageSupport(httpLanguage, [httpLanguage.data.of({ openideaCompletion: httpCompletionSource })]),
});
