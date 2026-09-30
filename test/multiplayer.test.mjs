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
  // nostun: direct links between the tabs over this machine only (there is no STUN offline).
  await page.goto(`${url}?quality=potato&autopilot&nostun${query}`);
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
  // A tab on an older build (presence without a wire protocol) is marked,
  // and everyone else is told it has to reload; it goes when it leaves.
  const oldPresence = (alive) => a.evaluate(([c, alive]) => {
    window.nitro.room.mqtt.publish(`nc/room/${c}/pr/zzzzzzzzz0099`, `OLDTIMER,cyan,0,${alive},0,0.1.40,000000`);
  }, [code, alive]);
  await oldPresence(1);
  const warned = await until(() => b.evaluate(() => {
    const row = [...document.querySelectorAll('#lobby-roster li')].find((li) => li.textContent.includes('OLDTIMER'));
    const note = document.getElementById('lobby-builds');
    return row?.textContent.includes('OLD BUILD') && !note.hidden && note.textContent.includes('reload') ? true : null;
  }));
  await oldPresence(0);
  const cleared = await until(() => b.evaluate(() => (document.getElementById('lobby-builds').hidden ? true : null)));
  r.check('a player on an older build is marked in the lobby, with a note to reload, gone when they leave', warned === true && cleared === true);

  // The two tabs open a real WebRTC link, and each lobby says so.
  const linked = await until(async () => {
    const badge = (p) => p.evaluate(() => [...document.querySelectorAll('#lobby-roster li')].filter((li) => li.textContent.includes('DIRECT')).length);
    return (await badge(a)) === 1 && (await badge(b)) === 1 ? true : null;
  }, { timeout: 20000 });
  r.check('the two tabs link directly, and both lobbies show it', linked === true);

  const hosts = [await isHost(a), await isHost(b)];
  r.check('exactly one host: the first to arrive', hosts[0] === true && hosts[1] === false);

  const colours = await b.evaluate(() => {
    const n = window.nitro.room.net;
    const c = n.room.resolvedColours();
    return Object.values(c);
  });
  r.check('two players asking for the same colour get different ones', new Set(colours).size === 2, colours.join(' / '));

  // Colour by squares, in the Garage: a click on one changes Bob's colour for everyone.
  const bob = await b.evaluate(() => window.nitro.room.net.playerId);
  await b.click('#btn-lobby-garage');
  const takenMarked = await b.evaluate(() => document.querySelectorAll('#garage-colour .swatch.taken').length);
  await b.click('#garage-colour .swatch[title="Jade"]');
  await b.click('#btn-garage-back');
  const jade = await until(() => a.evaluate((id) => (window.nitro.room.net.room.resolvedColours()[id] === 'jade' ? true : null), bob));
  r.check('a colour square in the Garage picks your room colour, the others\' marked taken, and the room sees it', Boolean(jade) && takenMarked === 1, `${takenMarked} taken`);

  // The track is the host's own screen, off the lobby; the guest has none.
  const guestCard = await b.evaluate(() => [getComputedStyle(document.getElementById('btn-lobby-track')).display, getComputedStyle(document.getElementById('lobby-guest-track')).display]);
  r.check('only the host gets the track button; the guest sees the track as a picture', guestCard[0] === 'none' && guestCard[1] !== 'none', guestCard.join(' / '));
  await a.click('#btn-lobby-track');
  // The lobby's map shows the host's track on the guest's screen too.
  await a.selectOption('#lobby-track', 'seed');
  await a.fill('#lobby-seed', 'egg-cup-top');
  await a.dispatchEvent('#lobby-seed', 'change');
  const mapped = await until(() => b.evaluate(() => {
    const info = document.getElementById('lobby-guest-info').textContent;
    const c = document.getElementById('lobby-guest-map');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return window.nitro.room.net.state.seed !== 0 && lit > 0 && info.length > 0 ? info : null;
  }));
  r.check('the lobby draws a map of the room\'s track, on the guest\'s screen too', Boolean(mapped), mapped ?? '');
  // Tomorrow's date as a seed: the host sees it locked, and the room keeps its track.
  const seedBefore = await a.evaluate(() => window.nitro.room.net.state.seed);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await a.fill('#lobby-seed', tomorrow);
  await a.dispatchEvent('#lobby-seed', 'change');
  const lockedInfo = await until(() => a.evaluate(() => {
    const info = document.getElementById('lobby-track-info').textContent;
    return /Locked/.test(info) ? info : null;
  }));
  await a.waitForTimeout(300);
  const seeds = await Promise.all([a, b].map((p) => p.evaluate(() => window.nitro.room.net.state.seed)));
  r.check('a future day\'s Track of the Day typed in the lobby is locked, and never reaches the room',
    Boolean(lockedInfo) && seeds.every((s) => s === seedBefore), `${lockedInfo} ${seeds} vs ${seedBefore}`);
  await a.selectOption('#lobby-track', 'day');
  const daySeedBox = await until(() => a.evaluate(() => {
    const v = document.getElementById('lobby-seed').value;
    return v === new Date().toISOString().slice(0, 10) ? v : null;
  }));
  r.check('picking the Track of the Day puts its seed, today\'s date, in the seed box', Boolean(daySeedBox), daySeedBox ?? '');
  await a.selectOption('#lobby-track', '0');
  await a.click('#btn-lobby-track-done');
  const doneBack = await a.evaluate(() => !document.getElementById('screen-lobby').hidden && document.activeElement?.id);
  r.check('Done on the track screen goes back to the lobby, on the track card', doneBack === 'btn-lobby-track', String(doneBack));

  // Bob's look, set in his Garage, reaches Alice's lobby.
  await b.evaluate(() => {
    document.getElementById('btn-lobby-garage').click();
    window.nitro.garage.set({ body: 'buggy', pattern: 'roundel', number: 42 });
    document.getElementById('btn-garage-back').click();
  });
  const bobId = await b.evaluate(() => window.nitro.room.net.playerId);
  const seen = await until(() => a.evaluate((id) => {
    const l = window.nitro.room.net.carInfo(id).look;
    const row = [...document.querySelectorAll('#lobby-roster li')].find((li) => li.textContent.includes('BOB'));
    const car = row?.querySelector('canvas.car-portrait');
    return l.body === 'buggy' && l.number === 42 && car?.dataset.body === 'buggy' && /Buggy/.test(row.textContent) ? `${l.body} #${l.number}` : null;
  }, bobId), { timeout: 10000 });
  r.check('a look chosen in one tab\'s Garage shows in the other tab\'s lobby, the car drawn and its body named', Boolean(seen), seen ?? '');
  // The Car type (#17). Single: every car in the roster in the host's body.
  const aliceBody = await a.evaluate(() => window.nitro.room.net.carInfo(window.nitro.room.net.playerId).look.body);
  await a.selectOption('#lobby-body', '1');
  const allSame = await until(() => b.evaluate((want) => {
    const bodies = [...document.querySelectorAll('#lobby-roster canvas.car-portrait')].map((c) => c.dataset.body);
    return bodies.length && new Set(bodies).size === 1 && bodies[0] === want ? bodies[0] : null;
  }, aliceBody));
  r.check('Single car type: every car in the roster shows the host\'s body', Boolean(allSame), allSame ?? '');
  // Distinct: no two alike in the roster, and in Bob's Garage the host's body is taken and stepped past.
  await b.evaluate(() => { document.getElementById('btn-lobby-garage').click(); window.nitro.garage.set({ body: 'coupe' }); document.getElementById('btn-garage-back').click(); });
  await a.evaluate(() => { document.getElementById('btn-lobby-garage').click(); window.nitro.garage.set({ body: 'coupe' }); document.getElementById('btn-garage-back').click(); });
  await a.selectOption('#lobby-body', '2');
  const distinct = await until(() => b.evaluate(() => {
    const bodies = [...document.querySelectorAll('#lobby-roster canvas.car-portrait')].map((c) => c.dataset.body);
    return bodies.length >= 2 && new Set(bodies).size === bodies.length ? bodies : null;
  }));
  const skipped = await b.evaluate(() => {
    document.getElementById('btn-lobby-garage').click();
    const pick = document.getElementById('garage-body');
    const was = { taken: pick.classList.contains('taken'), text: pick.textContent };
    const seen = [];
    for (let k = 0; k < 8; k++) {
      pick.dispatchEvent(new CustomEvent('nc:cycle', { detail: { dir: 1 } }));
      seen.push(pick.dataset.value);
    }
    window.nitro.garage.set({ body: 'buggy' });
    document.getElementById('btn-garage-back').click();
    return { was, seen };
  });
  r.check('Distinct car type: both on a coupé, the roster still shows no two alike, and Bob\'s Garage marks the host\'s coupé taken and steps past it',
    Boolean(distinct) && skipped.was.taken && /taken/.test(skipped.was.text) && !skipped.seen.includes('coupe') && new Set(skipped.seen).size === 7,
    JSON.stringify({ distinct, skipped }));
  // Random: dealt at the start, so the roster names no body until then.
  await a.selectOption('#lobby-body', '3');
  const random = await until(() => b.evaluate(() => [...document.querySelectorAll('#lobby-roster li small')].every((s) => s.textContent === 'Random') || null));
  r.check('Random car type: the lobby says Random until the race deals the bodies', Boolean(random));
  await a.selectOption('#lobby-body', '0');

  const hostOnly = await b.evaluate(() => getComputedStyle(document.getElementById('btn-start-race')).display);
  r.check('only the host gets the Start button', hostOnly === 'none');

  /* --------------------------------------------------- a race, to the end */
  await a.selectOption('#lobby-cars', '3');
  await a.selectOption('#lobby-laps', '1');
  await until(() => b.evaluate(() => window.nitro.room.net.state.cars === 3 && window.nitro.room.net.state.laps === 1));
  // Distinct for this race: the host deals the bodies, and both screens race the same, all different.
  await a.selectOption('#lobby-body', '2');
  await until(() => b.evaluate(() => window.nitro.room.net.state.ctype === 2));
  await a.click('#btn-start-race');
  await Promise.all([a, b].map((p) => p.waitForSelector('#screen-hud:not([hidden])', { timeout: 20000 })));
  const grid = await b.evaluate(() => window.nitro.session.world.entrants.map((e) => (e.remote ? 'R' : 'L')).join(''));
  r.check('both tabs race: own car local, the rest remote', grid.split('').filter((x) => x === 'L').length === 1 && grid.length === 3, grid);
  const dealt = await Promise.all([a, b].map((p) => p.evaluate(() => window.nitro.room.net.state.grid.map((id) => window.nitro.room.net.carInfo(id).look.body).join())));
  r.check('a Distinct race: the host deals the bodies, both tabs race the same ones, and no two alike',
    dealt[0] === dealt[1] && new Set(dealt[0].split(',')).size === 3, dealt.join(' / '));

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
  const via = await b.evaluate((id) => window.nitro.room.net.links?.(id).link ?? 'broker', aliceId);
  r.check('a missile fired in one tab flies in the other, over the direct link', Boolean(remoteShot) && via === 'direct', `link ${via}`);

  const gridA = await a.evaluate(() => window.nitro.room.net.state.grid.join('.'));
  const gridB = await b.evaluate(() => window.nitro.room.net.state.grid.join('.'));
  // In a shuffled start order (#21): the bot anywhere on it.
  r.check('the grid is the same on both screens: two humans and a bot', gridA === gridB && gridA.split('.').length === 3 && gridA.split('.').filter((g) => g === 'b2').length === 1, gridA);

  await Promise.all([a, b].map((p) => p.waitForSelector('#screen-results:not([hidden])', { timeout: 240000 })));
  const orderA = await a.evaluate(() => [...document.querySelectorAll('#results-body tr td:nth-child(2)')].map((t) => t.textContent).join(','));
  const orderB = await b.evaluate(() => [...document.querySelectorAll('#results-body tr td:nth-child(2)')].map((t) => t.textContent).join(','));
  // Every screen calls each driver by name, its own player too.
  r.check('the race reaches the results on both screens, in the same order, by name', orderA === orderB && orderA.includes('ALICE') && orderA.includes('BOB'), orderA);
  const botName = orderA.split(',').find((n) => n !== 'ALICE' && n !== 'BOB');
  r.check('the bot races under a driver\'s name, the same on both screens', Boolean(botName) && !/^BOT/.test(botName) && orderB.includes(botName), botName ?? '');
  // Back to lobby goes straight there, before the room itself goes back. The
  // host too: with its race screen gone nothing drove the room, it stayed in
  // its results phase for good, and Start did nothing (found in play).
  await a.click('#btn-again');
  await b.click('#btn-again');
  const early = await b.evaluate(() => [!document.getElementById('screen-lobby').hidden, window.nitro.room.net.phase]);
  r.check('Back to lobby on the results goes straight back to the lobby', early[0] === true, `lobby shown in phase ${early[1]}`);

  const back = await until(async () => (await phase(a)) === 'L' && (await phase(b)) === 'L' && (await b.evaluate(() => !document.getElementById('screen-lobby').hidden)), { timeout: 40000 });
  r.check('then everyone is back in the lobby', Boolean(back));

  // The points are the room's: both lobbies show the same, 10 · 6 · 4.
  const pts = (p) => p.evaluate(() => [...document.querySelectorAll('#lobby-roster .badge.score')].map((b) => parseInt(b.textContent.replace('👑 ', ''), 10)).sort((x, y) => y - x).join(' '));
  const shared = await until(async () => {
    const [pa, pb] = await Promise.all([pts(a), pts(b)]);
    return pa === '10 6 4' && pa === pb ? pa : null;
  });
  r.check('both lobbies show the same points from the race', Boolean(shared), `${await pts(a)} / ${await pts(b)}`);

  // A championship (#8): the host lines up two tracks; the guest sees them.
  await a.click('#btn-lobby-track');
  await a.click('#btn-cup-add');
  await a.selectOption('#lobby-track', '2');
  await a.click('#btn-cup-add');
  const planned = await until(() => b.evaluate(() => {
    const chips = [...document.querySelectorAll('#lobby-cup-list .cup-chip')].map((c) => c.textContent);
    const card = document.getElementById('lobby-guest-info').textContent;
    return chips.length === 2 && /Championship · 2 races/.test(card) ? chips.join(' / ') : null;
  }));
  const startLabel = await a.evaluate(() => document.getElementById('btn-start-race').textContent);
  r.check('the host plans a championship in the lobby, and the guest sees its tracks', Boolean(planned) && /championship/i.test(startLabel), `${planned} · "${startLabel}"`);
  await a.click('#lobby-cup-list button.cup-chip');
  const unplanned = await until(() => b.evaluate(() => (document.querySelectorAll('#lobby-cup-list .cup-chip').length === 1 ? true : null)));
  r.check('and takes one out again with its ✕', Boolean(unplanned));
  await a.click('#lobby-cup-list button.cup-chip');
  await until(() => b.evaluate(() => (window.nitro.room.net.state.cup.length === 0 ? true : null)));
  await a.click('#btn-lobby-track-done');

  /* ---------------------------------------------------- failover mid-race */
  const c = await open('CAROL', `&room=${code}`);
  await c.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  await until(() => a.evaluate(() => window.nitro.room.net.room.peers.size === 2));
  // Two laps, not one: a late joiner arrives after the failover, and a one-lap
  // race (results at about GO+35 s, the lobby 12 s later) sometimes ended
  // before a slow page had loaded, leaving nothing to spectate.
  await a.selectOption('#lobby-laps', '2');
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
