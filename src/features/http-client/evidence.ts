/**
 * Full request + response evidence as a terminal-style image: black
 * background, white monospace text, request in blue and response in green
 * (status failures in red), with no header or footer.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { call, commands, isTauri } from "@/platform/ipc";
import type { HttpExchange } from "@/platform/ipc";
import { bodyKind, formatSize, prettyBody } from "./format";

const WIDTH = 1200;
const PADDING = 24;
const LINE_HEIGHT = 22;
const BODY_LINES = 200;
const HEADER_LINES = 80;
const WHITE = "#e6edf3";
const MUTED = "#8b949e";
const BLUE = "#79c0ff";
const GREEN = "#7ee787";
const RED = "#ff7b72";
const AMBER = "#d29922";

export interface EvidenceRow {
  text: string;
  color: string;
  /** Section headings are slightly taller and bold. */
  heading?: boolean;
}

function clipped(text: string, max: number): string[] {
  const lines = text.replace(/\t/g, "  ").split("\n");
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… (${lines.length - max} more lines)`];
}

function responseBody(ex: HttpExchange): string[] {
  const response = ex.response;
  if (!response?.body) return [];
  const body = prettyBody(bodyKind(response.contentType, response.body), response.body);
  return clipped(body, BODY_LINES);
}

function statusColor(status: number): string {
  if (status >= 400) return RED;
  if (status >= 300) return AMBER;
  return GREEN;
}

function requestTime(ms: number | null): string {
  return `Request time: ${new Date(ms ?? Date.now()).toLocaleString()}`;
}

/** Rows shown in the evidence image, in drawing order. */
export function evidenceRows(ex: HttpExchange): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    { text: "Request", color: BLUE, heading: true },
    { text: `${ex.request.method} ${ex.request.url}`, color: BLUE },
    { text: requestTime(ex.entry.timeMs), color: MUTED },
  ];
  for (const [name, value] of ex.request.headers.slice(0, HEADER_LINES))
    rows.push({ text: `${name}: ${value}`, color: WHITE });
  if (ex.request.body) {
    rows.push({ text: "", color: WHITE });
    for (const line of clipped(ex.request.body, BODY_LINES)) rows.push({ text: line, color: WHITE });
  }

  rows.push({ text: "", color: WHITE }, { text: "Response", color: GREEN, heading: true });
  if (ex.response) {
    rows.push({
      text: `${ex.response.status} ${ex.response.statusText} · ${ex.response.version} · ${formatSize(ex.response.size)} · ${ex.response.totalMs == null ? "—" : `${Math.round(ex.response.totalMs)} ms`}`,
      color: statusColor(ex.response.status),
    });
    for (const [name, value] of ex.response.headers.slice(0, HEADER_LINES)) {
      rows.push({ text: `${name}: ${value}`, color: WHITE });
    }
    const body = responseBody(ex);
    if (body.length) {
      rows.push({ text: "", color: WHITE });
      for (const line of body) rows.push({ text: line, color: WHITE });
    }
  } else {
    rows.push({ text: ex.entry.error ?? "No response", color: RED });
  }
  return rows;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let line = "";
  for (const ch of text) {
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      out.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  out.push(line);
  return out;
}

/** The evidence card as a canvas at 2× scale for a crisp clipboard image. */
export function evidenceCanvas(ex: HttpExchange): HTMLCanvasElement {
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("cannot create the evidence canvas");
  const scale = 2;
  const bodyFont = "14px 'JetBrains Mono', ui-monospace, monospace";
  const headingFont = "700 15px 'JetBrains Mono', ui-monospace, monospace";

  const drawn: Array<{ text: string; color: string; font: string; height: number }> = [];
  for (const row of evidenceRows(ex)) {
    const font = row.heading ? headingFont : bodyFont;
    const height = row.heading ? 28 : LINE_HEIGHT;
    measure.font = font;
    for (const line of wrap(measure, row.text, WIDTH - PADDING * 2)) {
      drawn.push({ text: line, color: row.color, font, height });
    }
  }

  const height =
    PADDING * 2 +
    Math.max(
      drawn.reduce((sum, row) => sum + row.height, 0),
      LINE_HEIGHT,
    );
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("cannot draw the evidence canvas");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.textBaseline = "top";

  let y = PADDING;
  for (const row of drawn) {
    ctx.font = row.font;
    ctx.fillStyle = row.color;
    ctx.fillText(row.text, PADDING, y);
    y += row.height;
  }
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export type EvidenceResult =
  | { kind: "copied" }
  | { kind: "saved"; path: string }
  | { kind: "cancelled" }
  | { kind: "failed" };

/**
 * Copies the selected exchange as a PNG. Where the clipboard refuses images
 * (some WebViews), asks for a path and writes the same PNG there instead.
 */
export async function copyEvidence(ex: HttpExchange): Promise<EvidenceResult> {
  const canvas = evidenceCanvas(ex);
  const blob = await canvasBlob(canvas);
  if (!blob) return { kind: "failed" };

  // WKWebView refuses image/png through navigator.clipboard; the native
  // pasteboard does accept it on every desktop platform.
  if (isTauri()) {
    try {
      await call(commands.clipboardSetImage(Array.from(new Uint8Array(await blob.arrayBuffer()))));
      return { kind: "copied" };
    } catch {
      // Fall through to the browser clipboard and then a file.
    }
  }

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { kind: "copied" };
    } catch {
      // Fall through to a file.
    }
  }
  if (!isTauri()) return { kind: "failed" };

  const path = await save({
    defaultPath: `http-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (!path) return { kind: "cancelled" };
  await call(commands.fsCreateFileBytes(path, Array.from(new Uint8Array(await blob.arrayBuffer()))));
  return { kind: "saved", path };
}
