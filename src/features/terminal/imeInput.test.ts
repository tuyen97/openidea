import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownTerminalInput, type TerminalInput } from "./imeInput";

/**
 * The traces below were recorded in a WKWebView on macOS 26.2 with the system input
 * methods, logging `beforeinput`/`input`/`keydown`/`keyup` on the textarea.
 */

type Step =
  | { kind: "input"; inputType: string; data: string | null; value: string; isComposing?: boolean }
  | { kind: "keydown"; key: string; keyCode: number; isComposing?: boolean }
  | { kind: "keypress"; key: string }
  | { kind: "keyup"; key: string }
  | { kind: "xterm"; data: string };

function setup({ xtermClears = false }: { xtermClears?: boolean } = {}) {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  host.append(textarea);
  document.body.append(host);
  const sent: string[] = [];
  const reached: string[] = [];
  // xterm's own listeners, in miniature: the input and keydown must not reach them.
  textarea.addEventListener("input", (e) => reached.push((e as InputEvent).inputType));
  textarea.addEventListener("keydown", () => reached.push("keydown"));
  textarea.addEventListener("keypress", () => reached.push("keypress"));
  // `CoreBrowserTerminal` empties the textarea for Enter and Ctrl+C, before the input
  // method commits its capitalised sentence.
  if (xtermClears) {
    textarea.addEventListener(
      "keydown",
      (e) => {
        const code = (e as KeyboardEvent).keyCode;
        if (code === 13 || code === 3) textarea.value = "";
      },
      true,
    );
  }
  const ime = ownTerminalInput({ host, textarea, send: (d) => sent.push(d) });
  return { host, textarea, sent, reached, ime };
}

function keydown(target: EventTarget, init: { key: string; keyCode: number; isComposing?: boolean }) {
  const e = new KeyboardEvent("keydown", { key: init.key, bubbles: true, cancelable: true });
  Object.defineProperty(e, "keyCode", { value: init.keyCode });
  if (init.isComposing) Object.defineProperty(e, "isComposing", { value: true });
  target.dispatchEvent(e);
}

function keypress(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }));
}

function keyup(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}

function input(target: EventTarget, init: { inputType: string; data?: string | null; isComposing?: boolean }) {
  const e = new Event("input", { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    inputType: { value: init.inputType },
    data: { value: init.data ?? null },
    composed: { value: true },
    isComposing: { value: init.isComposing ?? false },
  });
  target.dispatchEvent(e);
}

/** Replays a recorded trace; the textarea value is set before each input, as WebKit does. */
function replay(steps: Step[], textarea: HTMLTextAreaElement, ime: TerminalInput) {
  for (const step of steps) {
    switch (step.kind) {
      case "input":
        textarea.value = step.value;
        input(textarea, step);
        break;
      case "keydown":
        keydown(textarea, step);
        break;
      case "keypress":
        keypress(textarea, step.key);
        break;
      case "keyup":
        keyup(textarea, step.key);
        // The browser dispatches a key's events in one task; the adapter's timer runs
        // after them, before the next key.
        vi.runAllTimers();
        break;
      case "xterm":
        ime.fromTerminal(step.data);
        break;
    }
  }
  vi.runAllTimers();
}

const DEL = "\x7f";

/** `việt nam` + Enter, macOS Vietnamese Telex, WKWebView. */
const VIETNAMESE: Step[] = [
  { kind: "input", inputType: "insertText", data: "v", value: "v" },
  { kind: "keydown", key: "v", keyCode: 229 },
  { kind: "keyup", key: "v" },
  { kind: "input", inputType: "insertReplacementText", data: "vi", value: "vi" },
  { kind: "keydown", key: "i", keyCode: 229 },
  { kind: "keyup", key: "i" },
  { kind: "input", inputType: "insertReplacementText", data: "vie", value: "vie" },
  { kind: "keydown", key: "e", keyCode: 229 },
  { kind: "keyup", key: "e" },
  { kind: "input", inputType: "insertReplacementText", data: "viê", value: "viê" },
  { kind: "keydown", key: "e", keyCode: 229 },
  { kind: "keyup", key: "e" },
  { kind: "input", inputType: "insertReplacementText", data: "viêt", value: "viêt" },
  { kind: "keydown", key: "t", keyCode: 229 },
  { kind: "keyup", key: "t" },
  { kind: "input", inputType: "insertReplacementText", data: "việt", value: "việt" },
  { kind: "keydown", key: "j", keyCode: 229 },
  { kind: "keyup", key: "j" },
  { kind: "keydown", key: " ", keyCode: 32 },
  { kind: "keypress", key: " " },
  { kind: "xterm", data: " " },
  { kind: "input", inputType: "insertText", data: " ", value: "việt " },
  { kind: "keyup", key: " " },
  { kind: "input", inputType: "insertText", data: "n", value: "việt n" },
  { kind: "keydown", key: "n", keyCode: 229 },
  { kind: "input", inputType: "insertReplacementText", data: "na", value: "việt na" },
  { kind: "keydown", key: "a", keyCode: 229 },
  { kind: "keyup", key: "n" },
  { kind: "keyup", key: "a" },
  { kind: "input", inputType: "insertReplacementText", data: "nam", value: "việt nam" },
  { kind: "keydown", key: "m", keyCode: 229 },
  { kind: "keyup", key: "m" },
  { kind: "keydown", key: "Enter", keyCode: 13 },
  { kind: "keypress", key: "Enter" },
  { kind: "xterm", data: "\r" },
  { kind: "input", inputType: "insertReplacementText", data: "Việt Nam", value: "Việt Nam" },
  { kind: "input", inputType: "insertLineBreak", data: null, value: "Việt Nam\n" },
  { kind: "keyup", key: "Enter" },
];

describe("ownTerminalInput", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers every accented letter of a Vietnamese word (#1325)", () => {
    const { textarea, sent, ime } = setup();
    replay(VIETNAMESE, textarea, ime);
    expect(sent.join("")).toBe(`vie${DEL}êt${DEL}${DEL}ệt nam${DEL.repeat(8)}Việt Nam\r`);
  });

  it("does not let xterm see the keys the input method owns", () => {
    const { textarea, reached, ime } = setup();
    replay(VIETNAMESE, textarea, ime);
    // Space and Enter are xterm's; the keyCode-229 strokes and the replacements are not.
    expect(reached).not.toContain("insertReplacementText");
    expect(reached.filter((r) => r === "keydown")).toHaveLength(2);
  });

  it("keeps the input method's text when xterm empties the textarea on Enter", () => {
    const { textarea, sent, ime } = setup({ xtermClears: true });
    replay(VIETNAMESE, textarea, ime);
    expect(sent.join("")).toBe(`vie${DEL}êt${DEL}${DEL}ệt nam${DEL.repeat(8)}Việt Nam\r`);
    expect(textarea.value).toBe("");
  });

  it("sends Enter only after the input method finished the sentence", () => {
    const { textarea, sent, ime } = setup();
    replay(VIETNAMESE, textarea, ime);
    const stream = sent.join("");
    // The capitalised replacement lands before the command is submitted, never after.
    expect(stream.indexOf("Việt Nam")).toBeLessThan(stream.indexOf("\r"));
  });

  it("leaves plain typing to xterm", () => {
    const { textarea, sent, reached, ime } = setup();
    keydown(textarea, { key: "v", keyCode: 86 });
    keypress(textarea, "v");
    textarea.value = "v";
    input(textarea, { inputType: "insertText", data: "v" });
    keyup(textarea, "v");
    ime.fromTerminal("v");
    vi.runAllTimers();
    expect(sent).toEqual(["v"]);
    expect(reached).toEqual(["keydown", "keypress", "insertText"]);
  });

  it("delivers a commit xterm's input-event gate would drop (Doubao)", () => {
    const { textarea, sent } = setup();
    keydown(textarea, { key: "1", keyCode: 229, isComposing: true });
    textarea.value = "1";
    input(textarea, { inputType: "insertText", data: "1", isComposing: true });
    expect(sent).toEqual(["1"]);
  });

  it("sends every key of a fast run exactly once", () => {
    const { textarea, sent } = setup();
    for (const key of "1234567890") {
      keydown(textarea, { key, keyCode: 229 });
      textarea.value += key;
      input(textarea, { inputType: "insertText", data: key });
      keyup(textarea, key);
    }
    expect(sent.join("")).toBe("1234567890");
  });

  it("erases with DEL what a replacement drops", () => {
    const { textarea, sent } = setup();
    textarea.value = "e";
    input(textarea, { inputType: "insertText", data: "e" });
    textarea.value = "ê";
    input(textarea, { inputType: "insertReplacementText", data: "ê" });
    expect(sent.join("")).toBe(`e${DEL}ê`);
  });

  it("keeps out of real compositions", () => {
    const { textarea, sent, reached } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    keydown(textarea, { key: "Process", keyCode: 229, isComposing: true });
    textarea.value = "你";
    input(textarea, { inputType: "insertCompositionText", data: "你", isComposing: true });
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input(textarea, { inputType: "insertFromComposition", data: "你" });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["keydown", "insertCompositionText", "insertFromComposition"]);
  });

  it("leaves a commit the keyup already unblocked to xterm", () => {
    const { textarea, sent, reached } = setup();
    keydown(textarea, { key: "1", keyCode: 229 });
    keyup(textarea, "1");
    keydown(textarea, { key: "2", keyCode: 50 });
    textarea.value = "2";
    input(textarea, { inputType: "insertText", data: "2" });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["keydown", "insertText"]);
  });

  it("drops the mirrored text when a shortcut moves the caret", () => {
    const { textarea, sent, ime } = setup();
    textarea.value = "việt";
    input(textarea, { inputType: "insertText", data: "việt" });
    ime.reset();
    expect(textarea.value).toBe("");
    textarea.value = "a";
    input(textarea, { inputType: "insertText", data: "a" });
    expect(sent.join("")).toBe("việt" + "a");
  });

  it("stops listening once disposed", () => {
    const { textarea, sent, ime } = setup();
    ime.dispose();
    textarea.value = "1";
    input(textarea, { inputType: "insertText", data: "1" });
    ime.fromTerminal("1");
    vi.runAllTimers();
    expect(sent).toEqual([]);
  });
});
