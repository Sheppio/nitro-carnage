/**
 * The whole front end from the keyboard alone: arrow keys move the focus
 * ring, Enter or Space selects, Esc (or Backspace) goes back — no mouse, no
 * click. The same navigator drives the pad (see gamepad.test.mjs), so this
 * suite is the desktop half of "every screen works without a pointer".
 */
import { buildRig, launch, reporter, startServer, until } from './rig.mjs';

const r = reporter('keyboard.test');
await buildRig();
const { server, url } = await startServer(8194);
const browser = await launch();
const errors = [];

const focused = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || '');

/** Every control a player could need on the visible screen (or the open modal). */
const controls = (page) => page.evaluate(() => {
  const modal = [...document.querySelectorAll('[data-nav-modal]:not([hidden])')].filter((m) => m.getClientRects().length).pop();
  const scope = modal ?? document.querySelector('.screen:not([hidden])');
  return [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
    .filter((el) => el.getClientRects().length && !el.hasAttribute('data-nav-skip') && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => el.id || el.textContent.trim());
});

/**
 * Everything the arrow keys can reach from where the focus starts: a
 * breadth-first search over the navigator's own moves. From each control
 * reached so far, press each arrow (real key presses) and note where the
 * focus lands; then put the focus back and try the next. Left and right are
 * skipped on controls that keep them for themselves (a dropdown cycles, a
 * slider moves, a text field has a caret), exactly as the navigator does.
 */
async function walk(page) {
  const start = await focused(page);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const from = queue.shift();
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
      const owns = await page.evaluate((id) => {
        const el = document.getElementById(id);
        return el && (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && ['range', 'text'].includes(el.type)));
      }, from);
      if (owns && (key === 'ArrowLeft' || key === 'ArrowRight')) continue;
      await page.evaluate((id) => document.getElementById(id)?.focus(), from);
      await page.keyboard.press(key);
      const to = await focused(page);
      if (to && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  await page.evaluate((id) => document.getElementById(id)?.focus(), start);
  return seen;
}

/** Arrow to a control: down through the ring, then right, until it has focus. */
async function goTo(page, id) {
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
    for (let k = 0; k < 14; k++) {
      if ((await focused(page)) === id) return true;
      const onSelect = await page.evaluate(() => document.activeElement?.tagName === 'SELECT');
      await page.keyboard.press(onSelect && (key === 'ArrowLeft' || key === 'ArrowRight') ? 'ArrowDown' : key);
    }
  }
  return (await focused(page)) === id;
}

const visible = (page, id) => page.evaluate((i) => !document.getElementById(i).hidden, id);

/** Walk a screen with the arrows: every control on it reached? One `r.check` per screen, at the call. */
async function reach(page) {
  const all = await controls(page);
  const seen = await walk(page);
  const missed = all.filter((c) => !seen.has(c));
  return { ok: missed.length === 0 && all.length > 0, note: missed.length ? `missed ${missed.join(', ')}` : `${all.length} controls` };
}

try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}?quality=potato`);
  await page.waitForSelector('#screen-menu:not([hidden])');

  /* ---------------------------------------------------------------- menu */
  const start = await until(async () => (await focused(page)) || null);
  r.check('the menu opens with a control already focused', Boolean(start), start);
  {
    const x = await reach(page);
    r.check('menu: every control is reachable with the arrow keys', x.ok, x.note);
  }

  // Typing into the name: arrows left and right stay with the caret.
  await goTo(page, 'input-name');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('KEYS');
  await page.keyboard.press('ArrowLeft');
  const stillName = (await focused(page)) === 'input-name';
  await page.keyboard.press('Backspace');
  const name = await page.evaluate(() => document.getElementById('input-name').value);
  r.check('in the name field, left/right move the caret and Backspace deletes', stillName && name === 'KES', `"${name}"`);

  /* ------------------------------------------------------------ settings */
  await goTo(page, 'btn-settings');
  await page.keyboard.press('Enter');
  const settings = await until(() => visible(page, 'screen-settings'));
  r.check('Enter on Settings opens it', Boolean(settings));
  {
    const x = await reach(page);
    r.check('settings: every control is reachable with the arrow keys', x.ok, x.note);
  }
  await goTo(page, 'set-quality');
  const q0 = await page.evaluate(() => document.getElementById('set-quality').value);
  await page.keyboard.press('ArrowRight');
  const q1 = await page.evaluate(() => document.getElementById('set-quality').value);
  r.check('left/right on a dropdown changes its value', q0 !== q1, `${q0} -> ${q1}`);
  await goTo(page, 'set-motion');
  const m0 = await page.evaluate(() => document.getElementById('set-motion').checked);
  await page.keyboard.press('Space');
  const m1 = await page.evaluate(() => document.getElementById('set-motion').checked);
  r.check('Space toggles a checkbox', m0 !== m1);
  await page.keyboard.press('Escape');
  const backToMenu = await until(() => visible(page, 'screen-menu'));
  r.check('Esc goes back to the menu', Boolean(backToMenu));

  /* -------------------------------------------------------------- garage */
  await goTo(page, 'btn-garage');
  await page.keyboard.press('Enter');
  await until(() => visible(page, 'screen-garage'));
  {
    const x = await reach(page);
    r.check('garage: every control is reachable with the arrow keys', x.ok, x.note);
  }
  await goTo(page, 'garage-number');
  const n0 = await page.evaluate(() => window.nitro.look.number);
  await page.keyboard.press('ArrowRight');
  const n1 = await page.evaluate(() => window.nitro.look.number);
  await page.keyboard.press('Escape');
  const gBack = await until(() => visible(page, 'screen-menu'));
  r.check('the race number changes with the arrows, and Esc leaves the Garage', n1 !== n0 && Boolean(gBack), `${n0} -> ${n1}`);

  /* ---------------------------------------------------------------- join */
  await goTo(page, 'btn-join');
  await page.keyboard.press('Enter');
  await until(() => visible(page, 'screen-join'));
  {
    const x = await reach(page);
    r.check('join: every control is reachable with the arrow keys', x.ok, x.note);
  }
  await goTo(page, 'input-room');
  await page.keyboard.type('ab');
  await page.keyboard.press('Backspace');
  const code = await page.evaluate(() => document.getElementById('input-room').value);
  const stillJoin = await visible(page, 'screen-join');
  r.check('Backspace in the room code deletes a letter, it does not leave the screen', stillJoin && code.toUpperCase() === 'A', `"${code}"`);
  await page.keyboard.press('Escape');
  r.check('and Esc leaves it', Boolean(await until(() => visible(page, 'screen-menu'))));

  /* --------------------------------------------------------------- lobby */
  await goTo(page, 'btn-create');
  await page.keyboard.press('Enter');
  const lobby = await until(() => page.evaluate(() => !document.getElementById('screen-lobby').hidden && window.nitro.room?.net.isHost), { timeout: 20000 });
  r.check('Enter on Create room reaches the lobby', Boolean(lobby));
  {
    const x = await reach(page);
    r.check('lobby (as host): every control is reachable with the arrow keys', x.ok, x.note);
  }
  await goTo(page, 'lobby-laps');
  const laps0 = await page.evaluate(() => window.nitro.room.net.state.laps);
  await page.keyboard.press('ArrowRight');
  const laps1 = await until(() => page.evaluate((l) => (window.nitro.room.net.state.laps !== l ? window.nitro.room.net.state.laps : null), laps0));
  r.check('the host changes the laps from the keyboard', laps1 !== null, `${laps0} -> ${laps1}`);
  await page.keyboard.press('Escape');
  r.check('Esc leaves the room', Boolean(await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden && window.nitro.room === null))));

  /* ------------------------------------------------------ race and pause */
  await goTo(page, 'btn-race');
  await page.keyboard.press('Enter');
  await until(() => visible(page, 'screen-hud'), { timeout: 20000 });
  await until(() => page.evaluate(() => window.nitro.session?.world.started), { timeout: 20000 });
  // In the race, the arrows drive the car — they are not menu keys any more.
  await page.keyboard.down('ArrowUp');
  const drove = await until(() => page.evaluate(() => Math.hypot(window.nitro.session.player.car.vx, window.nitro.session.player.car.vz) > 8), { timeout: 20000 });
  await page.keyboard.up('ArrowUp');
  r.check('in a race the arrow keys drive the car', Boolean(drove));

  await page.keyboard.press('Escape');
  const paused = await until(() => page.evaluate(() => !document.getElementById('pause-veil').hidden && window.nitro.session.paused));
  r.check('Esc opens the pause menu', Boolean(paused));
  {
    const x = await reach(page);
    r.check('pause menu: every control is reachable with the arrow keys', x.ok, x.note);
  }
  await page.keyboard.press('Escape');
  const resumed = await until(async () => {
    const s = await page.evaluate(() => ({ veil: document.getElementById('pause-veil').hidden, paused: window.nitro.session.paused }));
    return s.veil && !s.paused ? true : null;
  });
  // Give a double handling a frame to show itself: the veil must stay shut.
  await page.waitForTimeout(300);
  const staysShut = await page.evaluate(() => document.getElementById('pause-veil').hidden);
  r.check('Esc again resumes, and does not reopen the menu it just closed', Boolean(resumed) && staysShut);

  // Settings from the pause menu, and back to it, still paused.
  await page.keyboard.press('Escape');
  await until(() => visible(page, 'pause-veil'));
  await goTo(page, 'btn-pause-settings');
  await page.keyboard.press('Enter');
  const inSettings = await until(() => visible(page, 'screen-settings'));
  await goTo(page, 'set-music');
  const vol0 = await page.evaluate(() => window.nitro.settings.current.musicVolume);
  await page.keyboard.press('ArrowLeft');
  const vol1 = await page.evaluate(() => window.nitro.settings.current.musicVolume);
  await page.keyboard.press('Escape');
  const backInPause = await until(() => page.evaluate(() => !document.getElementById('pause-veil').hidden && !document.getElementById('screen-hud').hidden && window.nitro.session.paused));
  r.check('Settings opens from the pause menu, the music slider moves with the arrows, and Esc returns to the paused race',
    Boolean(inSettings) && vol1 < vol0 && Boolean(backInPause), `music ${vol0} -> ${vol1}`);

  const onLeave = await goTo(page, 'btn-pause-leave');
  await page.keyboard.press('Enter');
  const left = await until(() => page.evaluate(() => !document.getElementById('screen-menu').hidden && window.nitro.session === null));
  r.check('arrows and Enter on Leave race go back to the menu', onLeave && Boolean(left));

  /* ------------------------------------------------------------- results */
  await page.goto(`${url}?quality=potato&race&autopilot&laps=1`);
  await page.waitForSelector('#screen-results:not([hidden])', { timeout: 240000 });
  const resultsFocus = await until(async () => (await focused(page)) || null);
  {
    const x = await reach(page);
    r.check('results: every control is reachable with the arrow keys', x.ok, x.note);
  }
  await page.keyboard.press('Escape');
  const done = await until(() => visible(page, 'screen-menu'));
  r.check('the results screen has focus on arrival, and Esc returns to the menu', Boolean(resultsFocus) && Boolean(done), resultsFocus);

  r.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
