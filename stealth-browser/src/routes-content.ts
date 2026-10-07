/**
 * Content extraction routes: read_page (HTML→Markdown), fill_form (batch fill by label)
 */
import type { Request, Response, NextFunction, Express } from "express";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { touchTab, resolveRef } from "./tabs";
import { randomDelay } from "./human-helpers";
import { buildRefSnapshot } from "./stealth";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove(["script", "style", "noscript", "iframe"]);
turndown.addRule("images", {
  filter: "img",
  replacement: (_content: string, node: any) => {
    const alt = node.getAttribute("alt") || "";
    return alt ? `[image: ${alt}]` : "";
  },
});

/**
 * Extract readable markdown from a page's HTML using Readability + Turndown.
 * Falls back to body innerText if Readability can't parse the page.
 */
async function extractMarkdown(
  html: string,
  url: string,
): Promise<{ title: string; content: string; wordCount: number }> {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article && article.content) {
    const markdown = turndown.turndown(article.content);
    return {
      title: article.title || "",
      content: markdown,
      wordCount: markdown.split(/\s+/).length,
    };
  }

  // Fallback: convert entire body HTML to markdown
  const bodyHtml = dom.window.document.body?.innerHTML || "";
  const markdown = turndown.turndown(bodyHtml);
  const title = dom.window.document.title || "";
  return {
    title,
    content: markdown,
    wordCount: markdown.split(/\s+/).length,
  };
}

export function registerContentRoutes(app: Express): void {
  // GET /tabs/:id/read_page — extract page content as clean markdown
  app.get(
    "/tabs/:id/read_page",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = touchTab(req.params.id as string);
        if (!tab) {
          res.status(404).json({ error: "Tab not found" });
          return;
        }
        // Wait for page to be reasonably loaded
        await tab.page
          .waitForLoadState("domcontentloaded", { timeout: 10000 })
          .catch(() => {});

        const html = await tab.page.content();
        const url = tab.page.url();
        const { title, content, wordCount } = await extractMarkdown(html, url);

        res.json({ title, url, content, wordCount });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /tabs/:id/fill_form — fill multiple form fields by label in one call
  app.post(
    "/tabs/:id/fill_form",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tab = touchTab(req.params.id as string);
        if (!tab) {
          res.status(404).json({ error: "Tab not found" });
          return;
        }
        const { fields } = req.body as {
          fields?: Array<{
            label?: string;
            ref?: string;
            value: string;
            type?: "text" | "select" | "check";
            human?: boolean; // default true; false = instant page.fill()
          }>;
        };
        if (!fields || !fields.length) {
          res.status(400).json({
            error:
              "fields array required: [{label: 'Email', value: 'user@example.com'}, ...]",
          });
          return;
        }

        const results: Array<{
          field: string;
          status: "filled" | "error";
          error?: string;
        }> = [];

        for (const field of fields) {
          const fieldId = field.label || field.ref || "unknown";
          try {
            const fieldType = field.type || "text";

            if (fieldType === "select") {
              const el = field.ref
                ? resolveRef(tab, field.ref)
                : tab.page.getByLabel(field.label!, { exact: false }).first();
              await el.selectOption(field.value, { timeout: 8000 });
            } else if (fieldType === "check") {
              const el = field.ref
                ? resolveRef(tab, field.ref)
                : tab.page.getByLabel(field.label!, { exact: false }).first();
              if (field.value === "true" || field.value === "on")
                await el.check({ timeout: 8000 });
              else await el.uncheck({ timeout: 8000 });
            } else {
              // text input — human-typed by default (focus + select + clear + pressSequentially)
              const el = field.ref
                ? resolveRef(tab, field.ref)
                : tab.page.getByLabel(field.label!, { exact: false }).first();
              if (field.human === false) {
                // Fast path: instant value set. Bot-detectable; opt-in only.
                await el.fill(field.value, { timeout: 8000 });
              } else {
                await el.click({ timeout: 8000 });
                await el.selectText().catch(() => {});
                await tab.page.keyboard.press("Backspace").catch(() => {});
                await el.pressSequentially(field.value, {
                  delay: 40 + Math.random() * 80,
                  timeout: 15000,
                });
              }
            }
            await randomDelay(100, 300);
            results.push({ field: fieldId, status: "filled" });
          } catch (err: any) {
            results.push({
              field: fieldId,
              status: "error",
              error: err.message?.slice(0, 100),
            });
          }
        }

        // Return fresh snapshot so agent sees updated form state
        const raw = await tab.page.locator("body").ariaSnapshot();
        const { snapshot, refs } = buildRefSnapshot(raw);
        tab.refs = refs;

        const filled = results.filter((r) => r.status === "filled").length;
        const errors = results.filter((r) => r.status === "error").length;

        res.json({
          ok: errors === 0,
          filled,
          errors,
          results,
          content: snapshot,
        });
      } catch (err) {
        next(err);
      }
    },
  );
}
