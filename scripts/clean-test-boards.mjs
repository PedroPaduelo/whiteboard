#!/usr/bin/env node
/**
 * Deletes the boards that only exist because of testing.
 *
 * The rule is deliberately narrow: a board is junk only if its title is one of
 * the names this project's own scripts and test runs produce (JUNK_TITLES), or
 * matches the probe-board patterns below. Anything a human named is kept,
 * whatever its element count. That includes the API's default title,
 * "Untitled board" (POST /boards without a title), and the UI's "Quadro sem
 * título": an unnamed board with 0 elements is still a board someone made.
 *
 * Never deletes by "empty" or "old". That rule is how a real board gets
 * destroyed, and it is exactly the kind of cleverness that looks right in a
 * script and is wrong in someone's workspace.
 *
 * Usage: node scripts/clean-test-boards.mjs [--dry]
 *   API_URL=http://host:port/api   the API to clean (default localhost:3001)
 *   --dry                          list what would go, delete nothing
 */
const BASE = (process.env.API_URL || 'http://localhost:3001/api').replace(/\/+$/, '');

/** GET /boards returns at most this many per page (the API's MAX_LIMIT). */
const PAGE = 200;

/**
 * Probe boards made while verifying the app by hand or by script ("Edge Probe
 * 1234", "DRAG-GEOMETRY-PROBE", ...). Matched by PATTERN, not by an
 * ever-growing list: each run tends to invent a new probe name, and a
 * hardcoded list cannot keep up with that.
 */
const PROBE_PATTERNS = [
  /^edge probe\b/i,
  /^probe[- ]/i,
  /-probe$/i,
  /^(connectors?|events?|delta|visual|drag-geometry)-probe$/i,
];

/**
 * Exact titles of scratch boards from earlier test sessions. Never add a
 * title a person could plausibly give a real board (and never the API's or
 * the UI's default title).
 */
const JUNK_TITLES = new Set([
  'My first board', // an old auto-seed that fired on every root-URL load
  'probe-persistencia',
  'Fase4', // connector + group test board
  'Collab test', // two-tab collaboration test
  'ADVERSARIAL-VERIFY',
  'ADVERSARIAL-VERIFY-2',
  'VERIFY-PALETTE',
  'Palette FINAL',
  'Palette fix final',
  'Palette fix proof',
]);

const get = async (path) => {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
};
const del = async (path) => {
  const r = await fetch(BASE + path, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE ${path} -> ${r.status}`);
  return r.json();
};

/**
 * EVERY board, page by page (one GET returns at most PAGE). Deduped by id: a
 * board edited while we page can move between pages.
 */
async function listAllBoards() {
  const byId = new Map();
  for (let offset = 0; ; offset += PAGE) {
    const { boards, total } = await get(`/boards?limit=${PAGE}&offset=${offset}`);
    for (const b of boards) byId.set(b.id, b);
    if (boards.length < PAGE || offset + PAGE >= total) break;
  }
  return [...byId.values()];
}

const isJunk = (b) => typeof b.title === 'string' && (JUNK_TITLES.has(b.title) || PROBE_PATTERNS.some((re) => re.test(b.title)));

const dry = process.argv.includes('--dry');
const boards = await listAllBoards();
const junk = boards.filter(isJunk);
const keep = boards.filter((b) => !isJunk(b));

console.log(`total: ${boards.length} | lixo: ${junk.length} | mantidos: ${keep.length}`);
for (const b of keep) console.log(`  MANTEM  ${b.title}  (${b.elementCount} elementos)`);
for (const b of junk) console.log(`  APAGA   ${b.title}  (${b.elementCount} elementos)`);

if (dry) {
  console.log('\n--dry: nada foi apagado.');
  process.exit(0);
}

let n = 0;
for (const b of junk) {
  try {
    await del(`/boards/${encodeURIComponent(b.id)}`);
    n++;
  } catch (e) {
    console.log(`  FALHOU ${b.title}: ${e.message}`);
  }
}
console.log(`\napagados: ${n}`);

const { total } = await get('/boards?limit=1');
console.log(`restantes: ${total}`);
