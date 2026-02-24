import { createHighlighter, type Highlighter, type IThemedToken } from "shiki";

const HIGHLIGHT_LANGUAGES = [
  "rust",
  "cpp",
  "kotlin",
  "typescript",
  "javascript",
  "swift",
  "python",
  "go",
];

let highlighter: Highlighter | null = null;
const initHighlighter = async () => {
  if (highlighter) return highlighter;
  try {
    highlighter = await createHighlighter({
      theme: "nord",
      langs: HIGHLIGHT_LANGUAGES,
    });
  } catch (err) {
    console.warn("[shiki] failed to initialize highlighter", err);
    highlighter = null;
  }
  return highlighter;
};

const hexToRgb = (hex: string) => {
  if (!hex) return null;
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : normalized;
  const bigint = parseInt(value, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r, g, b];
};

export const highlightCodeFence = (
  code: string,
  lang: string,
): string => {
  if (!highlighter) return code;
  const normalized = lang && lang !== "plain" ? lang : "plaintext";
  let tokens: IThemedToken[][];
  try {
    tokens = highlighter.codeToThemedTokens(code, normalized);
  } catch (err) {
    tokens = highlighter.codeToThemedTokens(code, "plaintext");
  }
  const lines = tokens.map((line) => {
    let buffer = "";
    line.forEach((token) => {
      const color = token.color;
      const rgb = color ? hexToRgb(color) : null;
      if (rgb) {
        buffer += `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
      }
      buffer += token.content;
      if (rgb) {
        buffer += "\x1b[39m";
      }
    });
    return buffer;
  });
  return lines.join("\n");
};

export const ensureHighlighterReady = () => initHighlighter();
