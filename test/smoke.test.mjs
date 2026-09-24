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
    const box = btn.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === btn;
  });
  r.check('nothing invisible covers the menu buttons', clickable);

  /* ------------------------------------------------------------- driving */
  await page.click('#btn-free-drive');
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
      if (!view.cars.has('probe')) view.addCar('probe', 0x8cf000);
      const probeState = { ...s.drawnStates.get('you'), x: pr.x, z: pr.z, y: 0, yaw: pr.yaw, vx: 0, vz: 0, forward: 0, accelLat: 0, accelLong: 0 };
      const states = new Map([...s.drawnStates, ['probe', probeState]]);
      // Lime: green high, red and blue low. No tower, window or lamp is that colour.
      const lime = (px) => px.filter(([r, g, b]) => g > 120 && g > r * 1.25 && g > b * 1.8).length;
      view.setCutaway(false);
      const off = view.samplePixels(states, pr.x, 1.15, pr.z, 2);
      view.setCutaway(true);
      // The springs in the car mesh settle over a few frames.
      for (let k = 0; k < 10; k++) view.render(states, 1 / 60);
      const on = view.samplePixels(states, pr.x, 1.15, pr.z, 2);
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

  r.check('no page errors or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
