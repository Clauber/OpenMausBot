// Cloudflare challenge auto-clicker for stealth browser pages.
//
// When a bot lands on a Cloudflare-gated page, the site serves an
// interstitial ("Just a moment...", sometimes with an interactive Turnstile
// checkbox). The identity work is done by the stealth stack; the interactive
// checkbox only needs a click, which the bot should not have to spend a tool
// call (and a reasoning round) on. This module watches each page for the
// challenge and clicks the checkbox itself, with human-ish timing, until the
// page clears or a per-navigation budget runs out.
//
// The checkbox lives inside Cloudflare's frame behind closed shadow roots,
// so the reliable click is by coordinates: the Turnstile widget renders the
// checkbox ~30px from the widget's left edge, vertically centered. We try an
// in-frame checkbox locator first (cheap when the DOM exposes it) and fall
// back to the frame-element offset click.
import type { Frame, Page } from "patchright";

const CHALLENGE_FRAME_MARK = "challenges.cloudflare.com";
/** Where the checkbox sits inside the standard 300x65 widget frame, plus the
 * jitter around it. */
export const CHECKBOX_OFFSET_X = 30;
export const CHECKBOX_JITTER_X = 8;
const WIDGET_SELECTORS = [
  ".cf-turnstile",
  'iframe[src*="challenges.cloudflare.com"]',
  "#challenge-form",
];
const IN_FRAME_CHECKBOX_SELECTORS = [
  'input[type="checkbox"]',
  ".ctp-checkbox-label",
];
const TITLE_MARKERS = ["just a moment", "attention required", "please wait"];
const BUDGET_MS = 30_000;
const FIRST_ATTEMPT_MIN_MS = 900;
const FIRST_ATTEMPT_JITTER_MS = 1_400;
const RETRY_MIN_MS = 1_800;
const RETRY_JITTER_MS = 2_200;

export interface ChallengeSolverOptions {
  log?: (line: string) => void;
  /** Total per-navigation budget before the solver gives the page up. */
  budgetMs?: number;
}

function randomBetween(min: number, jitter: number): number {
  return min + Math.random() * jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The Turnstile widget's frame always originates from Cloudflare's
 * challenge origin; matching on the URL keeps the mock tests honest too. */
export function isChallengeFrameUrl(url: string): boolean {
  return (url || "").includes(CHALLENGE_FRAME_MARK);
}

function challengeFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => isChallengeFrameUrl(frame.url()));
}

async function interstitialMarker(page: Page): Promise<boolean> {
  try {
    const title = (await page.title()).toLowerCase();
    if (TITLE_MARKERS.some((marker) => title.includes(marker))) return true;
    for (const selector of WIDGET_SELECTORS) {
      if (await page.locator(selector).first().isVisible({ timeout: 250 }).catch(() => false)) return true;
    }
  } catch { /* page can close mid-check */ }
  return false;
}

/** The page still shows a challenge: an interstitial marker and (for the
 * interactive kind) the Cloudflare frame. Pure marker pages without the
 * frame are usually non-interactive challenges that clear on their own;
 * we still let the loop run so a frame that appears later is caught. */
async function challengePresent(page: Page): Promise<boolean> {
  if (challengeFrame(page)) return true;
  return interstitialMarker(page);
}

async function clickInFrameCheckbox(frame: Frame): Promise<boolean> {
  for (const selector of IN_FRAME_CHECKBOX_SELECTORS) {
    const locator = frame.locator(selector).first();
    if (await locator.isVisible({ timeout: 400 }).catch(() => false)) {
      await locator.click({ timeout: 2_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** Click the checkbox by coordinates inside the widget frame: the checkbox
 * sits ~30px from the frame's left edge, vertically centered. A few pixels
 * of jitter keep the point from being pixel-identical every time. */
async function clickFrameByCoordinates(page: Page, frame: Frame): Promise<boolean> {
  try {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    if (!box || box.width <= 0) return false;
    const x = box.x + CHECKBOX_OFFSET_X + Math.random() * CHECKBOX_JITTER_X;
    const y = box.y + box.height / 2 + (Math.random() * 8 - 4);
    await page.mouse.move(x - 12 + Math.random() * 6, y + (Math.random() * 6 - 3));
    await sleep(randomBetween(90, 160));
    await page.mouse.click(x, y);
    return true;
  } catch {
    return false;
  }
}

async function attemptClick(page: Page): Promise<boolean> {
  const frame = challengeFrame(page);
  if (!frame) return false;
  if (await clickInFrameCheckbox(frame).catch(() => false)) return true;
  return clickFrameByCoordinates(page, frame);
}

/** One solver pass per page, armed on every main-frame navigation. All
 * failures are swallowed: a closed page, a vanished frame, or a checkbox
 * that will not take the click just end the pass. */
export function armCloudflareSolver(page: Page, options: ChallengeSolverOptions = {}): void {
  let running = false;
  let armed = false;
  const budgetMs = options.budgetMs ?? BUDGET_MS;

  const run = async (): Promise<void> => {
    running = true;
    try {
      const deadline = Date.now() + budgetMs;
      await sleep(randomBetween(FIRST_ATTEMPT_MIN_MS, FIRST_ATTEMPT_JITTER_MS));
      let first = true;
      while (Date.now() < deadline) {
        if (!page.isClosed()) {
          if (!(await challengePresent(page).catch(() => false))) {
            if (!first) options.log?.(`stealth-browser: cloudflare challenge cleared`);
            return;
          }
          if (first) options.log?.(`stealth-browser: cloudflare challenge detected, auto-clicking`);
          await attemptClick(page).catch(() => {});
        }
        first = false;
        await sleep(randomBetween(RETRY_MIN_MS, RETRY_JITTER_MS));
      }
      options.log?.(`stealth-browser: cloudflare challenge not cleared within budget`);
    } catch {
      // the page died mid-solve; nothing to report
    } finally {
      running = false;
    }
  };

  const maybeRun = (): void => {
    if (running) return;
    void run();
  };

  // Arm once per page; re-arm the pass on every main-frame navigation so a
  // later challenge on the same page gets its own budget.
  const rearm = (): void => {
    maybeRun();
    if (armed) return;
    armed = true;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) maybeRun();
    });
  };
  rearm();
}
