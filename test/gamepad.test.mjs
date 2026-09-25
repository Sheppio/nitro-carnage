/**
 * The whole front end by controller alone — no click, no keypress — through a
 * virtual pad stubbed into `navigator.getGamepads()`. Covers PLAN.md §6b:
 * menus, the on-screen keyboard, a race with the Start/Options pause, button
 * prompts that match the pad, and the Steam Deck's 1280x800 screen.
 */
import { buildRig, launch, reporter, startServer, until } from './rig.mjs';

const r = reporter('gamepad.test');
await buildRig();
const { server, url } = await startServer(8197);
const browser = await launch();
const errors = [];

const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const B = { A: 0, B: 1, LB: 4, RB: 5, LT: 6, RT: 7, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/** Installs a controllable virtual pad before the page's scripts run. */
function padScript(id) {
  const pad = {
    id,
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: { playEffect: () => Promise.resolve('complete'), reset: () => Promise.resolve('complete') },
  };
  navigator.getGamepads = () => [pad];
  window.__pad = {
    pad,
    set(i, down) {
      pad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
      pad.timestamp++;
    },
    rename(newId) {
      pad.id = newId;
      window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: pad }));
      window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
    },
  };
  addEventListener('DOMContentLoaded', () => {
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
  });
}

async function open(viewport, id = XBOX, query = 'quality=potato') {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(padScript, id);
  await page.goto(`${url}?${query}`);
  await page.waitForSelector('#screen-menu:not([hidden])');
  return page;
}

/**
 * Press and release a button, held until the page has drawn two frames.
 *
 * Not for a fixed time: the Gamepad API is polled once a frame, and just
 * after a race starts SwiftShader can take 300 ms over a frame while it
 * compiles shaders — a 120 ms tap fell between two frames and was never seen.
 */
const frames = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
async function tap(page, button) {
  await page.evaluate((b) => window.__pad.set(b, true), button);
  await frames(page);
  await page.evaluate((b) => window.__pad.set(b, false), button);
  await frames(page);
}

/** Tap one direction until `id` has focus (at most `max` taps). */
async function padTo(page, id, dir, max = 12) {
  for (let k = 0; k < max; k++) {
    if ((await focused(page)) === id) return true;
    await tap(page, dir);
  }
  return (await focused(page)) === id;
}

const focused = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || '');

try {
  const page = await open({ width: 800, height: 600 });

  /* ------------------------------------------------------ console prompt */
  const prompt = await until(() => page.evaluate(() => !document.getElementById('console-banner').hidden));
  r.check('with a pad connected, the menu asks for Menu/Options to lock it to the window', Boolean(prompt));
  const glyph = await page.evaluate(() => document.querySelector('[data-glyph="confirm"]').textContent);
  r.check('prompts show the Xbox buttons for an Xbox pad', glyph === 'A', `confirm is "${glyph}"`);

  await page.evaluate((id) => window.__pad.rename(id), DUALSENSE);
  const ps = await until(() => page.evaluate(() => {
    const t = document.querySelector('[data-glyph="confirm"]').textContent;
    return t === '✕' ? t : null;
  }));
  r.check('and PlayStation symbols for a DualSense', ps === '✕');
  await page.evaluate((id) => window.__pad.rename(id), XBOX);

  /* ----------------------------------------------- on-screen keyboard */
  // Focus starts on Create room; up reaches the name field; A opens the keyboard.
  await until(async () => (await focused(page)) === 'btn-create');
  const onName = await padTo(page, 'input-name', B.UP);
  await tap(page, B.A);
  const kb = await until(() => page.evaluate(() => !document.getElementById('keyboard-veil').hidden));
  r.check('A on the name field opens the on-screen keyboard', Boolean(onName) && Boolean(kb));
  // Type N, O, V, A: the grid is ten wide, A is the first key.
  const keyAt = (ch) => page.evaluate((c) => [...document.querySelectorAll('.keyboard-grid .key')].findIndex((k) => k.textContent === c), ch);
  let at = 0;
  for (const ch of 'NOVA') {
    const target = await keyAt(ch);
    while (at < target) {
      const step = target - at >= 10 ? B.DOWN : B.RIGHT;
      await tap(page, step);
      at += step === B.DOWN ? 10 : 1;
    }
    while (at > target) {
      const step = at - target >= 10 ? B.UP : B.LEFT;
      await tap(page, step);
      at -= step === B.UP ? 10 : 1;
    }
    await tap(page, B.A);
  }
  await tap(page, B.B);
  const typed = await until(() => page.evaluate(() => (document.getElementById('keyboard-veil').hidden ? document.getElementById('input-name').value : null)));
  r.check('the keyboard types by pad, and B closes it', typed?.endsWith('NOVA'), `name "${typed}"`);

  /* ---------------------------------------------------- race and pause */
  // Down from the name, past Create, Join and the track, to Quick race.
  const onRace = await padTo(page, 'btn-race', B.DOWN);
  await tap(page, B.A);
  const racing = await until(() => page.evaluate(() => !document.getElementById('screen-hud').hidden), { timeout: 20000 });
  r.check('D-pad and A start a quick race from the menu', Boolean(onRace) && Boolean(racing));

  // RT drives once the lights go green.
  await until(() => page.evaluate(() => window.nitro.session.world.started), { timeout: 20000 });
  await page.evaluate((b) => window.__pad.set(b, true), B.RT);
  const drove = await until(() => page.evaluate(() => Math.hypot(window.nitro.session.player.car.vx, window.nitro.session.player.car.vz) > 10), { timeout: 20000 });
  await page.evaluate((b) => window.__pad.set(b, false), B.RT);
  r.check('RT drives the car', Boolean(drove));

  await tap(page, B.MENU);
  const pausedUi = await until(() => page.evaluate(() => !document.getElementById('pause-veil').hidden), { timeout: 5000 });
  const frozen = await page.evaluate(async () => {
    const w = window.nitro.session.world;
    const s0 = w.steps;
    await new Promise((res) => setTimeout(res, 400));
    return w.steps === s0;
  });
  r.check('Menu/Options pauses a solo race: the menu opens and the world stops', Boolean(pausedUi) && frozen);

  await tap(page, B.A); // Resume is the default
  const resumed = await until(() => page.evaluate(() => document.getElementById('pause-veil').hidden && !window.nitro.session.paused));
  r.check('A on Resume carries on', Boolean(resumed));

  await tap(page, B.MENU);
  await until(() => page.evaluate(() => !document.getElementById('pause-veil').hidden));
  const onLeave = await padTo(page, 'btn-pause-leave', B.DOWN);
  await tap(page, B.A);
  const menu = await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden && window.nitro.session === null));
  r.check('and Leave race goes back to the menu', Boolean(onLeave) && Boolean(menu),
    `focus ${onLeave ? 'reached' : 'missed'} Leave, ${menu ? 'back at menu' : `still on ${await page.evaluate(() => [...document.querySelectorAll('.screen:not([hidden])')].map((x) => x.id).join())}`}`);
  /* ---------------------------------------------------------- garage */
  await padTo(page, 'btn-garage', B.DOWN);
  await tap(page, B.A);
  await until(() => page.evaluate(() => !document.getElementById('screen-garage').hidden));
  const body0 = await page.evaluate(() => document.getElementById('garage-body').dataset.value);
  await tap(page, B.RB);
  const body1 = await page.evaluate(() => document.getElementById('garage-body').dataset.value);
  await padTo(page, 'garage-pattern', B.DOWN);
  const pat0 = await page.evaluate(() => document.getElementById('garage-pattern').dataset.value);
  await tap(page, B.RIGHT);
  const pat1 = await page.evaluate(() => document.getElementById('garage-pattern').dataset.value);
  await tap(page, B.B);
  const gOut = await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden));
  const saved = await page.evaluate(() => window.nitro.look);
  r.check('the Garage by pad: RB changes the body, the D-pad the livery, B leaves, and the look is kept',
    body1 !== body0 && pat1 !== pat0 && Boolean(gOut) && saved.body === body1 && saved.pattern === pat1, `${body0}->${body1}, ${pat0}->${pat1}`);

  /* -------------------------------------------------------- settings */
  // Every row of Settings by D-pad alone — the on/off switches included,
  // which sit at the opposite edge of their rows from the dropdowns.
  await padTo(page, 'btn-settings', B.DOWN);
  await tap(page, B.A);
  await until(() => page.evaluate(() => !document.getElementById('screen-settings').hidden));
  const visited = new Set();
  for (let k = 0; k < 12; k++) {
    visited.add(await focused(page));
    await tap(page, B.DOWN);
  }
  const rows = ['set-quality', 'set-touch', 'set-sfx', 'set-music', 'set-vibration', 'set-motion', 'set-autopilot', 'set-broker', 'btn-settings-back'];
  const missed = rows.filter((id) => !visited.has(id));
  await until(async () => (await focused(page)) === 'set-motion' || (await tap(page, B.DOWN), false), { timeout: 10000, interval: 0 });
  const before = await page.evaluate(() => document.getElementById('set-motion').checked);
  await tap(page, B.A);
  const after = await page.evaluate(() => document.getElementById('set-motion').checked);
  await tap(page, B.B);
  const out = await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden));
  r.check('Settings by D-pad: down visits every row, A flips a switch, B goes back', missed.length === 0 && before !== after && Boolean(out),
    missed.length ? `missed ${missed.join(', ')}` : '');
  await page.close();

  /* ------------------------------------------------------- Steam Deck */
  const deck = await open({ width: 1280, height: 800 }, 'Steam Deck Controller (Vendor: 28de Product: 1205)');
  const clipped = async (screen) => deck.evaluate((sel) => {
    const root = document.querySelector(sel);
    const bad = [];
    for (const el of root.querySelectorAll('button, input, select')) {
      if (!el.getClientRects().length) continue;
      const b = el.getBoundingClientRect();
      if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) bad.push(el.id || el.textContent.trim());
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (hit && hit !== el && !el.contains(hit)) bad.push(`${el.id || el.textContent.trim()} (covered)`);
    }
    return bad;
  }, screen);
  const deckGlyph = await until(() => deck.evaluate(() => document.body.dataset.pad));
  const menuBad = await clipped('#screen-menu');
  r.check('Steam Deck (1280x800): the menu fits, nothing clipped or covered, Deck prompts shown', menuBad.length === 0 && deckGlyph === 'deck', menuBad.join(', ') || `pad ${deckGlyph}`);

  await deck.evaluate(() => document.getElementById('btn-garage').click());
  await deck.waitForSelector('#screen-garage:not([hidden])');
  const garageBad = await clipped('#screen-garage');
  r.check('the Garage fits the Deck screen', garageBad.length === 0, garageBad.join(', '));
  await deck.evaluate(() => document.getElementById('btn-garage-back').click());

  await deck.evaluate(() => window.nitro.openRoom('DECK'));
  await deck.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  await until(() => deck.evaluate(() => window.nitro.room?.net.isHost));
  const lobbyBad = await clipped('#screen-lobby');
  r.check('the lobby fits the Deck screen', lobbyBad.length === 0, lobbyBad.join(', '));

  await deck.evaluate(() => window.nitro.leave());
  await deck.evaluate(() => window.nitro.start('race'));
  await deck.waitForSelector('#screen-hud:not([hidden])');
  const hudBad = await deck.evaluate(() => {
    const bad = [];
    for (const id of ['hud-race', 'hud-minimap', 'btn-pause', 'hud-speed']) {
      const b = document.getElementById(id).getBoundingClientRect();
      if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) bad.push(id);
    }
    return bad;
  });
  r.check('and so does the race HUD', hudBad.length === 0, hudBad.join(', '));
  await deck.close();

  r.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
