import { describe, expect, it } from "vitest";
import { htmlToText, itemSummary, truncate } from "../src/zotero/format";
import { item, NOTE, PAPER } from "./fixtures";

describe("format", () => {
  it("summarises an item compactly", () => {
    expect(itemSummary(PAPER)).toEqual({
      key: "PAPER001",
      type: "journalArticle",
      title: "Attention Is All You Need",
      creators: ["Vaswani, Ashish", "Shazeer, Noam"],
      year: "2017",
      publication: "NeurIPS",
      doi: "10.48550/arXiv.1706.03762",
      tags: ["transformers"],
      children: 3,
    });
  });

  it("caps long author lists", () => {
    const many = item("MANY0001", {
      creators: Array.from({ length: 9 }, (_, i) => ({ creatorType: "author", lastName: `A${i}` })),
    });
    expect(itemSummary(many).creators).toEqual(["A0", "A1", "A2", "A3", "et al. (5 more)"]);
  });

  it("converts note HTML to text", () => {
    expect(htmlToText(NOTE.data.note!)).toBe("Summary\nSelf-attention & no recurrence.\n\n• Multi-head\n• Positional encodings");
    expect(htmlToText("a&#x27;b &#8212; <script>alert(1)</script>c")).toBe("a'b — c");
  });

  it("marks truncation", () => {
    expect(truncate("abcdef", 3)).toBe("abc… [truncated, 3 more characters]");
    expect(truncate("abc", 3)).toBe("abc");
  });
});
