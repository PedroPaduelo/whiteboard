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

const INK = '#1f2937';
const SLATE = '#3b82f6';
const MINT = '#22c55e';
const AMBER = '#eab308';

/**
 * A small, readable starter sketch. An empty canvas is a bad first impression:
 * a visitor cannot tell whether the app works, so they leave. This draws the
 * shape of the system itself (browser -> API -> SQLite) in the same vocabulary
 * the UI offers, which doubles as a worked example of every element kind.
 *
 * Element ids are fixed rather than random so a re-seed is recognisable in a
 * log, and short because LIMITS.MAX_ID is 40.
 */
const DEMO_ELEMENTS = [
  {
    id: 'demo-title',
    type: 'text',
    x: 80,
    y: 56,
    w: 660,
    h: 40,
    text: 'Whiteboard demo - drag, draw, or edit anything you see',
    fontSize: 30,
    align: 'left',
    fill: INK,
  },
  // --- the happy path, left to right ---
  {
    id: 'demo-browser',
    type: 'rect',
    x: 80,
    y: 200,
    w: 180,
    h: 96,
    fill: '#ffffff',
    stroke: INK,
    strokeWidth: 2,
  },
  {
    id: 'demo-browser-lbl',
    type: 'text',
    x: 96,
    y: 236,
    w: 148,
    h: 26,
    text: 'Browser',
    fontSize: 20,
    fill: INK,
  },
  {
    id: 'demo-api',
    type: 'rect',
    x: 360,
    y: 200,
    w: 180,
    h: 96,
    fill: '#bfdbfe',
    stroke: SLATE,
    strokeWidth: 2,
  },
  {
    id: 'demo-api-lbl',
    type: 'text',
    x: 400,
    y: 236,
    w: 120,
    h: 26,
    text: 'API',
    fontSize: 20,
    fill: INK,
  },
  {
    id: 'demo-db',
    type: 'cylinder',
    x: 640,
    y: 200,
    w: 160,
    h: 96,
    fill: '#bbf7d0',
    stroke: MINT,
    strokeWidth: 2,
  },
  {
    id: 'demo-db-lbl',
    type: 'text',
    x: 672,
    y: 236,
    w: 110,
    h: 26,
    text: 'SQLite',
    fontSize: 20,
    fill: INK,
  },
  // --- arrows, attached so they follow their boxes when you drag them ---
  {
    id: 'demo-arrow-1',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 260, y: 248 },
      { x: 360, y: 248 },
    ],
    startId: 'demo-browser',
    endId: 'demo-api',
    stroke: SLATE,
    strokeWidth: 2,
  },
  {
    id: 'demo-arrow-2',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 540, y: 248 },
      { x: 640, y: 248 },
    ],
    startId: 'demo-api',
    endId: 'demo-db',
    stroke: MINT,
    strokeWidth: 2,
  },
  // --- a decision and a note, so the board looks designed, not dumped ---
  {
    id: 'demo-gate',
    type: 'diamond',
    x: 380,
    y: 380,
    w: 150,
    h: 110,
    fill: '#fed7aa',
    stroke: AMBER,
    strokeWidth: 2,
  },
  {
    id: 'demo-gate-lbl',
    type: 'text',
    x: 396,
    y: 420,
    w: 120,
    h: 30,
    text: 'Valid op?',
    fontSize: 18,
    align: 'center',
    fill: INK,
  },
  {
    id: 'demo-sticky',
    type: 'sticky',
    x: 600,
    y: 380,
    w: 200,
    h: 150,
    label: 'Double-click a shape to rename it. Everything here syncs live to every open tab.',
    fill: '#fde68a',
    stroke: AMBER,
    strokeWidth: 1,
  },
  {
    id: 'demo-arrow-3',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [
      { x: 455, y: 296 },
      { x: 455, y: 380 },
    ],
    startId: 'demo-api',
    endId: 'demo-gate',
    stroke: AMBER,
    strokeWidth: 2,
  },
];

/**
 * Create the demo board, but only when the store is completely empty. Returns
 * the board, or null when seeding was skipped.
 */
export async function seedDemoBoard(store) {
  const { boards } = await store.listBoards({ limit: 1, offset: 0 });
  if (boards.length > 0) return null;

  const board = await store.createBoard({ title: 'Demo', theme: 'light', ownerId: null });
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

export async function main() {
  // `driver` and `storage` carry the same value under both names the store
  // entrypoint might read, and `path`/`sqlitePath` likewise — the dispatcher
  // owns that choice and this file should not break if it differs.
  const store = await createStore({
    driver: config.storage,
    storage: config.storage,
    path: config.sqlitePath,
    sqlitePath: config.sqlitePath,
    config,
  });
  const hub = new Hub(config);
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
