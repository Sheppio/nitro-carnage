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
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

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
  // A tap is down for exactly one frame's polls, however long that frame
  // takes: the first read of the pad schedules the release for after the
  // frame (a task, so every reader in that frame still sees it down), and the
  // tap resolves once a later read has seen it up.
  let tapping = null;
  navigator.getGamepads = () => {
    if (tapping) {
      if (tapping.state === 'down') {
        tapping.state = 'releasing';
        const t = tapping;
        setTimeout(() => {
          window.__pad.set(t.button, false);
          t.state = 'up';
        }, 0);
      } else if (tapping.state === 'up') {
        const t = tapping;
        tapping = null;
        clearTimeout(t.timer);
        setTimeout(t.done, 0);
      }
    }
    return [pad];
  };
  window.__pad = {
    pad,
    set(i, down) {
      pad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
      pad.timestamp++;
    },
    /** Press and release, seen down in one frame and up in a later one. */
    tap(i) {
      return new Promise((done) => {
        window.__pad.set(i, true);
        tapping = { button: i, state: 'down', done };
        // Nothing reading the pad at all: let go rather than hang the test.
        tapping.timer = setTimeout(() => {
          window.__pad.set(i, false);
          tapping = null;
          done();
        }, 3000);
      });
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

async function open(viewport, id = XBOX, query = 'quality=potato', userAgent = undefined) {
  const page = await browser.newPage({ viewport, userAgent });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(padScript, id);
  await page.goto(`${url}?${query}`);
  await page.waitForSelector('#screen-menu:not([hidden])');
  return page;
}

/**
 * Press and release a button: down for exactly one frame's reads of the pad,
 * then up for at least one (see `__pad.tap`).
 *
 * Not for a fixed time: the Gamepad API is polled once a frame, and just
 * after a race starts SwiftShader can take 300 ms over a frame while it
 * compiles shaders — a 120 ms tap fell between two frames and was never seen.
 * Nor for a count of frames: held for two, a tap on a busy machine outlasted
 * the 420 ms before a held direction repeats, and moved the focus twice.
 */
const frames = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
async function tap(page, button) {
  await page.evaluate((b) => window.__pad.tap(b), button);
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
  // Passing over it is not editing it: read-only, so Xbox Edge raises no keyboard of its own.
  const passing = await page.evaluate(() => document.getElementById('input-name').readOnly && document.getElementById('keyboard-veil').hidden);
  r.check('the pad passing over a text field does not open a keyboard: the field is read-only until A', passing);
  await tap(page, B.A);
  const kb = await until(() => page.evaluate(() => !document.getElementById('keyboard-veil').hidden));
  r.check('A on the name field opens the on-screen keyboard', Boolean(onName) && Boolean(kb));
  // Type N, O, V, A: the grid is ten wide, A is the first key.
  const keyAt = (ch) => page.evaluate((c) => [...document.querySelectorAll('.keyboard-grid .key')].findIndex((k) => k.textContent === c), ch);
  // Where the focus really is, read after every tap rather than counted: a
  // tap the page took twice would otherwise put every later letter one out.
  const onKey = () => page.evaluate(() => [...document.querySelectorAll('.keyboard-grid .key')].indexOf(document.activeElement));
  for (const ch of 'NOVA') {
    const target = await keyAt(ch);
    for (let k = 0, at = await onKey(); at !== target && k < 40; k++, at = await onKey()) {
      const step = at < target ? (target - at >= 10 ? B.DOWN : B.RIGHT) : (at - target >= 10 ? B.UP : B.LEFT);
      await tap(page, step);
    }
    await tap(page, B.A);
  }
  await tap(page, B.B);
  const typed = await until(() => page.evaluate(() => (document.getElementById('keyboard-veil').hidden ? document.getElementById('input-name').value : null)));
  r.check('the keyboard types by pad, and B closes it', typed?.endsWith('NOVA'), `name "${typed}"`);
  // A real keyboard still types straight in: its first key unlocks the field.
  await page.keyboard.press('X');
  const real = await page.evaluate(() => { const f = document.getElementById('input-name'); return { value: f.value, readOnly: f.readOnly }; });
  r.check('a real key typed into a pad-locked field unlocks it and types', real.value.endsWith('NOVAX') && !real.readOnly, JSON.stringify(real));
  await page.keyboard.press('Backspace');

  /* ---------------------------------------------------- race and pause */
  // Down from the name, past Create and Join, to Quick race; A opens the track screen with Start already focused, and A again starts.
  const onRace = await padTo(page, 'btn-race', B.DOWN);
  await tap(page, B.A);
  const onStart = await until(() => page.evaluate(() => (!document.getElementById('screen-track').hidden && document.activeElement?.id === 'btn-track-go') || null));
  // A on the Track dropdown lists every track under its group; down reaches
  // the Track of the day, and A picks it. (Xbox Edge shows no native popup.)
  {
    const before = await page.evaluate(() => document.getElementById('menu-track').value);
    const onTrackSel = await padTo(page, 'menu-track', B.UP);
    await tap(page, B.A);
    const listed = await until(() => page.evaluate(() => {
      const v = document.getElementById('choice-veil');
      return v.hidden ? null : {
        groups: [...v.querySelectorAll('h3')].map((h) => h.textContent),
        items: v.querySelectorAll('.choice').length,
        on: document.activeElement?.classList.contains('current'),
      };
    }));
    const reached = await padTo(page, 'Track of the day', B.DOWN, 40);
    await tap(page, B.A);
    const picked = await until(() => page.evaluate(() => (document.getElementById('choice-veil').hidden ? {
      value: document.getElementById('menu-track').value, focus: document.activeElement?.id,
    } : null)));
    r.check('A on a dropdown opens a list of its options by group, on the current one; down and A pick the Track of the day',
      onTrackSel && listed?.groups.length === 3 && listed.items > 20 && listed.on && reached && picked?.value === 'day' && picked.focus === 'menu-track',
      JSON.stringify({ listed, reached, picked }));
    await page.evaluate((v) => { const s = document.getElementById('menu-track'); s.value = v; s.dispatchEvent(new Event('change')); }, before);
    await padTo(page, 'btn-track-go', B.DOWN);
  }
  await tap(page, B.A);
  const racing = await until(() => page.evaluate(() => !document.getElementById('screen-hud').hidden), { timeout: 20000 });
  r.check('D-pad and A start a quick race from the menu, by way of the track screen', Boolean(onRace) && Boolean(onStart) && Boolean(racing));

  // RT drives once the lights go green.
  await until(() => page.evaluate(() => window.nitro.session.world.started), { timeout: 20000 });
  await page.evaluate((b) => window.__pad.set(b, true), B.RT);
  const drove = await until(() => page.evaluate(() => Math.hypot(window.nitro.session.player.car.vx, window.nitro.session.player.car.vz) > 10), { timeout: 20000 });
  await page.evaluate((b) => window.__pad.set(b, false), B.RT);
  r.check('RT drives the car', Boolean(drove));

  // The face buttons fire as well as the shoulders: Y forward, X backward.
  const faces = await page.evaluate(() => {
    const read = (b) => {
      const pad = window.__pad;
      pad.set(b, true);
      const d = window.nitro.input.gamepad.poll(0, window.nitro.settings.current);
      pad.set(b, false);
      return [d.front, d.rear];
    };
    return { y: read(3), x: read(2), rb: read(5), lb: read(4) };
  });
  r.check('Y fires forward and X backward, as RB and LB do', JSON.stringify(faces) === JSON.stringify({ y: [true, false], x: [false, true], rb: [true, false], lb: [false, true] }), JSON.stringify(faces));

  // A is the handbrake. Held while a menu appears, it is not a press on that
  // menu: that's how the results were clicked through to the lobby unseen.
  await page.evaluate((b) => window.__pad.set(b, true), B.A);
  await frames(page);
  await tap(page, B.MENU);
  await frames(page);
  await frames(page);
  const heldOpen = await page.evaluate(() => !document.getElementById('pause-veil').hidden);
  await page.evaluate((b) => window.__pad.set(b, false), B.A);
  await frames(page);
  r.check('A held from driving does not click the menu that appears (the results were skipped this way)', heldOpen);
  await tap(page, B.A);
  await until(() => page.evaluate(() => document.getElementById('pause-veil').hidden));

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
  const menu = await until(() => page.evaluate(() => !document.getElementById('screen-track').hidden && window.nitro.session === null));
  r.check('and Leave race goes back to the track screen it was started from', Boolean(onLeave) && Boolean(menu),
    `focus ${onLeave ? 'reached' : 'missed'} Leave, ${menu ? 'back on the track screen' : `still on ${await page.evaluate(() => [...document.querySelectorAll('.screen:not([hidden])')].map((x) => x.id).join())}`}`);
  await tap(page, B.B);
  await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden));
  /* ---------------------------------------------------------- garage */
  // In from the track screen, and B goes back out to it.
  await padTo(page, 'btn-race', B.DOWN);
  await tap(page, B.A);
  await until(() => page.evaluate(() => !document.getElementById('screen-track').hidden));
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
  const gOut = await until(() => page.evaluate(() => !document.getElementById('screen-track').hidden));
  await tap(page, B.B);
  await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden));
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
  for (let k = 0; k < 18; k++) {
    // A dropdown under arrows is visited as its arrows, `<id>-pick`.
    visited.add((await focused(page)).replace(/-pick$/, ''));
    await tap(page, B.DOWN);
  }
  const rows = ['set-quality', 'set-touch', 'set-sfx', 'set-music', 'set-bots', 'set-fov', 'set-names', 'set-vibration', 'set-motion', 'set-autopilot', 'set-broker', 'btn-settings-back'];
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
    // A dropdown under arrows is meant to be covered: its arrows are checked instead.
    for (const el of root.querySelectorAll('button, input, select:not(.stepped), .select-stepper')) {
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

  await deck.evaluate(() => document.getElementById('btn-race').click());
  await deck.waitForSelector('#screen-track:not([hidden])');
  const trackBad = await clipped('#screen-track');
  r.check('the track screen fits the Deck screen', trackBad.length === 0, trackBad.join(', '));

  await deck.evaluate(() => document.getElementById('btn-garage').click());
  await deck.waitForSelector('#screen-garage:not([hidden])');
  const garageBad = await clipped('#screen-garage');
  r.check('the Garage fits the Deck screen', garageBad.length === 0, garageBad.join(', '));
  await deck.evaluate(() => document.getElementById('btn-garage-back').click());
  await deck.evaluate(() => document.getElementById('btn-track-back').click());

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

  /* --------------------------------------------------- Xbox on a TV */
  // Xbox Edge at 1080p: the user agent turns the TV layout on, which zooms
  // the overlay 1.4x. Every screen must still fit, the ring must start on
  // each screen's way forward, and B must never throw anyone out of a room.
  const XBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
  const tv = await open({ width: 1920, height: 1080 }, XBOX, 'quality=potato', XBOX_UA);
  const offscreen = (screen) => tv.evaluate((sel) => {
    const bad = [];
    for (const el of document.querySelector(sel).querySelectorAll('button, input, select:not(.stepped), [data-nav]')) {
      if (!el.getClientRects().length) continue;
      const b = el.getBoundingClientRect();
      if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) bad.push(el.id || el.textContent.trim());
    }
    return bad;
  }, screen);
  const tvOn = await tv.evaluate(() => document.body.classList.contains('tv'));
  const tvBad = {};
  tvBad.menu = await offscreen('#screen-menu');
  await tv.evaluate(() => document.getElementById('btn-settings').click());
  await tv.waitForSelector('#screen-settings:not([hidden])');
  const setFocus = await until(() => tv.evaluate(() => document.activeElement?.id === 'set-quality-pick'));
  const touchRow = await tv.evaluate(() => document.getElementById('set-touch-row').hidden);
  tvBad.settings = await offscreen('#screen-settings');
  await tap(tv, B.B);
  await tv.waitForSelector('#screen-menu:not([hidden])');
  // The Garage from the main menu, and Done (B) back to the menu.
  await tv.evaluate(() => document.getElementById('btn-menu-garage').click());
  await tv.waitForSelector('#screen-garage:not([hidden])');
  const garageFocus = await until(() => tv.evaluate(() => document.activeElement?.id === 'garage-body'));
  tvBad.garage = await offscreen('#screen-garage');
  await tap(tv, B.B);
  const garageOut = await until(() => tv.evaluate(() => !document.getElementById('screen-menu').hidden));
  r.check('Xbox at 1080p: the TV layout is on, the menu, Settings and the Garage fit, and they start on their first setting',
    tvOn && !tvBad.menu.length && !tvBad.settings.length && !tvBad.garage.length && Boolean(setFocus) && Boolean(garageFocus) && touchRow && Boolean(garageOut),
    JSON.stringify({ tvOn, tvBad, setFocus, garageFocus, touchRow, garageOut }));

  await tv.evaluate(() => window.nitro.openRoom('TVTV'));
  await tv.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  const hostStart = await until(() => tv.evaluate(() => window.nitro.room?.net.isHost && document.activeElement?.id === 'btn-start-race'));
  const tvLobbyBad = await offscreen('#screen-lobby');
  r.check('Xbox lobby: Start race is on screen, and the host lands on it', Boolean(hostStart) && !tvLobbyBad.length, tvLobbyBad.join(', '));

  await tap(tv, B.B);
  const asked = await until(() => tv.evaluate(() => (!document.getElementById('confirm-veil').hidden && document.activeElement?.id === 'btn-confirm-no') || null));
  await tap(tv, B.B);
  const stayed = await until(() => tv.evaluate(() => (document.getElementById('confirm-veil').hidden && !document.getElementById('screen-lobby').hidden && window.nitro.room !== null) || null));
  r.check('B in the lobby asks before leaving the room, and B again stays', Boolean(asked) && Boolean(stayed));
  await tap(tv, B.B);
  await until(() => tv.evaluate(() => !document.getElementById('confirm-veil').hidden));
  await padTo(tv, 'btn-confirm-yes', B.LEFT, 3);
  await tap(tv, B.A);
  const left = await until(() => tv.evaluate(() => (!document.getElementById('screen-menu').hidden && window.nitro.room === null) || null));
  r.check('and Leave room in the question leaves it', Boolean(left));

  // The pad goes (a flat battery) mid-race: the race pauses.
  await tv.evaluate(() => window.nitro.start('race'));
  await tv.waitForSelector('#screen-hud:not([hidden])');
  await tv.evaluate(() => {
    window.__pad.pad.connected = false;
    window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: window.__pad.pad }));
  });
  const dropped = await until(() => tv.evaluate(() => (!document.getElementById('pause-veil').hidden && window.nitro.session.paused
    && document.getElementById('pause-note').textContent.includes('Controller disconnected')) || null));
  r.check('a controller disconnecting mid-race pauses it and says why', Boolean(dropped));
  await tv.evaluate(() => window.nitro.leave());
  await tv.close();

  r.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
