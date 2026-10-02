/**
 * Every suite, in three lanes side by side instead of one after another.
 *
 * smoke alone is the longest suite, so it gets a lane to itself; the other
 * browser suites share a second lane, and the two Node suites a third. Each
 * browser suite serves on its own port and its loopback broker lives inside its
 * own Chromium, so nothing is shared between lanes except the CPU.
 *
 * A suite's output is printed whole when it finishes, so lanes don't interleave.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildRig, ROOT } from './rig.mjs';

const LANES = [
  ['smoke'],
  ['multiplayer', 'keyboard', 'gamepad', 'mobile'],
  ['sim', 'net', 'analytics'],
];

await buildRig();
process.env.RIG_READY = '1';

const started = Date.now();
const results = [];

function run(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'test', `${name}.test.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      process.stdout.write(out);
      results.push({ name, ok: code === 0, seconds: (Date.now() - t0) / 1000 });
      resolve();
    });
  });
}

await Promise.all(LANES.map(async (lane) => {
  for (const name of lane) await run(name);
}));

const clock = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
console.log('\nSuite timings\n');
for (const { name, ok, seconds } of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${clock(seconds)}`);
console.log(`\n  total        ${clock((Date.now() - started) / 1000)}\n`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
