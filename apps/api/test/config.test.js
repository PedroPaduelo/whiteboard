/**
 * `src/config.js` reads `apps/api/.env` (the file `.env.example` tells you to
 * create), and real environment variables still win over it.
 *
 * Each case runs config.js in a child process from a scratch copy, so the
 * file it finds next to itself is the one the test wrote, and neither the
 * repo's own apps/api/.env nor this process's env is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG = fileURLToPath(new URL('../src/config.js', import.meta.url));

/** Load a scratch copy of config.js with `.env` contents and env overrides. */
function configWith(dotenv, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-config-'));
  try {
    mkdirSync(join(root, 'src'));
    copyFileSync(CONFIG, join(root, 'src', 'config.js'));
    if (dotenv !== null) writeFileSync(join(root, '.env'), dotenv);
    const url = pathToFileURL(join(root, 'src', 'config.js')).href;
    const clean = { ...process.env };
    for (const k of ['PORT', 'STORAGE', 'SQLITE_PATH', 'NODE_ENV', 'API_PREFIX', 'LOG_LEVEL']) delete clean[k];
    const out = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const { default: c } = await import(${JSON.stringify(url)}); console.log(JSON.stringify(c));`],
      { cwd: tmpdir(), env: { ...clean, ...env }, encoding: 'utf8' },
    );
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('apps/api/.env is read, whatever the working directory', () => {
  const c = configWith('STORAGE=memory\nPORT=4321\nAPI_PREFIX=/v2\n');
  assert.equal(c.storage, 'memory');
  assert.equal(c.port, 4321);
  assert.equal(c.apiPrefix, '/v2');
});

test('a real environment variable beats the .env file', () => {
  const c = configWith('STORAGE=memory\nPORT=4321\n', { PORT: '5555' });
  assert.equal(c.port, 5555, 'the shell / container env wins');
  assert.equal(c.storage, 'memory', 'the file still fills in what the env did not set');
});

test('no .env file: the documented defaults', () => {
  const c = configWith(null);
  assert.equal(c.storage, 'sqlite');
  assert.equal(c.port, 3001);
});
