import type { Page } from "patchright";

export function randomDelay(min: number, max: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min)),
  );
}

export async function humanMove(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  const steps = 5 + Math.floor(Math.random() * 10);
  await page.mouse.move(x, y, { steps });
}

export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  if (!el) throw new Error(`Element not found: ${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`Element not visible: ${selector}`);
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  await humanMove(page, x, y);
  await randomDelay(50, 200);
  await page.mouse.click(x, y);
}

export async function humanType(
  page: Page,
  selector: string,
  text: string,
): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 30 + Math.random() * 100 });
  }
}

export async function humanScroll(page: Page, dy: number): Promise<void> {
  const chunks = 3 + Math.floor(Math.random() * 4);
  const chunkSize = dy / chunks;
  for (let i = 0; i < chunks; i++) {
    await page.mouse.wheel(0, chunkSize + (Math.random() - 0.5) * 20);
    await randomDelay(80, 250);
  }
}

export async function humanClickLocator(
  page: Page,
  locator: any,
): Promise<void> {
  const box = await locator.boundingBox();
  if (box) {
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await humanMove(page, x, y);
    await randomDelay(50, 200);
    await page.mouse.click(x, y);
  } else {
    await locator.click({ timeout: 10000 });
  }
}
