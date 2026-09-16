import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'rendered');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, height] of [
    ['inspection-human-vs-agent', 370],
    ['penguin-develops-inspection-agent', 560],
    ['penguin-optimization-simple', 440],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(path.join(root, 'diagrams', `${name}.svg`)).href);
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.locator('text').evaluateAll(nodes => nodes.flatMap(node => {
      const box = node.getBoundingClientRect();
      return box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight
        ? [node.textContent] : [];
    }));
    if (overflow.length) throw new Error(`Text outside viewport: ${overflow.join(', ')}`);
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    await page.close();
    console.log(`Rendered ${name}`);
  }
} finally {
  await browser.close();
}
