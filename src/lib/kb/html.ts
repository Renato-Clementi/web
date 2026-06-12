/**
 * Minimal, dependency-free HTML → text extraction for help-center docs.
 *
 * This is deliberately small: drop non-content elements (script/style/nav/
 * head), turn block-level tags into line breaks so paragraphs survive, strip
 * the remaining tags, and decode the handful of entities that actually appear
 * in prose. It is NOT a full HTML parser — if help-center pages turn out to
 * need real DOM handling, escalate to a library (BAB-3 §5). For the v0 doc
 * set (exported articles, simple markup) this preserves the readable text.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decode numeric (&#160; / &#xA0;) and the common named HTML entities. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name] ?? m);
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul";

export function htmlToText(html: string): string {
  let out = html;

  // Drop elements whose text is not content.
  out = out.replace(
    /<(script|style|head|noscript|template|svg)[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  // HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, " ");

  // List items get a leading bullet so structure survives flattening.
  out = out.replace(/<li[^>]*>/gi, "\n• ");

  // Block-level open/close tags → newline (paragraph boundaries).
  out = out.replace(
    new RegExp(`</?(?:${BLOCK_TAGS})(?:\\s[^>]*)?>`, "gi"),
    "\n",
  );

  // Remaining (inline) tags → nothing.
  out = out.replace(/<[^>]+>/g, "");

  out = decodeEntities(out);

  // Tidy whitespace: collapse intra-line runs, trim lines, cap blank lines.
  out = out
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return out;
}
