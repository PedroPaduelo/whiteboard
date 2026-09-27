/* Recon 2: empty board, what UI exists, how do we add a node? */
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0,200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0,200)));

  await page.goto(`${BASE}/b/${BOARD}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  console.log('== URL:', page.url());
  console.log('== react-flow present:', await page.locator('.react-flow').count());
  console.log('== .react-flow__pane:', await page.locator('.react-flow__pane').count());
  console.log('== .flow-host data-tool:', await page.locator('.flow-host').getAttribute('data-tool'));

  const btns = await page.locator('button').all();
  console.log('== BUTTONS:', btns.length);
  for (let i = 0; i < btns.length; i++) {
    const b = btns[i];
    const t = (await b.innerText().catch(() => '')).trim().replace(/\s+/g, '|');
    const a = await b.getAttribute('aria-label');
    const ti = await b.getAttribute('title');
    const cls = await b.getAttribute('class');
    console.log(`  [${i}] text="${t}" aria=${a} title=${ti} cls=${(cls||'').slice(0,60)}`);
  }

  // Look for the preset palette tiles
  console.log('== palette-ish elements:');
  for (const sel of ['[data-preset]', '.wb-palette-tile', '[draggable="true"]', '[role="button"]']) {
    const n = await page.locator(sel).count();
    if (n) console.log(`  ${sel} -> ${n}`);
  }
  const dragg = await page.locator('[draggable="true"]').all();
  for (let i = 0; i < Math.min(dragg.length, 20); i++) {
    console.log(`   draggable[${i}] text="${(await dragg[i].innerText().catch(()=>'')).trim().slice(0,30)}" cls=${await dragg[i].getAttribute('class')}`);
  }

  console.log('== ERRORS:', errors.length ? errors : 'none');
  await page.screenshot({ path: '/tmp/recon2.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
