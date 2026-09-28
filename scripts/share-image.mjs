/**
 * docs/share.jpg: the picture a link to the game shows in WhatsApp, iMessage,
 * Slack, Discord and the like (the og:image in index.html). A real frame of a
 * six-car race on Neon Downtown with the HUD hidden, and the title over it.
 * 1200x630, the size link previews expect, and a JPEG well under WhatsApp's
 * ~300 KB limit. `npm run share:image`.
 */
import fs from 'node:fs';
import { buildRig, launch, startServer, until } from '../test/rig.mjs';

await buildRig();
const { server, url } = await startServer(8193);
const browser = await launch();
const W = 1200, H = 630;
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(`${url}?quality=high&race&bots=5&laps=3&weapons=0`);
await until(() => page.evaluate(() => window.nitro?.session?.world.started), { timeout: 60000 });
// Let the pack spread a little down the first straight, flames and all.
await page.evaluate(() => { window.nitro.session.autopilot = true; window.nitro.session.view.rig.baseFov = 38; });
await page.waitForTimeout(4200);
await page.evaluate(() => { document.getElementById('ui-root').style.visibility = 'hidden'; });
await page.waitForTimeout(100);
const frame = await page.screenshot({ type: 'png' });

const card = await browser.newPage({ viewport: { width: W, height: H } });
await card.setContent(`<body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#16131f url(data:image/png;base64,${frame.toString('base64')}) center/cover">
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,8,18,0) 45%,rgba(10,8,18,0.85) 100%)"></div>
  <div style="position:absolute;left:56px;bottom:44px;font-family:'Chakra Petch','DejaVu Sans',sans-serif;color:#fff">
    <div style="font:italic 800 92px 'Chakra Petch','DejaVu Sans',sans-serif;letter-spacing:0.02em;color:#ff5236;-webkit-text-stroke:2px #fff3;text-shadow:0 4px 0 #7a1024,0 8px 24px rgba(0,0,0,0.8)">NITRO CARNAGE</div>
    <div style="font:600 30px 'DejaVu Sans',sans-serif;margin-top:6px;text-shadow:0 2px 8px rgba(0,0,0,0.8)">Top-down combat racing · up to six players · in your browser</div>
  </div></body>`);
await card.waitForTimeout(200);
const out = new URL('../docs/share.jpg', import.meta.url).pathname;
await card.screenshot({ path: out, type: 'jpeg', quality: 82 });
await browser.close();
server.close();
console.log(`wrote docs/share.jpg, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
