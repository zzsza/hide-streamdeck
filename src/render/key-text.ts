export const KEY_FONT = "Arial, -apple-system, sans-serif";
const DEFAULT_ELLIPSIS = "…";
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface WrapTextOptions {
  maxWidth: number;
  maxLines: number;
  fontSize: number;
  bold?: boolean;
  ellipsis?: string;
}

function isWideGlyph(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

/**
 * Splits a string into user-perceived grapheme clusters using Intl.Segmenter.
 */
export function splitGraphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
}

function isEmojiGrapheme(grapheme: string, firstCodePoint: number): boolean {
  if (firstCodePoint > 0xffff) {
    return true;
  }
  if (
    grapheme.includes("\u200d") ||
    grapheme.includes("\ufe0f") ||
    grapheme.includes("\u20e3")
  ) {
    return true;
  }
  return firstCodePoint >= 0x1f1e6 && firstCodePoint <= 0x1f1ff;
}

/**
 * Estimates rendered pixel width of a single grapheme cluster in sans-serif SVG text.
 */
export function estimateCharWidth(grapheme: string, fontSize: number, bold = false): number {
  const weightFactor = bold ? 1.04 : 1;
  if (grapheme === " ") {
    return fontSize * 0.3;
  }
  if (grapheme === "…") {
    return fontSize * 0.95 * weightFactor;
  }
  const firstCodePoint = grapheme.codePointAt(0) ?? 0;
  if (isEmojiGrapheme(grapheme, firstCodePoint)) {
    return fontSize * 1.25;
  }
  const baseChar = Array.from(grapheme)[0] ?? grapheme;
  if ("ilI.,:;!'|`".includes(baseChar)) {
    return fontSize * 0.30 * weightFactor;
  }
  if ("fjrt-/()[]{}".includes(baseChar)) {
    return fontSize * 0.36 * weightFactor;
  }
  if (baseChar === "W" || baseChar === "M") {
    return fontSize * 0.95 * weightFactor;
  }
  if (baseChar === "w" || baseChar === "m") {
    return fontSize * 0.82 * weightFactor;
  }
  if (isWideGlyph(firstCodePoint)) {
    return fontSize * 1.0 * weightFactor;
  }
  if (firstCodePoint >= 0x41 && firstCodePoint <= 0x5a) {
    return fontSize * 0.74 * weightFactor;
  }
  if (
    (firstCodePoint >= 0x61 && firstCodePoint <= 0x7a) ||
    (firstCodePoint >= 0x30 && firstCodePoint <= 0x39) ||
    baseChar === "_"
  ) {
    return fontSize * (bold ? 0.556 : 0.54);
  }
  return fontSize * 0.7 * weightFactor;
}

/**
 * Estimates rendered pixel width of a string in sans-serif SVG text.
 */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let total = 0;
  for (const grapheme of splitGraphemes(text)) {
    total += estimateCharWidth(grapheme, fontSize, bold);
  }
  return total;
}

function truncateLineToWidth(
  text: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean,
  ellipsis: string,
): string {
  if (estimateTextWidth(text, fontSize, bold) <= maxWidth) {
    return text;
  }
  const ellipsisWidth = estimateTextWidth(ellipsis, fontSize, bold);
  if (ellipsisWidth > maxWidth) {
    return "";
  }

  const graphemes = splitGraphemes(text);
  let width = 0;
  let endIndex = 0;
  for (let i = 0; i < graphemes.length; i += 1) {
    const gWidth = estimateCharWidth(graphemes[i]!, fontSize, bold);
    if (width + gWidth + ellipsisWidth > maxWidth) {
      break;
    }
    width += gWidth;
    endIndex = i + 1;
  }

  const prefix = graphemes.slice(0, endIndex).join("").trimEnd();
  return `${prefix}${ellipsis}`;
}

function splitWordAtWidth(
  word: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean,
): [string, string] {
  const graphemes = splitGraphemes(word);
  let width = 0;
  let fitCount = 0;
  for (let i = 0; i < graphemes.length; i += 1) {
    const gWidth = estimateCharWidth(graphemes[i]!, fontSize, bold);
    if (fitCount > 0 && width + gWidth > maxWidth) {
      break;
    }
    width += gWidth;
    fitCount = i + 1;
  }

  let splitAt = fitCount;
  for (let i = fitCount - 1; i >= 0; i -= 1) {
    const g = graphemes[i];
    if (g === "-" || g === "_" || g === "/") {
      if (i + 1 < graphemes.length) {
        splitAt = i + 1;
      }
      break;
    }
  }

  return [graphemes.slice(0, splitAt).join(""), graphemes.slice(splitAt).join("")];
}

/**
 * Wraps text into at most `maxLines` lines that each fit within `maxWidth`,
 * appending an ellipsis on the final line when truncated.
 */
export function wrapTextLines(text: string, options: WrapTextOptions): string[] {
  const { maxWidth, maxLines, fontSize, bold = false, ellipsis = DEFAULT_ELLIPSIS } = options;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || maxLines <= 0 || maxWidth <= 0) {
    return [];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const candidate = currentLine.length > 0 ? `${currentLine} ${word}` : word;

    if (estimateTextWidth(candidate, fontSize, bold) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (lines.length === maxLines - 1) {
      const remaining = currentLine.length > 0 ? `${currentLine} ${words.slice(i).join(" ")}` : words.slice(i).join(" ");
      lines.push(truncateLineToWidth(remaining, maxWidth, fontSize, bold, ellipsis));
      return lines;
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = "";
      i -= 1;
      continue;
    }

    const [head, tail] = splitWordAtWidth(word, maxWidth, fontSize, bold);
    lines.push(head);
    if (tail.length > 0) {
      words[i] = tail;
      i -= 1;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}
