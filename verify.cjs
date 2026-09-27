/* ADVERSARIAL RESIZE VERIFICATION — real browser, real drags. */
const { chromium } = require('playwright-core');
const BOARD = process.env.BID;
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3001';

const log = (...a) => console.log(...a);
const H = (s) => log('\n' + '='.repeat(72) + '\n' + s + '\n' + '='.repeat(72));

/** Elements as the BACKEND has them — the persistence truth. */
async function apiElements() {
  const r = await fetch(`${API}/api/boards/${BOARD}`);
  const j = await r.json();
  return (j.elements || []).map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h }));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 250)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 250)));

  await page.goto(`${BASE}/b/${BOARD}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__pane', { timeout: 15000 });
  await page.waitForTimeout(800);

  // ---------------------------------------------------------------- draw
  H('STEP 0 — draw shapes with the real tools');
  const pane = await page.locator('.react-flow__pane').boundingBox();
  log('pane box:', JSON.stringify(pane));

  async function draw(toolKey, x1, y1, x2, y2, label) {
    await page.keyboard.press(toolKey);
    await page.waitForTimeout(150);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 });
    await page.mouse.move(x2, y2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const n = await page.locator('.react-flow__node').count();
    log(`  drew ${label} -> node count now ${n}`);
  }

  await draw('r', 250, 250, 430, 360, 'RECT 1');
  await draw('r', 560, 250, 740, 360, 'RECT 2');
  await draw('r', 250, 480, 430, 590, 'RECT 3');
  await draw('r', 560, 480, 740, 590, 'RECT 4');

  await page.keyboard.press('v');
  await page.waitForTimeout(300);

  const els0 = await apiElements();
  log('  backend elements:', JSON.stringify(els0, null, 1));
  const R1 = els0[0] && els0[0].id;
  if (!R1) { log('!! no element drawn — abort'); await browser.close(); return; }

  // ------------------------------------------------- 1. RESIZE BY HANDLE
  H('STEP 1 — RESIZE a node by dragging its SE handle');
  await page.mouse.click(340, 300); // select RECT 1
  await page.waitForTimeout(400);

  // Dump the node DOM so we know where the handles actually are
  const nodeHtml = await page.locator(`.react-flow__node[data-id="${R1}"]`).innerHTML();
  log('SELECTED NODE HTML:\n' + nodeHtml.replace(/></g, '>\n<').slice(0, 3000));

  const sel = `.react-flow__node[data-id="${R1}"]`;
  const handles = await page.locator(`${sel} .react-flow__resize-control.handle`).all();
  log(`\nresize handles found: ${handles.length}`);
  const hbox = {};
  for (let i = 0; i < handles.length; i++) {
    const b = await handles[i].boundingBox();
    const cls = await handles[i].getAttribute('class');
    hbox[cls] = b;
    log(`  handle "${cls}" box=${JSON.stringify(b)}`);
  }
  // Which element is actually ON TOP at the handle centre?
  for (const [cls, b] of Object.entries(hbox)) {
    if (!b) continue;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const top = await page.evaluate(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      if (!e) return 'NULL';
      return e.tagName + '.' + (e.getAttribute('class') || '');
    }, [cx, cy]);
    log(`  HIT TEST at centre of "${cls}" (${cx.toFixed(0)},${cy.toFixed(0)}): ${top}`);
  }

  const before = (await apiElements()).find((e) => e.id === R1);
  log('\nBEFORE resize (backend):', JSON.stringify(before));

  // Find the SE handle specifically
  const se = await page.locator(`${sel} .react-flow__resize-control.handle.bottom.right`).first();
  const seBox = await se.boundingBox().catch(() => null);
  log('SE handle box:', JSON.stringify(seBox));

  if (seBox) {
    const sx = seBox.x + seBox.width / 2, sy = seBox.y + seBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 40, sy, { steps: 4 });
    await page.mouse.move(sx + 90, sy + 50, { steps: 8 });
    // measure DURING the drag
    const during = await page.locator(`${sel} > div`).first().boundingBox().catch(() => null);
    log('  DOM size DURING drag:', JSON.stringify(during));
    await page.mouse.up();
    await page.waitForTimeout(700);
  } else {
    log('  !! SE handle not found by class');
  }

  const after = (await apiElements()).find((e) => e.id === R1);
  log('AFTER resize (backend):', JSON.stringify(after));
  const changed = after && before && (after.w !== before.w || after.h !== before.h);
  log(`\n>>> RESIZE CHANGED STORE? ${changed ? 'YES' : 'NO'}  w:${before?.w}->${after?.w}  h:${before?.h}->${after?.h}`);

  const domAfter = await page.locator(`${sel} > div`).first().boundingBox().catch(() => null);
  log('DOM size AFTER resize:', JSON.stringify(domAfter));

  // ------------------------------------------------- 2. MARQUEE
  H('STEP 2 — MARQUEE selection: drag on empty canvas, count selected');
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(1200, 850).catch(() => {}); // clear selection
  await page.waitForTimeout(300);
  // click bare canvas
  await page.mouse.click(1250, 120);
  await page.waitForTimeout(300);
  let selCount = await page.locator('.react-flow__node.selected').count();
  log('  after click on empty canvas, selected =', selCount);

  await page.mouse.move(120, 180);
  await page.mouse.down();
  await page.mouse.move(400, 400, { steps: 10 });
  await page.mouse.move(820, 700, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  selCount = await page.locator('.react-flow__node.selected').count();
  const selIds = await page.locator('.react-flow__node.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  log(`  MARQUEE over the 4 rects -> selected DOM nodes = ${selCount}: ${JSON.stringify(selIds)}`);
  const marqueeBox = await page.locator('.react-flow__selection').boundingBox().catch(() => null);
  log('  marquee rect still in DOM:', JSON.stringify(marqueeBox));

  // ------------------------------------------------- 3. NODE DRAG
  H('STEP 3 — NODE DRAG: grab a node body and move it');
  await page.mouse.click(1250, 120);
  await page.waitForTimeout(300);
  const E2 = (await apiElements())[1];
  const nb = await page.locator(`.react-flow__node[data-id="${E2.id}"]`).boundingBox();
  log(`  dragging ${E2.id} from (${nb.x.toFixed(0)},${nb.y.toFixed(0)}) size ${nb.width.toFixed(0)}x${nb.height.toFixed(0)}`);
  log('  backend before drag:', JSON.stringify({ x: E2.x, y: E2.y }));
  const cx = nb.x + nb.width / 2, cy = nb.y + nb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 5 });
  await page.mouse.move(cx + 120, cy + 70, { steps: 10 });
  const midBox = await page.locator(`.react-flow__node[data-id="${E2.id}"]`).boundingBox();
  log('  DOM mid-drag:', JSON.stringify({ x: Math.round(midBox.x), y: Math.round(midBox.y) }));
  await page.mouse.up();
  await page.waitForTimeout(700);
  const E2after = (await apiElements()).find((e) => e.id === E2.id);
  log('  backend after drag:', JSON.stringify({ x: E2after.x, y: E2after.y }));
  const moved = Math.abs(E2after.x - E2.x) > 10 || Math.abs(E2after.y - E2.y) > 10;
  log(`>>> NODE DRAG WORKED? ${moved ? 'YES' : 'NO'}`);

  // ------------------------------------------------- 4. PEN TOOL
  H('STEP 4 — PEN TOOL: draw a freehand stroke');
  const before4 = (await apiElements()).length;
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  log('  data-tool now:', await page.locator('.flow-host').getAttribute('data-tool'));
  await page.mouse.move(900, 700);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(900 + i * 12, 700 + Math.sin(i / 2) * 30, { steps: 1 });
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after4 = (await apiElements());
  const penEls = after4.filter((e) => e.type === 'pen' || e.type === 'path');
  log(`  elements ${before4} -> ${after4.length}; pen/path type: ${JSON.stringify(penEls.map((e) => e.type))}`);
  log(`>>> PEN TOOL WORKED? ${after4.length > before4 ? 'YES' : 'NO'}`);

  // ------------------------------------------------- 5. HAND TOOL
  H('STEP 5 — HAND TOOL: pan the board, incl. starting ON a node');
  await page.keyboard.press('h');
  await page.waitForTimeout(200);
  log('  data-tool now:', await page.locator('.flow-host').getAttribute('data-tool'));
  let vp1 = await page.evaluate(() => {
    const v = document.querySelector('.react-flow__viewport');
    return v ? v.style.transform : 'none';
  });
  log('  viewport transform before:', vp1);
  // pan starting on empty canvas
  await page.mouse.move(700, 850);
  await page.mouse.down();
  await page.mouse.move(760, 800, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  let vp2 = await page.evaluate(() => {
    const v = document.querySelector('.react-flow__viewport');
    return v ? v.style.transform : 'none';
  });
  log('  viewport transform after canvas pan:', vp2);
  const panCanvas = vp1 !== vp2;

  // pan starting ON a node — the case the CSS comment claims to handle
  vp1 = vp2;
  const aNode = await page.locator('.react-flow__node').first().boundingBox();
  await page.mouse.move(aNode.x + aNode.width / 2, aNode.y + aNode.height / 2);
  await page.mouse.down();
  await page.mouse.move(aNode.x + aNode.width / 2 + 60, aNode.y + aNode.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  vp2 = await page.evaluate(() => {
    const v = document.querySelector('.react-flow__viewport');
    return v ? v.style.transform : 'none';
  });
  log('  viewport transform after pan-ON-node:', vp2);
  const panOnNode = vp1 !== vp2;
  log(`>>> HAND PAN on canvas: ${panCanvas ? 'YES' : 'NO'} | on node: ${panOnNode ? 'YES' : 'NO'}`);

  await page.keyboard.press('v');
  await page.waitForTimeout(200);

  // ------------------------------------------------- EXTRA: handle hit-test on ALL corners
  H('EXTRA — hit test at every corner handle centre of a freshly selected node');
  await page.mouse.click(1250, 120);
  await page.waitForTimeout(200);
  const E3 = (await apiElements())[2];
  const sel3 = `.react-flow__node[data-id="${E3.id}"]`;
  await page.locator(sel3).click({ position: { x: 10, y: 10 } }).catch(() => {});
  await page.waitForTimeout(500);
  const hs = await page.locator(`${sel3} .react-flow__resize-control.handle`).all();
  for (let i = 0; i < hs.length; i++) {
    const b = await hs[i].boundingBox();
    const cls = await hs[i].getAttribute('class');
    if (!b) { log(`  ${cls}: NO BOX`); continue; }
    const top = await page.evaluate(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      return e ? e.tagName + '.' + (e.getAttribute('class') || '') : 'NULL';
    }, [b.x + b.width / 2, b.y + b.height / 2]);
    const ok = /resize-control/.test(top);
    log(`  ${ok ? 'OK  ' : 'FAIL'} ${cls} -> topmost: ${top}`);
  }

  H('ERRORS');
  log(errors.length ? errors.join('\n') : 'none');

  await page.screenshot({ path: '/tmp/after.png', fullPage: false });
  await browser.close();
})().catch((e) => { console.error('FATAL', e.stack); process.exit(1); });
