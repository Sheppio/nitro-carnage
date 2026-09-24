/**
 * Shared browser test rig (ported from glitchburst).
 *
 * The game pulls three.js and MQTT.js from a CDN and talks to a public broker.
 * Neither belongs in a test: the CDN is a network dependency and the broker is
 * shared with the whole internet. So the rig writes a copy of index.html whose
 * import map points at the local three.js build and at a loopback broker stub,
 * and serves the repository over http.
 *
 * The stub relays publishes over a BroadcastChannel, so several tabs share one
 * "broker" — which is what makes a real multi-client room testable offline.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
const RIG = join(HERE, 'rig');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.map': 'application/json', '.png': 'image/png',
};

/**
 * Chromium location: an explicit CHROME_PATH, then the browser this container
 * ships with, and otherwise whatever `playwright install chromium` put down
 * (which is what happens in CI).
 */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return existsSync(bundled) ? bundled : undefined;
}

/** Build test/rig/index.html plus its local dependencies. */
export async function buildRig() {
  await mkdir(RIG, { recursive: true });
  // three.module.js imports ./three.core.js, so both travel together.
  await copyFile(join(ROOT, 'node_modules/three/build/three.module.js'), join(RIG, 'three.module.js'));
  await copyFile(join(ROOT, 'node_modules/three/build/three.core.js'), join(RIG, 'three.core.js'));
  await copyFile(join(HERE, 'mqtt-stub.js'), join(RIG, 'mqtt-stub.js'));

  let html = await readFile(join(ROOT, 'index.html'), 'utf8');
  html = html
    .replace(/"three":\s*"[^"]+"/, '"three": "./three.module.js"')
    .replace(/"mqtt":\s*"[^"]+"/, '"mqtt": "./mqtt-stub.js"')
    .replace('href="./css/ui.css"', 'href="../../css/ui.css"')
    .replace('src="./dist/main.js"', 'src="../../dist/main.js"')
    // Google Fonts are unavailable offline and would stall `networkidle`.
    .replace(/\s*<link rel="preconnect"[^>]*>/g, '')
    .replace(/\s*<link\s+href="https:\/\/fonts\.googleapis[^>]*>/g, '');
  await writeFile(join(RIG, 'index.html'), html);
}

export async function startServer(port = 8199) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = join(ROOT, normalize(url.pathname));
      if (!path.startsWith(ROOT)) throw new Error('outside root');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return { server, url: `http://127.0.0.1:${port}/test/rig/index.html` };
}

/**
 * WebGL through SwiftShader: the container (and CI) has no GPU. `uncapped`
 * lets a single-client test run as fast as it can; multi-client tests must
 * leave it off, because one uncapped tab starves the others.
 */
export async function launch({ uncapped = false } = {}) {
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (uncapped) args.push('--disable-frame-rate-limit');
  return chromium.launch({ executablePath: chromePath(), args });
}

export function reporter(title) {
  let pass = 0;
  let fail = 0;
  console.log(`\n${title}\n`);
  return {
    check(label, ok, note = '') {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
      ok ? pass++ : fail++;
    },
    /** An exception escaped the suite: a failure, but not one of its checks. */
    crashed(err) {
      console.log(`  FAIL  suite crashed — ${err?.stack ?? err}`);
      fail++;
    },
    finish() {
      console.log(`\n  ${pass} passed, ${fail} failed\n`);
      if (fail) process.exitCode = 1;
      return fail === 0;
    },
  };
}

/**
 * Poll until `fn` returns something truthy, or time out. Browser tests assert
 * outcomes by polling, never by sleeping for a fixed time: a slow CI runner
 * renders at a few frames a second, and a sleep tuned on a laptop is a flake.
 */
export async function until(fn, { timeout = 20000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}
