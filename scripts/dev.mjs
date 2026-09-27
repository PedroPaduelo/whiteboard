#!/usr/bin/env node
/**
 * Runs the API and the web dev server together, with prefixed, colourised
 * output and correct signal handling.
 *
 * Deliberately not `concurrently`: the API needs `--experimental-sqlite` and
 * the web does not, and a launcher that gets the flags wrong on one of them is
 * a bad first experience. This is 80 lines and has no dependency.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;

const TARGETS = [
  { name: 'api', color: '\x1b[36m', cmd: 'npm', args: ['run', 'dev', '-w', '@whiteboard/api'] },
  { name: 'web', color: '\x1b[35m', cmd: 'npm', args: ['run', 'dev', '-w', '@whiteboard/web'] },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const children = [];
let shuttingDown = false;

for (const t of TARGETS) {
  const child = spawn(t.cmd, t.args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const prefix = `${t.color}[${t.name}]${RESET} `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`${prefix}${DIM}exited (${signal ?? code})${RESET}`);
    // One side dying means the dev setup is broken; take the other one down so
    // the failure is obvious instead of leaving a half-running stack.
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const c of children) if (!c.killed) c.kill('SIGKILL');
    process.exit(code);
  }, 3000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${DIM}stopping...${RESET}`);
    shutdown(0);
  });
}

console.log(`${DIM}api -> http://localhost:3001/api   web -> http://localhost:5173${RESET}`);
