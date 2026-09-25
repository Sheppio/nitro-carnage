/**
 * The game on a phone, by touch alone: an emulated phone in landscape (a
 * coarse pointer, touch events, a small screen), driven with real touch
 * events through the DevTools protocol — two thumbs at once, as a player
 * holds it. No mouse, no keys.
 *
 * Covers PLAN.md §9's mobile suite: the menu by tap, the touch layer only in
 * a race, pedals and the steering slider, weapons, the pause button, and hit
 * tests that nothing invisible sits over a control and no two HUD panels
 * overlap.
 */
import { devices } from 'playwright';
import { buildRig, launch, reporter, startServer, until } from './rig.mjs';

const r = reporter('mobile.test');
await buildRig();
const { server, url } = await startServer(8191);
const browser = await launch();
const errors = [];

const phone = devices['Pixel 7'];
const ctx = await browser.newContext({
  ...phone,
  // Landscape: how a racing game is held.
  viewport: { width: phone.viewport.height, height: phone.viewport.width },
  screen: { width: phone.screen.height, height: phone.screen.width },
});

/** Controls on screen that something else covers at their centre. */
const covered = (page, selector) => page.evaluate((sel) => {
  const bad = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const b = el.getBoundingClientRect();
    if (b.right < 0 || b.bottom < 0 || b.left > innerWidth || b.top > innerHeight) continue;
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (hit && hit !== el && !el.contains(hit)) bad.push(`${el.id || el.getAttribute('aria-label') || el.textContent.trim()} under ${hit.className || hit.tagName}`);
  }
  return bad;
}, selector);

try {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  /** Put fingers down, move them, lift them: `points` is the full set touching now. */
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const centre = (sel) => page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  }, sel);

  await page.goto(`${url}?quality=potato`);
  await page.waitForSelector('#screen-menu:not([hidden])');

  /* ---------------------------------------------------------------- menu */
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  const menuBad = await covered(page, '#screen-menu button, #screen-menu select, #screen-menu input');
  r.check('on a phone the menu controls are all tappable, nothing covering them', coarse && menuBad.length === 0, menuBad.join(', '));
  const layerInMenu = await page.evaluate(() => !document.querySelector('.touch-layer').hidden);
  r.check('the touch layer is not up in the menu, where it would swallow taps', !layerInMenu);

  await page.locator('#btn-race').scrollIntoViewIfNeeded();
  await page.tap('#btn-race');
  await page.waitForSelector('#screen-track:not([hidden])');
  const trackBad = await covered(page, '#screen-track button, #screen-track select, #screen-track input');
  r.check('Quick race opens the track screen, every control of it tappable', trackBad.length === 0, trackBad.join(', '));
  await page.locator('#btn-track-go').scrollIntoViewIfNeeded();
  await page.tap('#btn-track-go');
  await page.waitForSelector('#screen-hud:not([hidden])', { timeout: 30000 });
  const layer = await until(() => page.evaluate(() => !document.querySelector('.touch-layer').hidden || null));
  r.check('tapping Start begins the race, with the touch controls up', Boolean(layer));

  /* ------------------------------------------------------------ the HUD */
  const hudBad = await covered(page, '.touch-btn, #btn-pause');
  r.check('every touch button and the pause button is uncovered', hudBad.length === 0, hudBad.join(', '));
  const overlaps = await page.evaluate(() => {
    const ids = ['hud-race', 'hud-minimap', 'btn-pause', 'hud-speed', 'hud-arms', 'hud-turbo'];
    const boxes = ids.map((id) => {
      const el = id === 'hud-turbo' ? document.getElementById(id).parentElement : document.getElementById(id);
      return { id, b: el.getBoundingClientRect(), shown: el.getClientRects().length > 0 && !el.hidden };
    }).filter((x) => x.shown);
    const pad = document.querySelector('.touch-pad').getBoundingClientRect();
    boxes.push({ id: 'touch-pad', b: pad, shown: true });
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].b, c = boxes[j].b;
        if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) out.push(`${boxes[i].id}/${boxes[j].id}`);
      }
    }
    const off = boxes.filter((x) => x.b.left < 0 || x.b.top < 0 || x.b.right > innerWidth || x.b.bottom > innerHeight).map((x) => x.id);
    return { out, off };
  });
  r.check('no two HUD panels overlap, and none is off screen', overlaps.out.length === 0 && overlaps.off.length === 0,
    [...overlaps.out, ...overlaps.off.map((o) => `${o} off screen`)].join(', '));

  /* ------------------------------------------------------------ driving */
  await until(() => page.evaluate(() => window.nitro.session.world.started), { timeout: 30000 });
  const gas = await centre('.touch-btn.gas');
  await touch('touchStart', [gas]);
  const drove = await until(() => page.evaluate(() => {
    const c = window.nitro.session.player.car;
    return Math.hypot(c.vx, c.vz) > 10 || null;
  }), { timeout: 20000 });
  r.check('holding the accelerator pedal drives the car', Boolean(drove));

  // Second thumb: land on the left half, slide right. The car steers right.
  const vw = await page.evaluate(() => innerWidth);
  const vh = await page.evaluate(() => innerHeight);
  const steerAt = [vw * 0.2, vh * 0.7];
  await touch('touchStart', [gas, steerAt]);
  await touch('touchMove', [gas, [steerAt[0] + 90, steerAt[1] - 30]]);
  const steer = await until(() => page.evaluate(() => {
    const i = window.nitro.session.player.intent;
    return i.steer > 0.5 && i.throttle === 1 ? i.steer : null;
  }), { timeout: 5000 });
  r.check('a second thumb on the left slides to steer, while the first keeps the throttle down', Boolean(steer), `steer ${steer?.toFixed(2)}`);
  const upward = await page.evaluate(() => window.nitro.session.player.intent.brake);
  r.check('drifting the steering thumb upwards does not brake', upward === 0);
  // A nudge is a nudge: 20 px of thumb is a touch of lock, not a big bite of it.
  await touch('touchMove', [gas, [steerAt[0] + 20, steerAt[1]]]);
  await page.waitForTimeout(400);
  const nudge = await page.evaluate(() => window.nitro.session.player.intent.steer);
  r.check('a small thumb movement is a small correction', nudge > 0 && nudge < 0.15, `steer ${nudge.toFixed(3)} for 20 px`);
  await touch('touchEnd', []);

  // Past the start grace, the missile button fires.
  await until(() => page.evaluate(() => window.nitro.session.world.time - window.nitro.session.world.goTime > 4.3), { timeout: 20000 });
  const ammo0 = await page.evaluate(() => window.nitro.session.player.ammo.front);
  const fire = await centre('.touch-btn[data-drive="front"]');
  await touch('touchStart', [fire]);
  await page.waitForTimeout(150);
  await touch('touchEnd', []);
  const ammo1 = await until(() => page.evaluate((a) => (window.nitro.session.player.ammo.front < a ? window.nitro.session.player.ammo.front : null), ammo0));
  r.check('tapping the missile button fires one', ammo1 === ammo0 - 1, `${ammo0} -> ${ammo1}`);

  /* -------------------------------------------------------------- pause */
  await page.tap('#btn-pause');
  const paused = await until(() => page.evaluate(() => (!document.getElementById('pause-veil').hidden && window.nitro.session.paused) || null));
  const pauseBad = await covered(page, '#pause-veil button');
  r.check('the pause button opens the pause menu, every button of it tappable', Boolean(paused) && pauseBad.length === 0, pauseBad.join(', '));
  await page.tap('#btn-resume');
  const resumed = await until(() => page.evaluate(() => (document.getElementById('pause-veil').hidden && !window.nitro.session.paused) || null));
  r.check('and Resume carries on', Boolean(resumed));

  r.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
