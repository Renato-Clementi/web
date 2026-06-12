import { describe, it, expect } from "vitest";
import { htmlToText, decodeEntities } from "./html";
import { parseCsv, parseCsvRows } from "./csv";
import { ticketsCsvToDocuments } from "./tickets";
import { chunkText, estimateTokens } from "./chunk";
import { parseDocument } from "./parse";
import { HashEmbeddingProvider, normalize } from "./embed";

describe("htmlToText", () => {
  it("strips tags, drops script/style, keeps paragraph structure", () => {
    const html =
      "<html><head><title>x</title><style>.a{}</style></head><body>" +
      "<h1>Reset password</h1><script>evil()</script>" +
      "<p>Open <b>Settings</b> &rarr; Security.</p>" +
      "<ul><li>Step one</li><li>Step two</li></ul></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("Reset password");
    expect(text).toContain("Open Settings");
    expect(text).not.toContain("evil()");
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).toContain("• Step one");
    expect(text).toContain("• Step two");
  });

  it("decodes common and numeric entities", () => {
    expect(decodeEntities("a &amp; b &#38; c &#x26; d &nbsp;e")).toBe(
      "a & b & c & d  e",
    );
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines", () => {
    const csv =
      "id,subject,description\n" +
      '1,"Hello, world","line one\nline two"\n' +
      '2,Plain,"He said ""hi"""\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].subject).toBe("Hello, world");
    expect(rows[0].description).toBe("line one\nline two");
    expect(rows[1].description).toBe('He said "hi"');
  });

  it("strips BOM and skips blank trailing rows", () => {
    const csv = "﻿a,b\n1,2\n\n";
    const rows = parseCsvRows(csv);
    expect(rows[0]).toEqual(["a", "b"]);
    const objs = parseCsv(csv);
    expect(objs).toHaveLength(1);
  });
});

describe("ticketsCsvToDocuments", () => {
  const csv =
    "Ticket ID,Subject,Description,Resolution,Status\n" +
    '101,"Login fails","I cannot log in","Reset the password from Settings.",closed\n' +
    '102,"Feature idea","Please add dark mode","",open\n' +
    '103,"Refund","Where is my refund?","Refunds take 5 days.",resolved\n';

  it("keeps only resolved tickets and builds Q/A documents", () => {
    const { documents, skippedUnresolved } = ticketsCsvToDocuments(csv);
    expect(skippedUnresolved).toBe(1); // the "open" one
    expect(documents).toHaveLength(2);
    const first = documents[0];
    expect(first.title).toBe("Login fails");
    expect(first.content).toContain("Question:");
    expect(first.content).toContain("I cannot log in");
    expect(first.content).toContain("Resolution:");
    expect(first.uri).toBe("ticket:101");
    expect(first.metadata?.kind).toBe("ticket");
  });

  it("respects an explicit column mapping", () => {
    const custom = "q,a\nHow to export?,Use the export button.\n";
    const { documents } = ticketsCsvToDocuments(custom, {
      question: ["q"],
      resolution: ["a"],
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].content).toContain("How to export?");
    expect(documents[0].content).toContain("Use the export button.");
  });
});

describe("chunkText", () => {
  it("returns one chunk for short text", () => {
    const chunks = chunkText("A short paragraph about cats.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].tokenCount).toBe(estimateTokens(chunks[0].content));
  });

  it("splits long text into multiple overlapping chunks", () => {
    const para = "Sentence number filler. ".repeat(60); // ~1440 chars
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkText(text, { targetTokens: 128, overlapTokens: 16 });
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk grossly exceeds the char budget (target*4 + slack).
    for (const ch of chunks)
      expect(ch.content.length).toBeLessThanOrEqual(128 * 4 + 4);
    // Indices are sequential from 0.
    chunks.forEach((ch, i) => expect(ch.index).toBe(i));
  });

  it("is deterministic", () => {
    const text = "Para one here.\n\nPara two there.\n\nPara three everywhere.";
    expect(chunkText(text)).toEqual(chunkText(text));
  });
});

describe("parseDocument", () => {
  it("derives a title and hashes content", () => {
    const parsed = parseDocument({
      content: "# Welcome\n\nThis is the body.",
      mimeType: "text/markdown",
    });
    expect(parsed.title).toBe("Welcome");
    expect(parsed.text).not.toContain("#");
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects binary office formats with a clear escalation message", () => {
    expect(() =>
      parseDocument({ content: "%PDF-1.7", uri: "guide.pdf" }),
    ).toThrow(/No parser registered/);
  });
});

describe("HashEmbeddingProvider", () => {
  it("produces normalized vectors of the right dimensionality", async () => {
    const p = new HashEmbeddingProvider();
    const [v] = await p.embed(["hello world hello"]);
    expect(v).toHaveLength(p.dimensions);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("ranks lexically similar text closer (cosine)", async () => {
    const p = new HashEmbeddingProvider();
    const [q] = await p.embed(["how do I reset my password"]);
    const [match] = await p.embed([
      "To reset your password open Settings then Security.",
    ]);
    const [unrelated] = await p.embed([
      "Our pricing plans start at ten euros per month.",
    ]);
    const dot = (a: number[], b: number[]) =>
      a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(q, match)).toBeGreaterThan(dot(q, unrelated));
  });

  it("normalize leaves a zero vector untouched", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
