// End-to-end test: loads extension/ into Chromium and checks zoom inheritance
// across three different hosts (127.0.0.1, localhost, 127.0.0.2).
//   npm test
// Needs a Chromium that still accepts --load-extension: Playwright's bundled
// Chromium (default) or Chrome for Testing via CHROME_PATH. Branded Chrome
// 137+ ignores --load-extension, so it won't work here.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.resolve(__dirname, '../extension');
const SITE = path.join(__dirname, 'site');
const PORT = 8000;
const A = `http://127.0.0.1:${PORT}/a.html`;
const B = `http://localhost:${PORT}/b.html`;

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(SITE, path.basename(new URL(req.url, 'http://x').pathname));
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(buf);
    });
  });
  // Dual-stack where available (localhost may resolve to ::1), else IPv4 only.
  return new Promise((ok, fail) => {
    server.once('error', (e) => {
      if (e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') return fail(e);
      server.listen({ port: PORT, host: '0.0.0.0' }, () => ok(server));
    });
    server.listen({ port: PORT, host: '::', ipv6Only: false }, () => ok(server));
  });
}

(async () => {
  const server = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zi-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const ev = (fn, arg) => sw.evaluate(fn, arg);
  const tabOf = async (url) => ev(async (u) => (await chrome.tabs.query({})).filter(t => t.url.startsWith(u)).map(t => t.id), url);
  const newestTab = () => ev(async () => (await chrome.tabs.query({})).sort((x, y) => y.id - x.id)[0].id);
  const zoomInfo = (id) => ev(async (id) => ({ zoom: await chrome.tabs.getZoom(id), scope: (await chrome.tabs.getZoomSettings(id)).scope }), id);
  const dpr = (p) => p.evaluate(() => window.devicePixelRatio);
  const settle = (p) => p.waitForTimeout(300);
  let failed = 0;
  const check = (name, got, want) => {
    const ok = Math.abs(got - want) < 0.01; if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${+got.toFixed(3)}, want ${want}`);
  };
  const opened = async (page, action) => {
    const [p] = await Promise.all([ctx.waitForEvent('page'), action()]);
    await p.waitForLoadState('load'); await settle(p); return p;
  };

  // Parent at 150% (normal per-site zoom on 127.0.0.1)
  const a = await ctx.newPage();
  await a.goto(A);
  const [aId] = await tabOf(A);
  await ev(([id]) => chrome.tabs.setZoom(id, 1.5), [aId]);
  await settle(a);
  check('parent zoom', (await zoomInfo(aId)).zoom, 1.5);

  // target=_blank child on a different host
  const b1 = await opened(a, () => a.click('#blank'));
  const b1Id = await newestTab();
  const zi = await zoomInfo(b1Id);
  check('target=_blank child zoom (API)', zi.zoom, 1.5);
  check('target=_blank child zoom (devicePixelRatio)', await dpr(b1), 1.5);
  console.log(`INFO  child zoom scope: ${zi.scope}`);

  // Saved zoom for the child's host is untouched
  const fresh = await ctx.newPage();
  await fresh.goto(B + '?fresh'); await settle(fresh);
  check('fresh tab on child host stays default', await dpr(fresh), 1.0);
  await fresh.close();

  // Sticky across cross-host navigation in the child
  await b1.click('#next'); await b1.waitForLoadState('load'); await settle(b1);
  check('child after cross-host navigation (sticky)', await dpr(b1), 1.5);

  // Manual zoom in the child is remembered
  await ev(([id]) => chrome.tabs.setZoom(id, 0.8), [b1Id]);
  await settle(b1);
  await b1.click('#next'); await b1.waitForLoadState('load'); await settle(b1);
  check('child keeps manual zoom after navigation', await dpr(b1), 0.8);
  await b1.reload(); await settle(b1);
  check('child keeps zoom after reload', await dpr(b1), 0.8);

  // Other ways of opening a tab
  check('ctrl+click child', await dpr(await opened(a, () => a.click('#plain', { modifiers: ['Control'] }))), 1.5);
  check('middle-click child', await dpr(await opened(a, () => a.click('#plain', { button: 'middle' }))), 1.5);
  check('window.open child', await dpr(await opened(a, () => a.evaluate((u) => window.open(u), B + '?wo'))), 1.5);

  // Grandchild inherits from the child (0.8), not its own host's saved zoom (1.5)
  check('grandchild inherits child zoom', await dpr(await opened(b1, () => b1.evaluate((u) => window.open(u), A + '?g'))), 0.8);

  // An unrelated tab still gets normal per-site zoom
  const u = await ctx.newPage();
  await u.goto(A + '?unrelated'); await settle(u);
  check('unrelated tab uses normal per-site zoom', await dpr(u), 1.5);

  await ctx.close(); server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
