/**
 * macOS input methods, mirrored into terminal input.
 *
 * WKWebView never reports a composition for the system Vietnamese (Telex) or Korean
 * input methods: the marked text reaches the page as plain `input` events, before the
 * `keydown` (keyCode 229) of the key that produced them, and every correction arrives as
 * `insertReplacementText`. Typing `việt nam` into a textarea on macOS 26.2 records:
 *
 *   input insertText            data="v"       value="v"
 *   keydown keyCode=229 key="v"
 *   input insertReplacementText data="vi"      value="vi"
 *   keydown keyCode=229 key="i"
 *   input insertReplacementText data="viê"     value="viê"
 *   ...
 *   input insertReplacementText data="việt"    value="việt"
 *   keydown keyCode=32 key=" "                 value="việt "
 *   input insertText            data=" "       value="việt "
 *   ...
 *   keydown keyCode=13 key="Enter"
 *   input insertReplacementText data="Việt Nam" value="Việt Nam"   (sentence capitalisation)
 *   input insertLineBreak                        value="Việt Nam\n"
 *
 * xterm sends `insertText` from its keydown fallback and ignores `insertReplacementText`
 * altogether, so only the first letter of every syllable reaches the PTY and the accents
 * are lost. No composition events ever fire, so `CompositionHelper` never helps.
 *
 * This adapter mirrors the textarea and forwards what changed as terminal input. A
 * terminal cannot rewrite text it already sent, so the part a replacement removes is
 * erased with DEL, exactly what an IME that edits by keystroke (Unikey, EVKey) makes the
 * terminal do. Corrections are sent immediately; xterm's own data for the same keystroke
 * is held one task, so a replacement the IME reports after the keydown (Enter's sentence
 * capitalisation) still lands before the command is submitted.
 *
 * Real compositions (Japanese, Chinese, the emoji picker) keep their `compositionstart` …
 * `compositionend` path and stay xterm's.
 */
import { isImeKey } from "@/platform/ime";

/** The erase a terminal applies to the cell before the cursor. */
const DEL = "\x7f";

/** Data that moves the cursor or ends the line: the textarea stops describing the PTY. */
function hasControl(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Keys that never type text, so they do not make the input event after them xterm's. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph"]);

export interface TerminalInputOptions {
  /** The xterm host; capturing here keeps xterm's textarea listeners out of our commits. */
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  send: (data: string) => void;
}

export interface TerminalInput {
  /** xterm's data event: held one task so an IME correction for the same key lands first. */
  fromTerminal(data: string): void;
  /** The caret moved outside xterm (a shortcut, a paste): drop the mirrored text. */
  reset(): void;
  dispose(): void;
}

/**
 * Takes the input method's text away from xterm and forwards it to `send`.
 *
 * Returns the adapter xterm's data has to go through (`fromTerminal`); install it once
 * the terminal has a textarea.
 */
export function ownTerminalInput({ host, textarea, send }: TerminalInputOptions): TerminalInput {
  /** What the PTY has for the text the textarea currently holds. */
  let mirror = "";
  /** A real composition is running; xterm's `CompositionHelper` owns the textarea. */
  let composing = false;
  /** The input events after a compositionend belong to xterm's commit. */
  let justComposed = false;
  /** The last keydown went to the input method. */
  let imeKey = false;
  /** A text-producing keydown happened since the last input event. */
  let keyDownSeen = false;
  /** xterm's data waiting for the input method to finish the same keystroke. */
  let deferred: string[] = [];
  let timer: number | null = null;
  let disposed = false;

  const reset = () => {
    mirror = "";
    textarea.value = "";
  };

  const flush = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    const data = deferred.join("");
    deferred = [];
    if (!data) return;
    if (hasControl(data)) reset();
    send(data);
  };

  /** Holds xterm's data for one task; every input event pushes it back so the input
   * method finishes the same keystroke (Enter's capitalisation) before it goes out. */
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(flush, 0);
  };

  /** Forwards the difference between the textarea and what the PTY already has. */
  const sync = () => {
    const value = textarea.value;
    if (value === mirror) return;
    let common = 0;
    const max = Math.min(value.length, mirror.length);
    while (common < max && value.charCodeAt(common) === mirror.charCodeAt(common)) common++;
    const erase = mirror.length - common;
    const insert = value.slice(common);
    mirror = value;
    if (erase || insert) send(DEL.repeat(erase) + insert);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing) return;
    justComposed = false;
    if (MODIFIER_KEYS.has(e.key)) return;
    keyDownSeen = true;
    imeKey = isImeKey(e);
    if (!imeKey) return;
    // The input method owns this key: xterm must not send it from its keydown fallback,
    // and the text it commits next is delivered by `onInput`.
    e.stopPropagation();
  };

  // xterm emits a pressed character from keypress; for an IME key that would duplicate
  // the text the input event delivers.
  const onKeyPress = (e: KeyboardEvent) => {
    if (imeKey) e.stopPropagation();
  };

  // xterm empties the textarea for Enter and Ctrl+C. The input method still refers to the
  // text it put there, so put it back before its own commit for that key arrives.
  const onKeyDownAfterXterm = () => {
    if (composing || mirror === "" || textarea.value !== "") return;
    textarea.value = mirror;
    textarea.selectionStart = mirror.length;
    textarea.selectionEnd = mirror.length;
  };

  const onInput = (e: InputEvent) => {
    const typed = keyDownSeen;
    keyDownSeen = false;
    if (composing) return;
    if (justComposed) {
      // xterm's `compositionend` reads the textarea in a timeout; leave the commit to it.
      justComposed = false;
      mirror = textarea.value;
      return;
    }
    const type = e.inputType;
    const ours =
      type === "insertReplacementText" ||
      type === "insertFromComposition" ||
      type === "insertCompositionText" ||
      ((type === "insertText" || type === "deleteContentBackward") && (imeKey || !typed));
    if (!ours) {
      // Typed by a key xterm already sent (or pasted): the PTY and the textarea agree.
      mirror = textarea.value;
      return;
    }
    e.stopPropagation();
    sync();
    if (timer !== null) schedule();
  };

  const onCompositionStart = () => {
    composing = true;
    justComposed = false;
  };
  const onCompositionEnd = () => {
    composing = false;
    justComposed = true;
    mirror = textarea.value;
  };
  const onBlur = () => flush();

  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("keypress", onKeyPress, true);
  host.addEventListener("input", onInput, true);
  textarea.addEventListener("keydown", onKeyDownAfterXterm);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("blur", onBlur);
  window.addEventListener("blur", onBlur);
  return {
    fromTerminal: (data) => {
      if (disposed) return;
      deferred.push(data);
      schedule();
    },
    reset: () => {
      flush();
      reset();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      deferred = [];
      host.removeEventListener("keydown", onKeyDown, true);
      host.removeEventListener("keypress", onKeyPress, true);
      host.removeEventListener("input", onInput, true);
      textarea.removeEventListener("keydown", onKeyDownAfterXterm);
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("blur", onBlur);
      window.removeEventListener("blur", onBlur);
    },
  };
}
