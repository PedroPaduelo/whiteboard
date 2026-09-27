#!/usr/bin/env node
/**
 * Deletes the boards that only exist because of testing.
 *
 * The rule is deliberately narrow: a board is junk only if its title is one of
 * the names this project's own scripts and test runs produce. Anything a human
 * named is kept, whatever its element count — "Untitled board" with 0 elements
 * is still a board someone made.
 *
 * Never deletes by "empty" or "old". That rule is how a real board gets
 * destroyed, and it is exactly the kind of cleverness that looks right in a
 * script and is wrong in someone's workspace.
 */
const BASE = 'http://localhost:3001/api';

/** Titles produced by seeding scripts, automated tests, and the auto-seed bug. */
/**
 * Also matches the probe boards verification agents create while they work
 * ("Edge Probe 1234", "DRAG-GEOMETRY-PROBE", ...). Matched by PATTERN, not by
 * an ever-growing list: an agent inventing a new probe name every run is
 * exactly what a hardcoded list cannot keep up with.
 */
const PROBE_PATTERNS = [
  /^edge probe\b/i,
  /^probe[- ]/i,
  /-probe$/i,
  /^drag-geometry-probe$/i,
  /^(connectors?|events?|delta|visual)-probe$/i,
];

const JUNK_TITLES = new Set([
  'My first board', // the auto-seed that fired on every root-URL load
  'Untitled board', // ditto, on a build without a default title
  'probe-persistencia', // my own diagnostic
  'Fase4', // connector + group test board
  'Collab test', // two-tab collaboration test
  'ADVERSARIAL-VERIFY', // verification agents scratch boards
  'VERIFY-PALETTE',
  'Palette FINAL',
  'Palette fix final',
  'Palette fix proof',
  'ADVERSARIAL-VERIFY-2',
  'Edge Probe 4471',
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

const dry = process.argv.includes('--dry');
const { boards } = await get('/boards');

const isProbe = (title) => PROBE_PATTERNS.some((re) => re.test(title));
const junk = boards.filter((b) => JUNK_TITLES.has(b.title) || isProbe(b.title));
const keep = boards.filter((b) => !JUNK_TITLES.has(b.title) && !isProbe(b.title));

console.log(`total: ${boards.length} | lixo: ${junk.length} | mantidos: ${keep.length}`);
for (const b of keep) console.log(`  MANTEM  ${b.title}  (${b.elementCount} elementos)`);

if (dry) {
  console.log('\n--dry: nada foi apagado.');
  process.exit(0);
}

let n = 0;
for (const b of junk) {
  try {
    await del(`/boards/${b.id}`);
    n++;
  } catch (e) {
    console.log(`  FALHOU ${b.title}: ${e.message}`);
  }
}
console.log(`\napagados: ${n}`);

const after = await get('/boards');
console.log(`restantes: ${after.total} -> ${after.boards.map((b) => b.title).join(' | ')}`);
