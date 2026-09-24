/**
 * Regenerate docs/screenshot.png, the gameplay shot in the README.
 *
 *   npm run build && node scripts/screenshot.mjs
 *
 * A real race on the High preset — six cars, the player on autopilot — shot
 * a few seconds after the start, when the pack is still together. Rendered
 * by the same headless Chromium the tests use, so it needs no GPU (and takes
 * a minute on software rendering).
 */
import { buildRig, launch, startServer, until } from '../test/rig.mjs';

const at = Number(process.argv[2] ?? 11);
await buildRig();
const { server, url } = await startServer(8196);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?quality=high&race&autopilot&laps=3`);
await until(() => page.evaluate((t) => {
  const s = window.nitro.session;
  return s && s.world.time > s.world.goTime + t;
}, at), { timeout: 600000, interval: 250 });
// Freeze the moment, let the camera settle on it, then shoot.
await page.evaluate(() => {
  window.nitro.session.frozen = true;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: new URL('../docs/screenshot.png', import.meta.url).pathname, timeout: 600000 });
await browser.close();
server.close();
console.log('docs/screenshot.png written');
