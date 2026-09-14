/**
 * BackstoryRenderer tests.
 *
 * This component is a security boundary (PLAN.md §22 R-14): backstory text is
 * stored markdown that gets rendered to learners. The XSS test below is the
 * point of the whole file — it proves raw HTML in content cannot become markup.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackstoryRenderer } from "@/components/backstory/BackstoryRenderer";

const render = (content: string | null, format?: string) =>
  renderToStaticMarkup(<BackstoryRenderer content={content} format={format} />);

describe("BackstoryRenderer — markdown features", () => {
  it("renders headings, tables, blockquotes and emphasis (GFM)", () => {
    const html = render(
      [
        "### Project MAC",
        "",
        "| Year | Milestone |",
        "|------|-----------|",
        "| 1964 | Begins |",
        "",
        "> Bell Labs withdrew.",
        "",
        "Some **bold** and *italic* and `code`.",
      ].join("\n"),
    );

    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).toContain("<code");
  });

  it("renders ordered and unordered lists", () => {
    const html = render("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<li");
  });

  it("makes links open in a new tab safely", () => {
    const html = render("[MIT](https://example.org/multics)");
    expect(html).toContain('href="https://example.org/multics"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("BackstoryRenderer — safety", () => {
  it("does NOT execute or emit raw HTML embedded in content", () => {
    const html = render(
      '<script>alert("xss")</script>\n\n<img src=x onerror="alert(1)">\n\n<div onclick="evil()">hi</div>',
    );

    // react-markdown escapes raw HTML by default and we never enable rehype-raw.
    // Note the payload TEXT still appears — escaped — which is correct and
    // harmless; the property that matters is that no real tag or attribute is
    // emitted. So assert on unescaped markers specifically, not on the words.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<div onclick");

    // An attribute would appear as  onerror="  — escaped text shows as  onerror=&quot;
    expect(html).not.toContain('onerror="');
    expect(html).not.toContain('onclick="');

    // The text itself is still shown, escaped.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("onerror=&quot;");
  });

  it("does not emit javascript: links as executable anchors", () => {
    const html = render("[click](javascript:alert(1))");
    // Whatever react-markdown does with it, it must not become a bare
    // javascript: href on a real anchor.
    expect(html.includes('href="javascript:')).toBe(false);
  });
});

describe("BackstoryRenderer — empty and plain", () => {
  it("shows a fallback when there is no backstory", () => {
    expect(render(null)).toContain("No backstory");
    expect(render("   ")).toContain("No backstory");
  });

  it("renders plain format without markdown processing", () => {
    const html = render("Line one\n\nLine two", "plain");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain("<h");
  });
});
