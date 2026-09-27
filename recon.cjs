/* Reconnaissance: what is actually in the DOM, and where are the handles? */
const { chromium } = require('playwright-core');

const BOARD = process.env.BID;
const BASE = 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(`${BASE}/b/${BOARD}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node', { timeout: 15000 });

  console.log('== URL:', page.url());
  console.log('== node count:', await page.locator('.react-flow__node').count());

  // Toolbar / tool buttons — find how to draw a rect
  const btns = await page.locator('button').all();
  const labels = [];
  for (const b of btns) {
    const t = (await b.innerText().catch(() => '')).trim().replace(/\n/g, '|');
    const a = await b.getAttribute('aria-label');
    const ti = await b.getAttribute('title');
    if (t || a || ti) labels.push(`${t || a || ti}  [aria=${a}] [title=${ti}]`);
  }
  console.log('== BUTTONS ==');
  labels.forEach((l) => console.log('  ' + l));

  // Look at the store via module-less probe: find the react flow host
  const host = await page.locator('.flow-host').count();
  console.log('== .flow-host count:', host, 'data-tool:', await page.locator('.flow-host').getAttribute('data-tool'));

  // Full outerHTML of the nodes container (truncated)
  const nodesHtml = await page.locator('.react-flow__nodes').innerHTML().catch(() => '(none)');
  console.log('== NODES HTML (first 1500):\n' + nodesHtml.slice(0, 1500));

  console.log('== CONSOLE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
