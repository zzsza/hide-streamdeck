export const KEY_SIZE = 144;

export interface KeySvgOptions {
  background?: string;
  borderColor?: string;
  borderWidth?: number;
  cornerRadius?: number;
  body?: string;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return chars.slice(0, maxChars).join("");
  }
  return `${chars.slice(0, maxChars - 3).join("")}...`;
}

export function createKeySvg(options: KeySvgOptions = {}): string {
  const background = options.background ?? "#181a20";
  const borderColor = options.borderColor;
  const borderWidth = options.borderWidth ?? 2;
  const cornerRadius = options.cornerRadius ?? 16;
  const body = options.body ?? "";

  const inset = borderColor ? borderWidth / 2 : 0;
  const rectSize = KEY_SIZE - inset * 2;
  const strokeAttrs = borderColor
    ? ` stroke="${escapeXml(borderColor)}" stroke-width="${borderWidth}"`
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`,
    `<rect x="${inset}" y="${inset}" width="${rectSize}" height="${rectSize}" rx="${cornerRadius}" fill="${escapeXml(background)}"${strokeAttrs} />`,
    body,
    `</svg>`,
  ].join("");
}

export function renderPlaceholderCardSvg(title: string, subtitle?: string): string {
  const safeTitle = escapeXml(truncateText(title, 18));
  const safeSubtitle = subtitle ? escapeXml(truncateText(subtitle, 22)) : "";

  const body = [
    `<text x="72" y="${safeSubtitle ? 66 : 76}" text-anchor="middle" fill="#e2e8f0" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="16" font-weight="600">${safeTitle}</text>`,
    safeSubtitle
      ? `<text x="72" y="92" text-anchor="middle" fill="#94a3b8" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12">${safeSubtitle}</text>`
      : "",
  ].join("");

  return createKeySvg({
    background: "#181a20",
    borderColor: "#334155",
    borderWidth: 2,
    body,
  });
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
