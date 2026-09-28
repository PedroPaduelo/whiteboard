/**
 * Process entry point: config -> store -> hub -> app -> listen -> signals.
 *
 * Everything interesting lives in app.js; this file is only about the
 * lifetime of the process.
 */

import { buildApp, VERSION } from './app.js';
import config, { isProduction } from './config.js';
import { createStore } from './store/index.js';
import { Hub } from './ws/hub.js';
import { ELEMENT_TYPES } from '@whiteboard/shared';

const SHUTDOWN_GRACE_MS = 10_000;

/* Excalidraw's default palette (apps/web/src/editor/constants.js), so the demo
 * looks like what the colour pickers offer. */
const INK = '#1e1e1e';
const BLUE = '#1971c2';
const BLUE_BG = '#a5d8ff';
const ORANGE = '#f08c00';
const YELLOW_BG = '#ffec99';
const GREEN = '#2f9e44';
const GREEN_BG = '#b2f2bb';
const RED = '#e03131';
const RED_BG = '#ffc9c9';
const VIOLET = '#6741d9';

/** The hand-drawn look every demo element shares. */
const SKETCH = { roughness: 1, strokeWidth: 2, strokeStyle: 'solid', opacity: 1 };
/** Text styling for shapes that carry a label. */
const LABEL = { fontFamily: 'hand', fontSize: 20, align: 'center' };
/** A filled shape: hachure fill, like Excalidraw's default. */
const filled = (stroke, fill) => ({ ...SKETCH, stroke, fill, fillStyle: 'hachure' });
/** Connector defaults: a plain arrow, bound ends are resolved by the store. */
const ARROW = { ...SKETCH, stroke: INK, fill: 'none', roundness: 'round', startArrowhead: 'none', endArrowhead: 'arrow' };

/** A short hand-drawn squiggle under the title (absolute board points). */
function squiggle(x0, y0, width) {
  const points = [];
  for (let x = 0; x <= width; x += 8) {
    points.push({ x: x0 + x, y: Math.round((y0 + Math.sin(x / 14) * 5 + (x / width) * 3) * 100) / 100 });
  }
  return points;
}

/**
 * A small, readable starter sketch. An empty canvas is a bad first impression:
 * a visitor cannot tell whether the app works, so they leave. This draws the
 * shape of the system itself (navegador -> API -> SQLite) in the same
 * vocabulary the editor offers, which doubles as a worked example of every
 * element kind: shapes with their text INSIDE (`label`), arrows BOUND to them
 * (`startId`/`endId`, so they follow when a shape is dragged), a multi-point
 * arrow, a sticky note, a freehand stroke and a free text title.
 *
 * Element ids are fixed rather than random so a re-seed is recognisable in a
 * log, and short because LIMITS.MAX_ID is 40. Seeds are fixed too, so every
 * re-seed draws exactly the same wobble. Arrow points only need to be roughly
 * right: the store re-resolves every bound end onto its shape's outline.
 * The text is Brazilian Portuguese, like the rest of the UI.
 */
const DEMO_ELEMENTS = [
  {
    // Measured in Virgil at 36px (421.3 x 45), as the editor's fitTextElement would.
    id: 'demo-title',
    type: 'text',
    x: 80,
    y: 48,
    w: 422,
    h: 45,
    text: 'Como funciona o quadro',
    fontFamily: 'hand',
    fontSize: 36,
    align: 'left',
    stroke: INK,
    fill: 'none',
    seed: 1_402_117,
    roughness: 1,
    opacity: 1,
  },
  {
    id: 'demo-squiggle',
    type: 'pen',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: squiggle(84, 104, 400),
    stroke: RED,
    fill: 'none',
    strokeWidth: 2,
    opacity: 1,
    seed: 918_273,
    roughness: 1,
  },
  // --- the happy path, left to right ---
  {
    id: 'demo-browser',
    type: 'rect',
    x: 80,
    y: 180,
    w: 180,
    h: 96,
    ...filled(BLUE, BLUE_BG),
    roundness: 'round',
    ...LABEL,
    label: 'Navegador',
    seed: 1_968_452_133,
  },
  {
    id: 'demo-api',
    type: 'rect',
    x: 380,
    y: 180,
    w: 180,
    h: 96,
    ...filled(ORANGE, YELLOW_BG),
    roundness: 'round',
    ...LABEL,
    label: 'API (Fastify)',
    seed: 305_419_896,
  },
  {
    id: 'demo-db',
    type: 'cylinder',
    x: 680,
    y: 172,
    w: 160,
    h: 112,
    ...filled(GREEN, GREEN_BG),
    roundness: 'sharp',
    ...LABEL,
    label: 'SQLite',
    seed: 1_122_334_455,
  },
  // --- arrows, bound so they follow their shapes when you drag them ---
  {
    id: 'demo-arrow-1',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 264, y: 228 },
      { x: 376, y: 228 },
    ],
    startId: 'demo-browser',
    endId: 'demo-api',
    ...ARROW,
    stroke: BLUE,
    seed: 77_001,
  },
  {
    id: 'demo-arrow-2',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 564, y: 228 },
      { x: 676, y: 228 },
    ],
    startId: 'demo-api',
    endId: 'demo-db',
    ...ARROW,
    stroke: GREEN,
    seed: 77_002,
  },
  // --- a decision, where the ops go next, and a note ---
  {
    id: 'demo-gate',
    type: 'diamond',
    x: 360,
    y: 360,
    w: 220,
    h: 140,
    ...filled(RED, RED_BG),
    roundness: 'round',
    ...LABEL,
    label: 'Op válida?',
    seed: 424_242_424,
  },
  {
    id: 'demo-arrow-3',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 470, y: 280 },
      { x: 470, y: 356 },
    ],
    startId: 'demo-api',
    endId: 'demo-gate',
    ...ARROW,
    stroke: ORANGE,
    seed: 77_003,
  },
  {
    id: 'demo-peers',
    type: 'ellipse',
    x: 680,
    y: 500,
    w: 180,
    h: 100,
    ...filled(VIOLET, '#d0bfff'),
    roundness: 'sharp',
    ...LABEL,
    label: 'Outras abas',
    seed: 987_654_321,
  },
  {
    // Three points: an elbow from the bottom of the diamond to the ellipse.
    // Binding moves only the two ends; the middle point stays where it is.
    id: 'demo-arrow-4',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 470, y: 504 },
      { x: 470, y: 550 },
      { x: 676, y: 550 },
    ],
    startId: 'demo-gate',
    endId: 'demo-peers',
    ...ARROW,
    stroke: VIOLET,
    roundness: 'sharp',
    seed: 77_004,
  },
  {
    id: 'demo-sticky',
    type: 'sticky',
    x: 80,
    y: 360,
    w: 220,
    h: 210,
    label: 'Dê dois cliques numa forma para escrever nela. Tudo aqui sincroniza ao vivo com as outras abas abertas.',
    fill: YELLOW_BG,
    fontFamily: 'hand',
    fontSize: 20,
    align: 'left',
    opacity: 1,
    seed: 55_555,
    roughness: 1,
  },
];

/**
 * Create the demo board, but only when the store is completely empty. Returns
 * the board, or null when seeding was skipped.
 */
export async function seedDemoBoard(store) {
  const { boards } = await store.listBoards({ limit: 1, offset: 0 });
  if (boards.length > 0) return null;

  const board = await store.createBoard({ title: 'Demonstração', theme: 'light', ownerId: null });
  const boardId = board.id;

  // The store validates every element (and re-derives a connector's box from
  // its points), so the dummy x/y/w/h above is ignored. Assert the type here
  // anyway: a typo in a seed should fail loudly here, not 400 in the store.
  for (const element of DEMO_ELEMENTS) {
    if (!ELEMENT_TYPES.includes(element.type)) {
      throw new Error(`demo element ${element.id} has an unknown type: ${element.type}`);
    }
  }

  const ops = DEMO_ELEMENTS.map((element, i) => ({
    opId: `demo-seed-${i}`,
    boardId,
    kind: 'create',
    element,
    at: Date.now(),
  }));

  const result = await store.applyOps(boardId, ops, 'seed');
  if (result.status !== 'applied') {
    throw new Error(`demo seed was not applied: ${result.status} ${result.message ?? ''}`.trim());
  }

  return board;
}

/**
 * The options `createStore` reads, from the runtime config. Exactly its keys:
 * handing it other names silently fell back to the defaults, which is how
 * OP_DEDUPE_TTL_MS came to be ignored.
 */
export function storeOptions(cfg) {
  return { storage: cfg.storage, sqlitePath: cfg.sqlitePath, opDedupeTtlMs: cfg.opDedupeTtlMs };
}

/**
 * The options `new Hub()` reads. The config names differ from the hub's
 * (`wsPeerTtlMs` vs `peerTtlMs`), so passing the config straight through made
 * the hub ignore WS_PEER_TTL_MS and WS_CURSOR_RATE_MS.
 */
export function hubOptions(cfg) {
  return { peerTtlMs: cfg.wsPeerTtlMs, cursorRateMs: cfg.wsCursorRateMs };
}

export async function main() {
  const store = await createStore(storeOptions(config));
  const hub = new Hub(hubOptions(config));
  const app = await buildApp({ store, hub, config, version: VERSION });

  if (config.seedDemoBoard) {
    // Never fatal: a broken seed must not stop the API from serving.
    try {
      const seeded = await seedDemoBoard(store);
      if (seeded) app.log.info({ boardId: seeded.id }, 'seeded the demo board');
    } catch (err) {
      app.log.warn({ err: err?.message ?? err }, 'demo board seed skipped');
    }
  }

  const shutdown = (signal) => {
    app.log.info({ signal }, 'shutting down');
    // Hard stop after the grace period: a wedged websocket or a store that
    // will not release its lock must not keep the container alive forever.
    const timer = setTimeout(() => {
      app.log.error({ signal }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();

    app
      .close()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((err) => {
        app.log.error({ err }, 'error during shutdown');
        clearTimeout(timer);
        process.exit(1);
      });
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => shutdown(signal));
  }

  // Bind, then report the URL we ACTUALLY got. Port 0 is legal and useful in
  // tests, so the bound address is the only trustworthy source.
  await app.listen({ port: config.port, host: config.host });

  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;

  if (!isProduction) {
    // eslint-disable-next-line no-console -- the one place we talk to a human.
    console.log(
      `whiteboard api ${VERSION} (${config.nodeEnv})\n` +
        `  storage    ${config.storage}${config.storage === 'sqlite' ? ` -> ${config.sqlitePath}` : ''}\n` +
        `  routes     ${config.apiPrefix}/health  ${config.apiPrefix}/boards  ${config.apiPrefix}/ws\n` +
        `  cors       ${config.corsOrigin.includes('*') ? '*' : config.corsOrigin.join(', ')}\n` +
        `  log level  ${config.logLevel}\n` +
        `  listening on http://${displayHost}:${boundPort}${config.apiPrefix}\n`,
    );
  } else {
    app.log.info({ host: config.host, port: boundPort }, 'whiteboard api listening');
  }
}

// Only boot when executed directly, not when imported by a test.
const isEntryPoint =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntryPoint) {
  main().catch((err) => {
    // eslint-disable-next-line no-console -- last chance before the process dies.
    console.error('fatal: failed to start whiteboard api:', err?.stack ?? err);
    process.exit(1);
  });
}

export { DEMO_ELEMENTS, SHUTDOWN_GRACE_MS, isEntryPoint };
