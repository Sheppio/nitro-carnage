/**
 * Single-client browser suite: boot, menus, driving, the camera, the
 * occlusion cut-away and the draw-call budget, in real Chromium on
 * SwiftShader. Assertions poll for outcomes; nothing waits a fixed time.
 */
import { buildRig, launch, reporter, startServer, until } from './rig.mjs';

const r = reporter('smoke.test');
await buildRig();
const { server, url } = await startServer(8199);
const browser = await launch();

const errors = [];
async function openPage(query, viewport = { width: 800, height: 450 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${url}?${query}`);
  // `?drive` skips the menu straight into a session.
  await page.waitForSelector('#screen-menu:not([hidden]), #screen-hud:not([hidden])');
  return page;
}

try {
  /* --------------------------------------------------------------- menus */
  const page = await openPage('quality=potato');

  const menu = await page.evaluate(() => ({
    title: document.title,
    heading: document.querySelector('.title')?.textContent,
    version: document.getElementById('version')?.textContent,
  }));
  r.check('the name comes from the one brand constant', menu.title === 'NITRO CARNAGE' && menu.heading === 'NITRO CARNAGE');
  r.check('the menu shows the build version', /^v\d+\.\d+\.\d+$/.test(menu.version ?? ''), menu.version);

  const clickable = await page.evaluate(() => {
    const btn = document.getElementById('btn-free-drive');
    // The menu scrolls on a short screen; this is about overlays, not height.
    btn.scrollIntoView({ block: 'center' });
    const box = btn.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === btn;
  });
  r.check('nothing invisible covers the menu buttons', clickable);

  // The menu is the modes and settings; the track, the seed and the controls are a screen of their own.
  const onMenu = await page.evaluate(() => ['menu-track', 'menu-seed', 'menu-keys', 'menu-weapons'].filter((id) => document.getElementById('screen-menu').contains(document.getElementById(id))));
  await page.click('#btn-free-drive');
  await page.waitForSelector('#screen-track:not([hidden])');
  const trackScreen = await page.evaluate(() => {
    const scr = document.getElementById('screen-track');
    const shown = (id) => scr.contains(document.getElementById(id)) && document.getElementById(id).getClientRects().length > 0;
    return {
      has: ['menu-track', 'menu-seed', 'menu-seed-random', 'menu-track-map', 'menu-keys', 'btn-track-go'].every(shown),
      weapons: shown('menu-weapons'),
      title: document.getElementById('track-mode').textContent,
      keys: document.getElementById('menu-keys').textContent,
    };
  });
  r.check('the menu keeps to the modes and settings; Hotlap opens a track screen with the seed, a map and the controls, and no weapons switch',
    onMenu.length === 0 && trackScreen.has && !trackScreen.weapons && trackScreen.title === 'Hotlap' && /Steer/.test(trackScreen.keys),
    `${onMenu.length ? `still on the menu: ${onMenu.join(' ')}; ` : ''}${trackScreen.title}, weapons ${trackScreen.weapons ? 'shown' : 'hidden'}`);

  /* ------------------------------------------------------------- driving */
  await page.click('#btn-track-go');
  await page.waitForSelector('#screen-hud:not([hidden])');
  const booted = await until(() => page.evaluate(() => (window.nitro.session?.world.steps ?? 0) > 30));
  r.check('free drive boots a world and a canvas', Boolean(booted) && (await page.locator('canvas.game-canvas').count()) === 1);

  // Every second of wall time becomes exactly 60 steps, however the frames
  // fall — up to the stall clamp. A frame longer than 0.25 s is simulated as
  // 0.25 s on purpose (a tab waking from sleep must not teleport), so on a
  // renderer managing two frames a second, as CI's does while its shaders
  // compile, the race slows down with it. Measured against the clamped clock
  // the rate is exact; the wall rate is reported alongside for information.
  const rate = await page.evaluate(async () => {
    const w = window.nitro.session.world;
    const s0 = w.steps;
    const c0 = w.clockTime;
    const t0 = performance.now();
    await new Promise((res) => setTimeout(res, 1500));
    return { clock: (w.steps - s0) / (w.clockTime - c0), wall: ((w.steps - s0) * 1000) / (performance.now() - t0) };
  });
  r.check('the world takes 60 steps per second of clock', Math.abs(rate.clock - 60) < 1.5,
    `${rate.clock.toFixed(1)} per clock second, ${rate.wall.toFixed(1)} per wall second`);

  const car = () => page.evaluate(() => {
    const c = window.nitro.session.player.car;
    return { x: c.x, z: c.z, v: Math.hypot(c.vx, c.vz), w: c.w, yaw: c.yaw, forward: c.forward };
  });
  const start = await car();
  await page.keyboard.down('ArrowUp');
  const moving = await until(async () => ((await car()).v > 15 ? await car() : null));
  r.check('holding ↑ drives the car forward', Boolean(moving) && moving.forward > 15, moving ? `${moving.v.toFixed(1)} m/s` : 'never got going');

  const shown = await until(() => page.evaluate(() => Number(document.getElementById('hud-speed').textContent) > 40));
  r.check('the HUD shows the speed', Boolean(shown));

  // Camera lead: at speed the car sits behind screen centre, with the road ahead in view.
  const lead = await page.evaluate(() => {
    const s = window.nitro.session;
    const c = s.drawnStates.get('you');
    const p = s.view.toScreen(c.x, c.y, c.z);
    const rect = s.view.renderer.domElement.getBoundingClientRect();
    return { dx: p.x - rect.width / 2, vx: c.vx, fov: s.view.rig.camera.fov };
  });
  r.check('the camera leads: the car sits behind centre, opposite its velocity', lead.dx * Math.sign(lead.vx) < -8,
    `car ${lead.dx.toFixed(0)} px from centre, heading ${lead.vx > 0 ? 'east' : 'west'}`);
  r.check('speed widens the lens', lead.fov > 50.3, `fov ${lead.fov.toFixed(1)}°`);

  // Steering left turns the car left: yaw increases (see car.ts conventions).
  await page.keyboard.down('ArrowLeft');
  const turned = await until(async () => ((await car()).w > 0.2 ? await car() : null), { timeout: 5000 });
  await page.keyboard.up('ArrowLeft');
  r.check('← steers left', Boolean(turned), turned ? `yaw rate ${turned.w.toFixed(2)} rad/s` : 'no left yaw');
  await page.keyboard.up('ArrowUp');
  r.check('the car actually moved from the grid', Math.hypot((moving?.x ?? 0) - start.x, (moving?.z ?? 0) - start.z) > 5);

  // Esc opens the pause menu, and offline that stops the world.
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-veil:not([hidden])');
  const paused = await page.evaluate(async () => {
    const w = window.nitro.session.world;
    const s0 = w.steps;
    await new Promise((res) => setTimeout(res, 400));
    return w.steps === s0;
  });
  r.check('Esc pauses a solo drive: the world stops', paused);
  // Leaving tears the race down completely.
  await page.click('#btn-pause-leave');
  await page.waitForSelector('#screen-menu:not([hidden])');
  const torn = await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas.game-canvas').length, session: window.nitro.session }));
  r.check('leaving returns to the menu and disposes the renderer', torn.canvases === 0 && torn.session === null);
  await page.close();

  /* ----------------------------------------------------------- occlusion */
  // A car near the edge of the screen, with a leaning tower between it and
  // the lens. Found by search rather than hard-coded, so it survives changes
  // to the scenery seed or the camera.
  const occ = await openPage('quality=low&drive', { width: 640, height: 360 });
  await until(() => occ.evaluate(() => (window.nitro.session?.world.steps ?? 0) > 60));
  const probe = await occ.evaluate(() => {
    const s = window.nitro.session;
    s.frozen = true;
    const view = s.view;
    const cam = view.rig.camera;
    const track = s.world.track;
    const hitTower = (eye, px, py, pz) => {
      for (const t of view.scenery.towers) {
        const y0 = t.y ?? 0;
        const mins = [t.x - t.sx / 2, y0, t.z - t.sz / 2];
        const maxs = [t.x + t.sx / 2, y0 + t.sy, t.z + t.sz / 2];
        // Slab test for the segment eye -> point against the tower's box.
        const o = [eye.x, eye.y, eye.z];
        const d = [px - eye.x, py - eye.y, pz - eye.z];
        let lo = 0, hi = 1, ok = true;
        for (let a = 0; a < 3 && ok; a++) {
          if (Math.abs(d[a]) < 1e-9) {
            if (o[a] < mins[a] || o[a] > maxs[a]) ok = false;
          } else {
            let t0 = (mins[a] - o[a]) / d[a];
            let t1 = (maxs[a] - o[a]) / d[a];
            if (t0 > t1) [t0, t1] = [t1, t0];
            lo = Math.max(lo, t0);
            hi = Math.min(hi, t1);
            if (lo > hi) ok = false;
          }
        }
        // The line of sight enters the tower before it reaches the car.
        if (ok && lo < 0.98) return true;
      }
      return false;
    };
    const rect = view.renderer.domElement.getBoundingClientRect();
    // On Neon Downtown a car on the road is covered from roughly one camera
    // position in six, and nearly always right at the edge of the frame (see
    // README) — no place to read pixels from. The alleys between towers are
    // covered all the time, and the shader cannot tell an alley from a road,
    // so the probe car goes there.
    const drawn = s.drawnStates.get('you');
    view.rig.started = false;
    view.rig.update(drawn, 1 / 60);
    cam.updateMatrixWorld();
    const eye = cam.position.clone();
    const inside = (x, z) => view.scenery.towers.some((t) => Math.abs(x - t.x) < t.sx / 2 + 0.8 && Math.abs(z - t.z) < t.sz / 2 + 0.8);
    for (let z = eye.z - 50; z < eye.z + 10; z += 0.5) {
      for (let x = eye.x - 60; x < eye.x + 60; x += 0.5) {
        const p = view.toScreen(x, 1, z);
        if (!p.onScreen || p.x < 40 || p.y < 40 || p.x > rect.width - 40 || p.y > rect.height - 40) continue;
        if (inside(x, z)) continue;
        let covered = true;
        for (const ox of [-0.8, 0, 0.8]) for (const oz of [-1.5, 0, 1.5]) if (covered && !hitTower(eye, x + ox, 1.2, z + oz)) covered = false;
        if (covered) return { x, z, yaw: 0 };
      }
    }
    return null;
  });
  r.check('the search finds a spot where a tower hides a car from the lens', Boolean(probe), probe ? `at ${probe.x.toFixed(0)}, ${probe.z.toFixed(0)}` : '');

  if (probe) {
    const counts = await occ.evaluate((pr) => {
      const s = window.nitro.session;
      const view = s.view;
      // A plain lime car: no stripes (M6 liveries would be counted as "not car").
      if (!view.cars.has('probe')) view.addCar('probe', 0x8cf000, { body: 'coupe', pattern: 'none', stripe: 'lime', rims: 'body', number: 0 });
      const probeState = { ...s.drawnStates.get('you'), x: pr.x, z: pr.z, y: 0, yaw: pr.yaw, vx: 0, vz: 0, forward: 0, accelLat: 0, accelLong: 0 };
      const states = new Map([...s.drawnStates, ['probe', probeState]]);
      // Lime: green high, red and blue low. No tower, window or lamp is that colour.
      const lime = (px) => px.filter(([r, g, b]) => g > 120 && g > r * 1.25 && g > b * 1.8).length;
      view.setCutaway(false);
      // The bonnet, not the roof: the roof carries the race number (M6).
      const off = view.samplePixels(states, pr.x, 0.9, pr.z + 1.2, 2);
      view.setCutaway(true);
      // The springs in the car mesh settle over a few frames.
      for (let k = 0; k < 10; k++) view.render(states, 1 / 60);
      const on = view.samplePixels(states, pr.x, 0.9, pr.z + 1.2, 2);
      return { off: lime(off), on: lime(on), total: on.length };
    }, probe);
    r.check('without the cut-away the tower really does hide the car', counts.off <= counts.total * 0.3,
      `${counts.off}/${counts.total} car pixels visible`);
    r.check('with the cut-away the car shows through the tower', counts.on >= counts.total * 0.5,
      `${counts.on}/${counts.total} car pixels visible`);
  }
  await occ.close();

  /* ---------------------------------------------------------------- race */
  // A one-lap race against five bots, with the player's car on autopilot.
  const race = await openPage('quality=potato&race&autopilot&laps=1');
  const countdown = await until(() => race.evaluate(() => {
    const t = document.getElementById('hud-countdown').textContent;
    return ['3', '2', '1'].includes(t) ? t : null;
  }), { timeout: 20000 });
  const held = await race.evaluate(() => {
    const s = window.nitro.session;
    return s.world.countdown > 0 ? s.world.entrants.every((e) => Math.hypot(e.car.vx, e.car.vz) < 0.01) : null;
  });
  r.check('the race opens on a countdown with every car held on the grid', Boolean(countdown) && held !== false, `showing "${countdown}"`);

  const going = await until(() => race.evaluate(() => {
    const s = window.nitro.session;
    return s.world.time > s.world.goTime + 3 && s.world.entrants.every((e) => Math.hypot(e.car.vx, e.car.vz) > 5);
  }), { timeout: 30000 });
  const hudText = await race.evaluate(() => ({
    of: document.getElementById('hud-of').textContent,
    lap: document.getElementById('hud-lap').textContent + document.getElementById('hud-laps').textContent,
    pos: Number(document.getElementById('hud-pos').textContent),
  }));
  r.check('after GO all six cars race, and the HUD shows position and lap', Boolean(going) && hudText.of === '/6' && hudText.lap === '1/1' && hudText.pos >= 1 && hudText.pos <= 6,
    `P${hudText.pos}${hudText.of}, lap ${hudText.lap}`);

  const map = await race.evaluate(() => {
    const c = document.getElementById('hud-minimap');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return lit / (c.width * c.height);
  });
  r.check('the minimap draws the circuit', map > 0.05, `${(map * 100).toFixed(0)}% of it drawn on`);

  const arrows = await until(() => race.evaluate(() => document.querySelectorAll('.rival-arrow').length || null), { timeout: 60000 });
  r.check('rivals out of view get an arrow at the screen edge', Boolean(arrows), `${arrows ?? 0} arrows at once`);

  await race.waitForSelector('#screen-results:not([hidden])', { timeout: 240000 });
  const results = await race.evaluate(() => ({
    rows: document.querySelectorAll('#results-body tr').length,
    you: document.querySelectorAll('#results-body tr.you').length,
    title: document.getElementById('results-title').textContent,
    canvases: document.querySelectorAll('canvas.game-canvas').length,
  }));
  r.check('the race ends on a results table with the player marked', results.rows === 6 && results.you === 1 && /^You finished/.test(results.title) && results.canvases === 0,
    results.title);
  await race.close();

  /* --------------------------------------------------------------- weapons */
  // A race alone (a hotlap has no weapons since M7), past the start grace.
  const arms = await openPage('quality=potato&race&bots=0&laps=9');
  await until(() => arms.evaluate(() => {
    const w = window.nitro.session?.world;
    return w && w.time - w.goTime > 4.3;
  }), { timeout: 60000 });
  const ammo0 = await arms.evaluate(() => document.getElementById('hud-ammo-front').textContent);
  await arms.keyboard.press('KeyZ');
  const drawn = await until(() => arms.evaluate(() => window.nitro.session.view.scene.getObjectByName('missiles').count || null), { timeout: 10000 });
  const ammo1 = await until(() => arms.evaluate((a0) => {
    const t = document.getElementById('hud-ammo-front').textContent;
    return t !== a0 ? t : null;
  }, ammo0), { timeout: 5000 });
  r.check('Z fires a missile: it is drawn, and the HUD counts it off', Boolean(drawn) && Number(ammo1) === Number(ammo0) - 1, `${ammo0} -> ${ammo1}`);

  await arms.keyboard.press('KeyX');
  const mine = await until(() => arms.evaluate(() => window.nitro.session.view.scene.getObjectByName('mines').count || null), { timeout: 10000 });
  r.check('X drops a mine, drawn with its beacon', Boolean(mine));

  // A hit on the player: health bar down, and the car smokes once it is low.
  const bar = await arms.evaluate(async () => {
    const s = window.nitro.session;
    const c = s.player.car;
    s.world.hit('you', 'someone', 1, 'front', 75, c.x, c.z);
    await new Promise((res) => setTimeout(res, 400));
    return { hp: s.player.hp, transform: document.getElementById('hud-hp').style.transform, critical: document.getElementById('hud-hp').classList.contains('critical') };
  });
  r.check('a hit takes health off, and the health bar shows it', bar.hp === 25 && bar.transform === 'scaleX(0.25)', `${bar.hp} health, ${bar.transform}`);
  const wreck = await arms.evaluate(async () => {
    const s = window.nitro.session;
    const c = s.player.car;
    s.world.hit('you', 'someone', 2, 'front', 40, c.x, c.z);
    await new Promise((res) => setTimeout(res, 300));
    return { wrecked: s.player.wrecked > 0, banner: document.getElementById('hud-banner').textContent };
  });
  r.check('shot to nothing, the car is wrecked and the HUD says so', wreck.wrecked && /WRECKED/.test(wreck.banner), wreck.banner);
  const back = await until(() => arms.evaluate(() => {
    const p = window.nitro.session.player;
    return p.wrecked === 0 && p.hp === 35 ? true : null;
  }), { timeout: 10000 });
  r.check('and is back on the road a few seconds later with 35 health', Boolean(back));
  await arms.close();

  /* ------------------------------------------------------ draw-call budget */
  // Small viewport: the count does not depend on resolution, and SwiftShader
  // at full size with a 2048 shadow map takes seconds per frame.
  const hi = await openPage('quality=high&drive', { width: 320, height: 180 });
  const calls = await until(() => hi.evaluate(() => {
    const s = window.nitro.session;
    return s && s.world.steps > 10 ? s.view.drawCalls : 0;
  }), { timeout: 60000 });
  const shadows = await hi.evaluate(() => window.nitro.session.view.renderer.shadowMap.enabled);
  r.check('high quality renders with shadows inside 150 draw calls', shadows && calls > 0 && calls < 150, `${calls} draw calls`);
  await hi.close();

  /* -------------------------------------------------------------- garage */
  // Every body in every livery: built without error, inside the shared
  // collision footprint (4.4 m by 2.0 m, a few centimetres of bumper
  // allowed), within the triangle budget, and wearing its stripe.
  const gp = await openPage('quality=potato');
  await gp.click('#btn-garage');
  await gp.waitForSelector('#screen-garage:not([hidden])');
  // No dropdowns but the number: arrows to click through, colour squares to click on.
  const noSelects = await gp.evaluate(() => [...document.querySelectorAll('#screen-garage select')].map((s) => s.id).join());
  await gp.click('#garage-body .step:last-child');
  const clickedBody = await gp.evaluate(() => window.nitro.garage.current.body);
  await gp.click('#garage-stripe .swatch[title="Jade"]');
  const clickedStripe = await gp.evaluate(() => [window.nitro.garage.current.stripe, document.querySelectorAll('#garage-stripe .swatch.on').length]);
  r.check('the Garage picks by arrows and colour squares; only the race number is a dropdown',
    noSelects === 'garage-number' && clickedBody === 'hatch' && clickedStripe[0] === 'jade' && clickedStripe[1] === 1, `${noSelects}; › gave ${clickedBody}; square gave ${clickedStripe[0]}`);
  const bodies = await gp.evaluate(async () => {
    const out = [];
    for (const body of ['coupe', 'hatch', 'muscle', 'wedge', 'buggy']) {
      for (const pattern of ['none', 'twin', 'offset', 'flash', 'chequer', 'roundel']) {
        window.nitro.garage.set({ body, pattern });
        const mesh = window.nitro.garage.view.mesh;
        const hull = mesh.root.getObjectByName('car-body');
        hull.geometry.computeBoundingBox();
        const bb = hull.geometry.boundingBox;
        // The roof number: the decal nearest the top, which must sit above any stripe under it.
        const disc = mesh.body.children.filter((c) => c.geometry?.type === 'PlaneGeometry').sort((a, b) => b.position.y - a.position.y)[0];
        // The top of whatever the hull has under the disc: every triangle whose plan overlaps the disc's square.
        const pos = hull.geometry.getAttribute('position');
        const idx = hull.geometry.index;
        const vert = (k) => (idx ? idx.getX(k) : k);
        const tri = idx ? idx.count : pos.count;
        let under = -Infinity;
        for (let k = 0; k < tri; k += 3) {
          const v = [vert(k), vert(k + 1), vert(k + 2)];
          const xs = v.map((i) => pos.getX(i)), zs = v.map((i) => pos.getZ(i));
          const half = disc.geometry.parameters.width * 0.45;
          if (Math.min(...xs) <= disc.position.x + half && disc.position.x - half <= Math.max(...xs) && Math.min(...zs) <= disc.position.z + half && disc.position.z - half <= Math.max(...zs)) {
            under = Math.max(under, ...v.map((i) => pos.getY(i)));
          }
        }
        const tris = hull.geometry.getAttribute('position').count / 3;
        // Jade is 0x00c07a: look for its green among the vertex colours (linear, so roughly).
        const col = hull.geometry.getAttribute('color');
        let jade = 0;
        for (let i = 0; i < col.count; i++) if (col.getX(i) < 0.05 && col.getY(i) > 0.4 && col.getZ(i) > 0.1 && col.getZ(i) < 0.4) jade++;
        out.push({ body, pattern, x: Math.max(-bb.min.x, bb.max.x), z: Math.max(-bb.min.z, bb.max.z), tris, jade, clear: disc.position.y - under });
      }
    }
    return out;
  });
  const outside = bodies.filter((b) => b.x > 1.03 || b.z > 2.25);
  const heavy = bodies.filter((b) => b.tris > 600);
  r.check('five bodies, six liveries each: all inside the shared footprint and under 600 triangles',
    bodies.length === 30 && outside.length === 0 && heavy.length === 0,
    `widest ${Math.max(...bodies.map((b) => b.x)).toFixed(2)} m half-width, longest ${Math.max(...bodies.map((b) => b.z)).toFixed(2)} m half-length, most ${Math.max(...bodies.map((b) => b.tris))} triangles${outside.length ? `; outside: ${outside.map((b) => b.body).join(' ')}` : ''}`);
  const striped = bodies.filter((b) => ['twin', 'offset', 'flash', 'chequer'].includes(b.pattern));
  r.check('every striped livery draws its stripe colour, and "none" draws none',
    striped.every((b) => b.jade > 0) && bodies.filter((b) => b.pattern === 'none').every((b) => b.jade === 0),
    striped.filter((b) => b.jade === 0).map((b) => `${b.body}/${b.pattern}`).join(' '));
  const buried = bodies.filter((b) => !(b.clear > 0.005 && b.clear < 0.1));
  r.check('the race number sits on top of the stripes, not under them', buried.length === 0,
    buried.length ? buried.map((b) => `${b.body}/${b.pattern} ${b.clear.toFixed(3)}`).join(' ') : `clear by ${Math.min(...bodies.map((b) => b.clear)).toFixed(3)} m at least`);
  await gp.reload();
  await gp.waitForSelector('#screen-menu:not([hidden])');
  const kept = await gp.evaluate(() => window.nitro.look);
  r.check('the chosen look is kept for next time: after a reload it is the last one picked', kept.body === 'buggy' && kept.pattern === 'roundel' && kept.stripe === 'jade',
    `${kept.body} / ${kept.pattern} / ${kept.stripe}`);
  await gp.close();

  /* ------------------------------------------------------------- hotlap */
  // The track of the day, generated in the browser: the same track Node
  // generates from the same seed, to the byte.
  const hl = await openPage('quality=potato&hotlap&track=day&autopilot');
  const sameTrack = await hl.evaluate(async () => {
    // The same modules the page itself runs, resolved from its own script.
    const main = document.querySelector('script[type="module"][src]').src;
    const g = await import(new URL('sim/track/generate.js', main).href);
    const u = await import(new URL('util.js', main).href);
    return u.hashString(JSON.stringify(g.generateTrack(g.daySeed(Date.UTC(2026, 8, 25, 12))))).toString(16);
  });
  r.check('the browser generates the same track from a seed as Node does, to the byte', sameTrack === 'c235dcbc', sameTrack);
  const label = await hl.evaluate(() => document.getElementById('hud-track').textContent);
  const shows = await hl.evaluate(() => ({ record: !document.getElementById('hud-record-row').hidden, pos: document.getElementById('hud-pos').parentElement.hidden, arms: getComputedStyle(document.getElementById('hud-arms')).display === 'none' }));
  r.check('a hotlap on the track of the day: named on the HUD, a record to beat, no position, no weapons',
    /^Track of the day · /.test(label) && shows.record && shows.pos && shows.arms, label);
  // Two laps on autopilot: the first sets the record, which is saved.
  const saved = await until(() => hl.evaluate(() => {
    const id = window.nitro.session.world.track.def.id;
    const r = localStorage.getItem(`nitrocarnage.best.${id}`);
    return r ? JSON.parse(r) : null;
  }), { timeout: 150000, interval: 500 });
  r.check('a finished lap becomes the record, with its splits, and is kept', saved && saved.time > 20 && saved.splits.length === 3,
    saved ? `${saved.time.toFixed(2)} s, splits ${saved.splits.map((t) => t.toFixed(1)).join(' / ')}` : 'none');
  const split = await until(() => hl.evaluate(() => document.getElementById('hud-split').textContent || null), { timeout: 60000, interval: 100 });
  r.check('on the next lap each checkpoint shows the split against the record', /^[−+]\d+\.\d\d$/.test(split ?? ''), split);
  r.check('the record keeps the lap\'s path for the ghost', Array.isArray(saved?.ghost) && Math.abs(saved.ghost.length / 3 - saved.time * 10) < 3,
    saved?.ghost ? `${saved.ghost.length / 3} poses` : 'no ghost');
  // The ghost: out on the road, a see-through copy, drawn where the record lap was at this moment of the lap.
  const ghost = await until(() => hl.evaluate(() => {
    const s = window.nitro.session;
    const g = s.view.scene.getObjectByName('ghost');
    if (!g || !g.visible) return null;
    const d = Math.abs(s.world.track.project(g.position.x, g.position.z).d);
    let seeThrough = true;
    g.traverse((o) => { if (o.material && !(o.material.transparent && o.material.opacity < 0.5)) seeThrough = false; });
    return { d, seeThrough };
  }), { timeout: 20000, interval: 100 });
  r.check('a see-through ghost drives the record lap on the road beside you', ghost && ghost.d < 9 && ghost.seeThrough, ghost ? `${ghost.d.toFixed(1)} m off the centre line` : 'no ghost');
  // The ghost's lead: Off hides it; a second ahead puts it a second's driving up the road.
  const ahead = await hl.evaluate(async () => {
    const s = window.nitro.session;
    const pos = () => {
      const g = s.view.scene.getObjectByName('ghost');
      return g.visible ? s.world.track.project(g.position.x, g.position.z).s : null;
    };
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    s.frozen = true;
    window.nitro.settings.set('ghostLead', -1);
    await frame();
    const off = pos();
    window.nitro.settings.set('ghostLead', 0);
    await frame();
    const beside = pos();
    window.nitro.settings.set('ghostLead', 1);
    await frame();
    const ahead = pos();
    s.frozen = false;
    window.nitro.settings.set('ghostLead', 0);
    return { off, gap: beside === null || ahead === null ? null : s.world.track.deltaS(beside, ahead) };
  });
  r.check('the ghost can be switched off, or run ahead to show the line: a second ahead is metres up the road',
    ahead.off === null && ahead.gap !== null && ahead.gap > 10, ahead.gap === null ? 'no ghost' : `${ahead.gap.toFixed(1)} m ahead at 1 s`);

  // Damage from a lap is gone at the line.
  const lapsBefore = await hl.evaluate(() => {
    const p = window.nitro.session.player;
    p.hp = 40;
    return p.lap.completed;
  });
  const healed = await until(() => hl.evaluate((n) => {
    const p = window.nitro.session.player;
    return p.lap.completed > n ? p.hp : null;
  }, lapsBefore), { timeout: 150000, interval: 200 });
  r.check('in a hotlap every lap starts with full health', healed === 100, `health ${healed} after the line`);
  await hl.close();

  /* ------------------------------------------------------ every track */
  // Each built-in track boots from a link, names itself on the HUD, and draws
  // inside the budget — not just at the start line but at eight points round
  // the lap, since the worst view is wherever the most scenery crowds in.
  const trackNotes = [];
  let tracksOk = true;
  const wantScenery = {
    downtown: ['towers', 'lamp-heads'],
    greenbelt: ['tree-crowns', 'water', 'props', 'ground-patches', 'ponds', 'windmill-sails'],
    docks: ['containers', 'cranes', 'railway', 'train', 'water', 'props'],
    'downtown-day': ['towers', 'lamp-heads'],
  };
  const layers = {};
  for (const id of Object.keys(wantScenery)) {
    const tp = await openPage(`quality=high&hotlap&track=${id}`, { width: 320, height: 180 });
    const info = await until(() => tp.evaluate(() => {
      const s = window.nitro.session;
      if (!s || s.world.steps < 10) return null;
      const names = new Set();
      s.view.scene.traverse((o) => names.add(o.name.split(':')[0]));
      return { name: document.getElementById('hud-track').textContent, def: s.world.track.def.name, scenery: [...names] };
    }), { timeout: 60000 });
    let worst = 0;
    for (let k = 0; k < 8; k++) {
      await tp.evaluate((f) => {
        const s = window.nitro.session, t = s.world.track, c = s.player.car;
        const pose = t.poseAt(f * t.length);
        Object.assign(c, { x: pose.x, z: pose.z, yaw: pose.yaw, vx: 0, vz: 0, w: 0, hint: pose.i });
      }, k / 8);
      await tp.waitForTimeout(250);
      worst = Math.max(worst, await tp.evaluate(() => window.nitro.session.view.drawCalls));
    }
    // What the scenery is drawn with, for the checks below.
    layers[id] = await tp.evaluate(() => {
      const out = {};
      window.nitro.session.view.scene.traverse((o) => {
        const k = o.name.split(':')[0];
        if (o.material && !out[k]) out[k] = { type: o.material.type, patches: o.material.userData.patches ?? [], height: (o.geometry.computeBoundingBox(), o.geometry.boundingBox.max.y) };
      });
      return out;
    });
    if (id === 'greenbelt') {
      // The sails turn: the same instance, a moment apart, is somewhere else.
      layers.sails = await tp.evaluate(async () => {
        const sails = window.nitro.session.view.scene.getObjectByName('windmill-sails');
        const a = [...sails.instanceMatrix.array.slice(0, 16)];
        await new Promise((res) => setTimeout(res, 400));
        const b = [...sails.instanceMatrix.array.slice(0, 16)];
        return a.some((v, i) => Math.abs(v - b[i]) > 1e-3);
      });
    }
    const missing = wantScenery[id].filter((w) => !info?.scenery.includes(w));
    if (!info || info.name !== info.def || worst >= 150 || missing.length) tracksOk = false;
    trackNotes.push(`${info?.name}: ${worst} draws at worst${missing.length ? `, missing ${missing.join(' ')}` : ''}`);
    await tp.close();
  }
  r.check('all four built-in tracks boot from a link, with their scenery, inside 150 draw calls all the way round', tracksOk, trackNotes.join('; '));
  // Tall things must never hide a car: every scenery layer that stands above a car roof takes the cut-away.
  const uncut = [];
  for (const [id, byName] of Object.entries(layers)) {
    if (typeof byName !== 'object') continue;
    for (const [name, l] of Object.entries(byName)) {
      if (['props', 'windmill-sails', 'towers', 'tree-crowns', 'containers', 'cranes'].includes(name) && !l.patches.includes('cutaway')) uncut.push(`${id}/${name}`);
    }
  }
  r.check('the farm and port scenery takes the cut-away, like the towers, and the windmills turn', uncut.length === 0 && layers.sails === true,
    `${uncut.length ? `no cut-away: ${uncut.join(' ')}` : 'all cut away'}; sails ${layers.sails ? 'turning' : 'still'}`);
  r.check('by day the street lamps are off and the ponds are water', layers['downtown-day']['lamp-heads'].type === 'MeshLambertMaterial' && layers.downtown['lamp-heads'].type === 'MeshBasicMaterial'
    && layers.greenbelt.ponds.type === 'MeshPhongMaterial', `day lamps ${layers['downtown-day']['lamp-heads'].type}, dusk lamps ${layers.downtown['lamp-heads'].type}`);

  /* --------------------------------------------------------------- sound */
  const snd = await openPage('quality=potato&race&autopilot&laps=1');
  await until(() => snd.evaluate(() => window.nitro.session?.world.started), { timeout: 60000 });
  await snd.keyboard.press('KeyZ');
  const sound = await until(() => snd.evaluate(() => {
    const a = window.nitro.audio;
    return a.ctx?.state === 'running' && a.engineVoices > 0 ? { voices: a.engineVoices, music: a.music.playing, started: a.started } : null;
  }), { timeout: 20000 });
  r.check('sound starts on the first key: the race music plays and engines are voiced', sound?.music === 'race' && sound.started > 0, JSON.stringify(sound));
  let most = 0;
  for (let k = 0; k < 20; k++) {
    most = Math.max(most, await snd.evaluate(() => window.nitro.audio.engineVoices));
    await snd.waitForTimeout(100);
  }
  r.check('six cars on track, but only the nearest three engines are voiced', most > 0 && most <= 3, `${most} at most`);
  const muted = await snd.evaluate(async () => {
    const a = window.nitro.audio;
    window.nitro.settings.set('sfxVolume', 0);
    window.nitro.settings.set('musicVolume', 0);
    await new Promise((res) => setTimeout(res, 300));
    const before = a.started;
    await new Promise((res) => setTimeout(res, 1500));
    return { built: a.started - before, voices: a.engineVoices };
  });
  r.check('with both volumes at zero, nothing is built: no notes, no engines', muted.built === 0 && muted.voices === 0, JSON.stringify(muted));
  await snd.close();

  r.check('no page errors or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
