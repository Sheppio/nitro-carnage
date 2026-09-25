/**
 * Several real browser tabs in one room, through the loopback broker (the
 * MQTT stub relays over a BroadcastChannel, so tabs share one "broker"
 * offline). Most of the room logic is proven faster in Node (net.test.mjs);
 * this suite proves the same things end to end: real pages, real renderers,
 * real timers. Assertions poll for outcomes.
 */
import { buildRig, launch, reporter, startServer, until } from './rig.mjs';

const r = reporter('multiplayer.test');
await buildRig();
const { server, url } = await startServer(8198);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
const errors = [];

async function open(name, query = '') {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
  });
  // The name is read from storage at startup; a share link skips the menu,
  // so it has to be in place before the page's own script runs.
  await page.addInitScript((n) => localStorage.setItem('nitrocarnage.name', n), name);
  await page.goto(`${url}?quality=potato&autopilot${query}`);
  await page.waitForSelector('#screen-menu:not([hidden]), #screen-connecting:not([hidden]), #screen-lobby:not([hidden]), #screen-hud:not([hidden])');
  return page;
}

const net = (page, fn) => page.evaluate(fn);
const phase = (page) => page.evaluate(() => window.nitro.room?.net.phase ?? null);
const isHost = (page) => page.evaluate(() => window.nitro.room?.net.isHost ?? false);

try {
  /* ------------------------------------------------------- a room forms */
  const a = await open('ALICE');
  await a.click('#btn-create');
  await a.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  const code = await a.evaluate(() => document.getElementById('lobby-code').textContent);

  const b = await open('BOB', `&room=${code}`);
  await b.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  const roster = await until(async () => {
    const n = await a.evaluate(() => document.querySelectorAll('#lobby-roster li:not(.bot)').length);
    const m = await b.evaluate(() => document.querySelectorAll('#lobby-roster li:not(.bot)').length);
    return n === 2 && m === 2 ? n : null;
  });
  r.check('a room forms from a code and a share link, and both see both', roster === 2, `room ${code}`);
  const hosts = [await isHost(a), await isHost(b)];
  r.check('exactly one host: the first to arrive', hosts[0] === true && hosts[1] === false);

  const colours = await b.evaluate(() => {
    const n = window.nitro.room.net;
    const c = n.room.resolvedColours();
    return Object.values(c);
  });
  r.check('two players asking for the same colour get different ones', new Set(colours).size === 2, colours.join(' / '));

  // Bob's look, set in his Garage, reaches Alice's lobby.
  await b.evaluate(() => {
    document.getElementById('btn-lobby-garage').click();
    window.nitro.garage.set({ body: 'buggy', pattern: 'roundel', number: 42 });
    document.getElementById('btn-garage-back').click();
  });
  const bobId = await b.evaluate(() => window.nitro.room.net.playerId);
  const seen = await until(() => a.evaluate((id) => {
    const l = window.nitro.room.net.carInfo(id).look;
    const icons = [...document.querySelectorAll('#lobby-roster canvas.car-icon')].map((c) => c.dataset.body);
    return l.body === 'buggy' && l.number === 42 && icons.includes('buggy') ? `${l.body} #${l.number}` : null;
  }, bobId), { timeout: 10000 });
  r.check('a look chosen in one tab\'s Garage shows in the other tab\'s lobby', Boolean(seen), seen ?? '');

  const hostOnly = await b.evaluate(() => getComputedStyle(document.getElementById('btn-start-race')).display);
  r.check('only the host gets the Start button', hostOnly === 'none');

  /* --------------------------------------------------- a race, to the end */
  await a.selectOption('#lobby-cars', '3');
  await a.selectOption('#lobby-laps', '1');
  await until(() => b.evaluate(() => window.nitro.room.net.state.cars === 3 && window.nitro.room.net.state.laps === 1));
  await a.click('#btn-start-race');
  await Promise.all([a, b].map((p) => p.waitForSelector('#screen-hud:not([hidden])', { timeout: 20000 })));
  const grid = await b.evaluate(() => window.nitro.session.world.entrants.map((e) => (e.remote ? 'R' : 'L')).join(''));
  r.check('both tabs race: own car local, the rest remote', grid.split('').filter((x) => x === 'L').length === 1 && grid.length === 3, grid);

  // Every tab's world keeps to the room clock. Stepping by frame time, a tab
  // lost every long frame for good (the scene build at the start, a hitch):
  // a host fell seconds behind, its packets arrived "old", and every remote
  // car stood still between packets and jumped at each, 20 times a second.
  await until(() => b.evaluate(() => window.nitro.session.world.started), { timeout: 20000 });
  // Read right after each update: between frames the room clock runs on, and
  // these headless tabs draw a frame only every few hundred milliseconds.
  await Promise.all([a, b].map((p) => p.evaluate(() => {
    const n = window.nitro.room.net;
    const update = n.update.bind(n);
    n.update = () => { const r = update(); if (n.world) window.__lag = Math.max(window.__lag ?? 0, n.roomNow - n.roomAt(n.world.time)); return r; };
  })));
  await b.waitForTimeout(1500);
  await Promise.all([a, b].map((p) => p.evaluate(() => { window.__lag = 0; })));
  await b.waitForTimeout(1500);
  const lags = await Promise.all([a, b].map((p) => p.evaluate(() => window.__lag)));
  const smooth = await b.evaluate(() => new Promise((res) => {
    const s = window.nitro.session;
    const pts = {};
    const t0 = performance.now();
    const f = () => {
      const now = performance.now();
      for (const e of s.world.entrants) if (e.remote) { const c = s.drawnStates.get(e.id); (pts[e.id] ??= []).push([now / 1000, c.x, c.z]); }
      if (now - t0 < 4000) requestAnimationFrame(f);
      else {
        let n = 0, jumps = 0;
        for (const p of Object.values(pts)) for (let i = 2; i < p.length; i++) {
          const d1 = p[i][0] - p[i - 1][0], d0 = p[i - 1][0] - p[i - 2][0];
          if (d1 <= 0 || d0 <= 0) continue;
          const ax = ((p[i][1] - p[i - 1][1]) / d1 - (p[i - 1][1] - p[i - 2][1]) / d0) / ((d0 + d1) / 2);
          const az = ((p[i][2] - p[i - 1][2]) / d1 - (p[i - 1][2] - p[i - 2][2]) / d0) / ((d0 + d1) / 2);
          n++;
          if (Math.hypot(ax, az) > 150) jumps++;
        }
        res({ n, jumps });
      }
    };
    requestAnimationFrame(f);
  }));
  r.check('every tab keeps its world on the room clock, and remote cars glide rather than jump',
    lags.every((l) => l < 100) && smooth.jumps <= smooth.n * 0.1,
    `worlds at most ${lags.map((l) => l.toFixed(0)).join(' / ')} ms behind the room; ${smooth.jumps} of ${smooth.n} frames jump`);

  const moving = await until(() => b.evaluate(() => {
    const s = window.nitro.session;
    return s.world.time > s.world.goTime + 3 && s.world.entrants.every((e) => Math.hypot(e.car.vx, e.car.vz) > 5);
  }), { timeout: 30000 });
  r.check('after GO every car moves on every screen', Boolean(moving));

  // Alice fires (her autopilot drives; the trigger is hers): Bob sees the shot.
  // Deliberately, rather than waiting for a bot to feel like it — in CI a
  // one-lap race once ended before any bot had.
  await until(() => a.evaluate(() => {
    const w = window.nitro.session?.world;
    return w && w.time - w.goTime > 4.5 ? true : null;
  }), { timeout: 30000 });
  const aliceId = await a.evaluate(() => window.nitro.room.net.playerId);
  let remoteShot = null;
  for (let k = 0; k < 6 && !remoteShot; k++) {
    await a.keyboard.press('KeyZ');
    remoteShot = await until(() => b.evaluate((id) => window.nitro.session?.world.armoury.missiles.some((m) => m.owner === id && !m.live) || null, aliceId),
      { timeout: 1500, interval: 30 });
  }
  r.check('a missile fired in one tab flies in the other', Boolean(remoteShot));

  const gridA = await a.evaluate(() => window.nitro.room.net.state.grid.join('.'));
  const gridB = await b.evaluate(() => window.nitro.room.net.state.grid.join('.'));
  r.check('the grid is the same on both screens: two humans and a bot', gridA === gridB && gridA.split('.').length === 3 && /\.b2$/.test(gridA));

  await Promise.all([a, b].map((p) => p.waitForSelector('#screen-results:not([hidden])', { timeout: 240000 })));
  const orderA = await a.evaluate(() => [...document.querySelectorAll('#results-body tr td:nth-child(2)')].map((t) => t.textContent).join(','));
  const orderB = await b.evaluate(() => [...document.querySelectorAll('#results-body tr td:nth-child(2)')].map((t) => t.textContent).join(','));
  // Each screen calls itself YOU; compare with that normalised away.
  const norm = (s, me) => s.replace('YOU', me);
  r.check('the race reaches the results on both screens, in the same order', norm(orderA, 'ALICE') === norm(orderB, 'BOB'), norm(orderA, 'ALICE'));
  const botName = orderA.split(',').find((n) => n !== 'YOU' && n !== 'BOB');
  r.check('the bot races under a driver\'s name, the same on both screens', Boolean(botName) && !/^BOT/.test(botName) && orderB.includes(botName), botName ?? '');
  // Back to lobby goes straight there, before the room itself goes back.
  await b.click('#btn-again');
  const early = await b.evaluate(() => [!document.getElementById('screen-lobby').hidden, window.nitro.room.net.phase]);
  r.check('Back to lobby on the results goes straight back to the lobby', early[0] === true, `lobby shown in phase ${early[1]}`);

  const back = await until(async () => (await phase(a)) === 'L' && (await phase(b)) === 'L' && (await b.evaluate(() => !document.getElementById('screen-lobby').hidden)), { timeout: 40000 });
  r.check('then everyone is back in the lobby', Boolean(back));

  // A new name from the lobby reaches the other screen's roster.
  await b.fill('#lobby-name', 'BOBBY');
  const renamed = await until(() => a.evaluate(() => [...document.querySelectorAll('#lobby-roster li')].some((li) => li.textContent.includes('BOBBY')) || null));
  r.check('a name changed in the lobby shows in everyone\'s roster', Boolean(renamed));

  /* ---------------------------------------------------- failover mid-race */
  const c = await open('CAROL', `&room=${code}`);
  await c.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  await until(() => a.evaluate(() => window.nitro.room.net.room.peers.size === 2));
  await a.selectOption('#lobby-laps', '1');
  await a.click('#btn-start-race');
  await Promise.all([a, b, c].map((p) => p.waitForSelector('#screen-hud:not([hidden])', { timeout: 20000 })));
  await until(() => b.evaluate(() => window.nitro.session.world.time > window.nitro.session.world.goTime + 8), { timeout: 60000 });
  const goAt = await b.evaluate(() => window.nitro.room.net.state.goAt);
  await a.close(); // the host's tab goes, mid-race, without saying goodbye
  const promoted = await until(async () => ((await isHost(b)) ? 'b' : (await isHost(c)) ? 'c' : null), { timeout: 20000 });
  r.check('when the host\'s tab closes mid-race another tab takes over', Boolean(promoted), promoted ? `tab ${promoted}` : '');
  const carriesOn = await b.evaluate(() => ({ goAt: window.nitro.room.net.state.goAt, phase: window.nitro.room.net.phase, racing: !document.getElementById('screen-hud').hidden }));
  r.check('and the race carries on: same GO, still racing', carriesOn.goAt === goAt && ['R', 'F'].includes(carriesOn.phase) && carriesOn.racing);

  /* --------------------------------------------------------- late joiner */
  const d = await open('DAVE', `&room=${code}`);
  const spectating = await until(() => d.evaluate(() => window.nitro.session?.spectating === true), { timeout: 30000 });
  r.check('a late joiner lands in the race as a spectator', Boolean(spectating));
  const banner = await until(() => d.evaluate(() => /SPECTATING/.test(document.getElementById('hud-banner').textContent) || null), { timeout: 10000 });
  r.check('and is told so', Boolean(banner));

  await Promise.all([b, c].map((p) => p.waitForSelector('#screen-results:not([hidden])', { timeout: 240000 })));
  r.check('the race still reaches the results after the failover', true);

  /* -------------------------------------------- a hidden host keeps hosting */
  await until(async () => (await phase(b)) === 'L' && (await phase(c)) === 'L', { timeout: 40000 });
  const host = (await isHost(b)) ? b : c;
  const other = host === b ? c : b;
  // Stop the host's frames entirely and report the tab as hidden: only the
  // Worker ticker is left to run its room.
  await host.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    window.requestAnimationFrame = () => 0;
  });
  const beats = await other.evaluate(async () => {
    const room = window.nitro.room.net.room;
    const s0 = room.lastHeartbeat?.seq ?? 0;
    await new Promise((res) => setTimeout(res, 3500));
    return { gained: (room.lastHeartbeat?.seq ?? 0) - s0, hostId: room.hostId };
  });
  const stillHost = await isHost(host);
  r.check('a hidden host with no frames keeps heartbeating from its worker', beats.gained >= 5 && stillHost, `${beats.gained} beats in 3.5 s`);

  /* ------------------------------------------------------ a frozen tab */
  const cdp = await ctx.newCDPSession(other);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise((res) => setTimeout(res, 20000));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  const woke = await until(() => other.evaluate(() => {
    const n = window.nitro.room.net;
    return n.room.peers.size >= 1 && !n.isHost ? { peers: n.room.peers.size, host: n.isHost } : null;
  }), { timeout: 10000 });
  r.check('a tab frozen for 20 s wakes without splitting the room', Boolean(woke) && (await isHost(host)), woke ? `${woke.peers} peers kept` : 'split');

  r.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
