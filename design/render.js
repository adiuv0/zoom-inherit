// Renders every image in the repo from the sources in design/.
//   npm run render
// Uses Playwright's Chromium, or set CHROME_PATH to a Chrome/Chromium binary.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const d = (...p) => path.join(__dirname, ...p);
const r = (...p) => path.join(root, ...p);

const jobs = [
  // [source, output, width, height, viewBox override, transparent background]
  [d('icon.svg'),        r('extension/icons/icon-128.png'), 128, 128, null,          true],
  [d('icon.svg'),        r('extension/icons/icon-48.png'),   48,  48, '16 16 96 96', true],
  [d('icon-small.svg'),  r('extension/icons/icon-32.png'),   32,  32, null,          true],
  [d('icon-small.svg'),  r('extension/icons/icon-16.png'),   16,  16, null,          true],
  [d('icon.svg'),        r('store/icon-128.png'),           128, 128, null,          true],
  [d('screenshot.html'), r('store/screenshot-1280x800.png'), 1280, 800, null,        false],
  [d('promo-tile.html'), r('store/promo-tile-440x280.png'),  440, 280, null,         false],
];

(async () => {
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
  );
  // Icons first: screenshot.html embeds extension/icons/icon-48.png.
  for (const [src, out, W, H, viewBox, transparent] of jobs) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    if (src.endsWith('.svg')) {
      let svg = fs.readFileSync(src, 'utf8')
        .replace(/width="\d+"/, `width="${W}"`)
        .replace(/height="\d+"/, `height="${H}"`);
      if (viewBox) svg = svg.replace(/viewBox="[^"]+"/, `viewBox="${viewBox}"`);
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    } else {
      await page.goto('file://' + src);
      await page.evaluate(() => document.fonts.ready);
    }
    await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: W, height: H } });
    await page.close();
    console.log('wrote', path.relative(root, out));
  }
  await browser.close();
})();
