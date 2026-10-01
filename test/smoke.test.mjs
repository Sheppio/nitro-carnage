import fs from 'node:fs';
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

  const rooms = await page.evaluate(() => {
    const c = document.getElementById('btn-create').getBoundingClientRect(), j = document.getElementById('btn-join').getBoundingClientRect();
    return Math.abs(c.top - j.top) < 1 && c.right <= j.left;
  });
  r.check('Create room and Join room share a line on the menu', rooms);

  // The short lists are ‹ arrows › over a hidden dropdown: an arrow steps the
  // dropdown and fires its change, and code setting the dropdown redraws the arrows.
  const steppers = await page.evaluate(() => {
    const sel = document.getElementById('set-bots');
    const pick = document.getElementById('set-bots-pick');
    const was = sel.value;
    let changed = 0;
    sel.addEventListener('change', () => changed++, { once: true });
    pick.querySelector('.step:last-child').click();
    const stepped = sel.value !== was && changed === 1 && pick.textContent.includes(sel.selectedOptions[0].textContent);
    sel.value = 'easy';
    const redrawn = pick.querySelector('.picker-value').textContent === 'Easy';
    sel.value = was;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return stepped && redrawn;
  });
  r.check('arrows in place of the short dropdowns step the dropdown, and redraw when code sets it', steppers);

  // Track of the day: one press from the menu into a hotlap on today's track, turbo off.
  {
    const dp = await openPage('quality=potato');
    await dp.click('#btn-daily');
    await dp.waitForSelector('#screen-hud:not([hidden])');
    const d = await until(() => dp.evaluate(() => {
      const s = window.nitro.session;
      if (!s?.world) return null;
      return { mode: s.mode, turbo: s.world.turbo, meter: s.player.car.turbo, bar: getComputedStyle(document.getElementById('hud-turbo').parentElement).display, label: document.getElementById('hud-track').textContent };
    }));
    r.check('Track of the day goes straight from the menu to a hotlap on today\'s track, with no turbo and no turbo bar',
      d?.mode === 'hotlap' && d.turbo === false && d.meter === 0 && d.bar === 'none' && /^Track of the day \d{4}-\d{2}-\d{2} · .*$/.test(d.label), JSON.stringify(d));
    await dp.close();
  }

  // The track list comes in three groups, the real circuits (M9) among them.
  const groups = await page.evaluate(() => [...document.querySelectorAll('#menu-track optgroup')].map((g) => `${g.label}:${g.children.length}`));
  r.check('the track list is grouped: the game\'s own tracks, 21 real circuits, and the generated ones', JSON.stringify(groups) === JSON.stringify(['Nitro Carnage:4', 'Real circuits:21', 'Generated:2']), groups.join(', '));

  // The menu is the modes and settings; the track, the seed and the controls are a screen of their own.
  const onMenu = await page.evaluate(() => ['menu-track', 'menu-seed', 'menu-keys', 'menu-weapons'].filter((id) => document.getElementById('screen-menu').contains(document.getElementById(id))));
  await page.click('#btn-free-drive');
  await page.waitForSelector('#screen-track:not([hidden])');
  const trackScreen = await page.evaluate(() => {
    const scr = document.getElementById('screen-track');
    const shown = (id) => scr.contains(document.getElementById(id)) && document.getElementById(id).getClientRects().length > 0;
    return {
      // The kind of track, then its list or its seed (#18), a map and the controls.
      has: ['menu-cat-pick', 'menu-track-map', 'menu-keys', 'btn-track-go'].every(shown)
        && (['menu-list', 'menu-list-random', 'menu-fav'].every(shown) || ['menu-seed', 'menu-seed-random', 'menu-seed-fav'].every(shown)),
      kinds: [...document.getElementById('menu-cat').options].map((o) => o.textContent).join(),
      weapons: shown('menu-weapons') || shown('menu-pickups') || shown('menu-turbo') || shown('menu-body'),
      title: document.getElementById('track-mode').textContent,
      keys: document.getElementById('menu-keys').textContent,
    };
  });
  r.check('the menu keeps to the modes and settings; Hotlap opens a track screen with the seed, a map and the controls, and no weapons, power-ups, turbo or car-type switch',
    onMenu.length === 0 && trackScreen.has && !trackScreen.weapons && trackScreen.title === 'Hotlap' && /Steer/.test(trackScreen.keys)
      && trackScreen.kinds === 'Track of the day,Favourites,Real world,Built in,Seeded',
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
  // The turbo is switched off (#19): no bar in the HUD, and no switch in the menus.
  const noTurbo = await page.evaluate(() => ({
    bar: getComputedStyle(document.getElementById('hud-turbo').parentElement).display,
    world: window.nitro.session.world.turbo,
    help: /turbo/i.test(document.getElementById('hud-help').textContent + document.getElementById('menu-keys').textContent),
    touch: Boolean(document.querySelector('.touch-btn.turbo')),
  }));
  r.check('no turbo: no bar in the HUD, none in the race, and no mention in the help or the touch controls',
    noTurbo.bar === 'none' && noTurbo.world === false && !noTurbo.help && !noTurbo.touch, JSON.stringify(noTurbo));

  // Camera lead: at speed the car sits behind screen centre, with the road
  // ahead in view. Measured along the car's own direction, whichever way the
  // start straight runs (east on the 1.6 km Downtown, north on the 30 s one).
  const lead = await page.evaluate(() => {
    const s = window.nitro.session;
    const c = s.drawnStates.get('you');
    const p = s.view.toScreen(c.x, c.y, c.z);
    const rect = s.view.renderer.domElement.getBoundingClientRect();
    const v = Math.hypot(c.vx, c.vz) || 1;
    // North-up camera: screen x is world x, screen y is world z.
    const along = ((p.x - rect.width / 2) * c.vx + (p.y - rect.height / 2) * c.vz) / v;
    return { along, fov: s.view.rig.camera.fov };
  });
  r.check('the camera leads: the car sits behind centre, opposite its velocity', lead.along < -8,
    `car ${(-lead.along).toFixed(0)} px behind centre along its heading`);
  r.check('speed widens the lens', lead.fov > 50.3, `fov ${lead.fov.toFixed(1)}°`);

  // Experimental camera views: a chase camera sits behind the car and turns
  // with it; the cockpit hides the car it is in; C goes to the next view.
  const viewOf = (v) => page.evaluate(async (v) => {
    const s = window.nitro.session;
    window.nitro.settings.set('cameraView', v);
    await new Promise((res) => setTimeout(res, 400));
    const c = s.drawnStates.get('you');
    const cam = s.view.rig.camera.position;
    const me = s.view.cars.get('you').mesh.root;
    return {
      behind: (cam.x - c.x) * Math.sin(c.yaw) + (cam.z - c.z) * Math.cos(c.yaw),
      height: cam.y - c.y,
      near: s.view.rig.camera.near,
      carShown: me.visible,
    };
  }, v);
  const chase = await viewOf('chaseFar');
  r.check('the chase view sits behind and above the car, with the near plane pulled in', chase.behind < -5 && chase.height > 2 && chase.near < 1,
    JSON.stringify(chase));
  const cockpit = await viewOf('cockpit');
  r.check('the cockpit view is in the car, and hides it', Math.abs(cockpit.behind) < 1 && cockpit.height < 2 && !cockpit.carShown,
    JSON.stringify(cockpit));
  await page.keyboard.press('KeyC');
  const cycled = await until(() => page.evaluate(() => (window.nitro.settings.current.cameraView === 'custom'
    ? document.getElementById('hud-banner').textContent : null)));
  r.check('C changes to the next view and names it', /custom/i.test(cycled ?? ''), cycled);
  const overhead = await viewOf('overhead');
  r.check('back overhead, the car shows and the near plane is back', overhead.carShown && overhead.near === 5 && overhead.height > 40,
    JSON.stringify(overhead));

  // Steering left turns the car left: yaw increases (see car.ts conventions).
  await page.keyboard.down('ArrowLeft');
  const turned = await until(async () => ((await car()).w > 0.2 ? await car() : null), { timeout: 5000 });
  await page.keyboard.up('ArrowLeft');
  r.check('← steers left', Boolean(turned), turned ? `yaw rate ${turned.w.toFixed(2)} rad/s` : 'no left yaw');
  // The turbo is off (#19): Shift lights no flames out of the exhausts.
  const flames = () => page.evaluate(() => {
    let n = 0;
    window.nitro.session.view.scene.traverse((o) => { if (o.name === 'exhaust-flame' && o.visible && o.parent?.visible !== false) n++; });
    return n;
  });
  await page.keyboard.down('Shift');
  const lit = await until(async () => ((await flames()) > 0 ? await flames() : null), { timeout: 1500 });
  await page.keyboard.up('Shift');
  r.check('with the turbo off, Shift shoots no flames out of the exhausts', !lit, `${lit ?? 0} flame cones`);
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

  /* ---------------------------------------------------------- photo mode */
  // Photo mode, from the pause menu: the world stays stopped, the card goes,
  // and the camera flies, looks and focuses; H hides the UI, P saves a PNG.
  r.check('the pause menu offers Photo mode offline', await page.isVisible('#btn-pause-photo'));
  await page.click('#btn-pause-photo');
  const inPhoto = await until(() => page.evaluate(() => (window.nitro.photo.active && document.getElementById('pause-veil').hidden
    && !document.getElementById('photo-bar').hidden && getComputedStyle(document.getElementById('hud-race')).visibility === 'hidden') || null));
  r.check('Photo mode hides the pause card and the race HUD, and shows the photo controls', Boolean(inPhoto));
  const shot0 = await page.evaluate(() => ({ steps: window.nitro.session.world.steps, cam: window.nitro.session.view.rig.camera.position.toArray() }));
  for (const key of ['KeyW', 'KeyE']) await page.keyboard.down(key);
  const flown = await until(() => page.evaluate((c0) => {
    const c = window.nitro.session.view.rig.camera.position.toArray();
    return c[1] > c0[1] + 2 && Math.hypot(c[0] - c0[0], c[2] - c0[2]) > 2 ? c : null;
  }, shot0.cam), { timeout: 5000 });
  for (const key of ['KeyW', 'KeyE']) await page.keyboard.up(key);
  const stillPaused = await page.evaluate((s0) => window.nitro.session.world.steps === s0 && window.nitro.session.paused, shot0.steps);
  r.check('W and E fly the camera forward and up, and the world stays stopped', Boolean(flown) && stillPaused, JSON.stringify({ from: shot0.cam, to: flown }));
  // The depth of field: the blur slider, and F focuses on the car.
  await page.evaluate(() => { const b = document.getElementById('photo-blur'); b.value = '50'; b.dispatchEvent(new Event('input')); });
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('KeyF');
  const dof = await page.evaluate(() => {
    const s = window.nitro.session;
    const car = s.drawnStates.get(s.playerId);
    const cam = s.view.rig.camera;
    // View depth, as the depth of field measures it.
    const d = -cam.position.clone().set(car.x, car.y + 0.6, car.z).applyMatrix4(cam.matrixWorldInverse).z;
    return { ...window.nitro.photo.settings, d, out: document.getElementById('photo-blur-out').textContent, calls: s.view.drawCalls };
  });
  r.check('the blur slider sets the depth of field, and F focuses on the car', dof.blur === 0.5 && Math.abs(dof.focus - dof.d) < 0.5 && dof.out === '50%',
    JSON.stringify(dof));
  // A click on a car focuses at the depth of the spot clicked, with the UI
  // hidden as well (so nothing covers the car on this small window); a drag only looks round.
  await page.keyboard.press('KeyH');
  const target = await page.evaluate(() => {
    const s = window.nitro.session, cam = s.view.rig.camera;
    cam.updateMatrixWorld();
    for (const c of s.drawnStates.values()) {
      const p = s.view.toScreen(c.x, c.y + 0.6, c.z);
      if (!p.onScreen) continue;
      return { x: p.x, y: p.y, depth: -cam.position.clone().set(c.x, c.y + 0.6, c.z).applyMatrix4(cam.matrixWorldInverse).z };
    }
    return null;
  });
  // Focused well away from the car first, so the click has something to change.
  const before = await page.evaluate(() => (window.nitro.photo.settings.focus = 150));
  if (target) await page.mouse.click(target.x, target.y);
  const clicked = await page.evaluate(() => ({ focus: window.nitro.photo.settings.focus, ring: !document.getElementById('photo-ring').hidden }));
  await page.mouse.move(400, 200);
  await page.mouse.down();
  await page.mouse.move(460, 220, { steps: 5 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.nitro.photo.settings.focus);
  await page.keyboard.press('KeyH');
  r.check('a click on a car focuses on it, to the depth of the spot clicked, and a drag does not',
    Boolean(target) && Math.abs(clicked.focus - target.depth) < 2.5 && Math.abs(before - target.depth) > 2.5 && clicked.ring && dragged === clicked.focus,
    JSON.stringify({ target, before, clicked, dragged }));
  await page.keyboard.press('KeyH');
  const clean = await page.evaluate(() => getComputedStyle(document.getElementById('photo-bar')).visibility === 'hidden');
  await page.keyboard.press('KeyH');
  const unhidden = await page.evaluate(() => getComputedStyle(document.getElementById('photo-bar')).visibility === 'visible');
  r.check('H hides every bit of UI, and shows it again', clean && unhidden);
  const download = page.waitForEvent('download', { timeout: 10000 });
  await page.keyboard.press('KeyP');
  const file = await download.catch(() => null);
  const png = file ? fs.readFileSync(await file.path()) : null;
  r.check('P saves the frame as a PNG', Boolean(png && png.length > 1000 && png.subarray(1, 4).toString() === 'PNG' && /\.png$/.test(file.suggestedFilename())),
    file?.suggestedFilename() ?? 'no download');
  await page.keyboard.press('Escape');
  const toPause = await page.evaluate(() => ({
    veil: !document.getElementById('pause-veil').hidden, photo: window.nitro.photo.active, body: document.body.className,
    focus: document.activeElement?.id,
  }));
  r.check('Esc goes back to the pause menu, on Photo mode, with the race camera back', toPause.veil && !toPause.photo && !/photo/.test(toPause.body)
    && toPause.focus === 'btn-pause-photo', JSON.stringify(toPause));
  // Leaving tears the race down completely.
  await page.click('#btn-pause-leave');
  // Asked first (#31).
  await page.waitForSelector('#confirm-veil:not([hidden])');
  const question = await page.evaluate(() => ({ title: document.getElementById('confirm-title').textContent, yes: document.getElementById('btn-confirm-yes').textContent }));
  r.check('Leaving asks first (a hotlap here)', question.title === 'Leave the hotlap?' && question.yes === 'Leave', JSON.stringify(question));
  await page.click('#btn-confirm-yes');
  await page.waitForSelector('#screen-track:not([hidden])');
  const torn = await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas.game-canvas').length, session: window.nitro.session }));
  r.check('leaving returns to the track screen and disposes the renderer', torn.canvases === 0 && torn.session === null);

  // A room that can't be reached: Cancel goes back to the menu, not to the
  // track screen of an offline race nobody asked for.
  await page.evaluate(() => {
    window.__brokerRefuses = true;
    void window.nitro.openRoom('NOPE');
  });
  await until(() => page.evaluate(() => document.getElementById('connect-status').textContent.startsWith('Could not reach')));
  await page.evaluate(() => {
    window.__brokerRefuses = false;
    document.getElementById('btn-connect-cancel').click();
  });
  const cancelled = await page.evaluate(() => [...document.querySelectorAll('.screen:not([hidden])')].map((x) => x.id).join());
  r.check('Cancel after a failed connection goes back to the menu', cancelled === 'screen-menu', cancelled);

  // A race that starts while the on-screen keyboard is open (the host pressed
  // Start while a guest typed their name) takes the keyboard away with it.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('nc:text-entry', { detail: { id: 'input-name' } })));
  const kbOpen = await page.evaluate(() => !document.getElementById('keyboard-veil').hidden);
  await page.evaluate(() => window.nitro.start('hotlap'));
  await page.waitForSelector('#screen-hud:not([hidden])');
  const kbGone = await page.evaluate(() => document.getElementById('keyboard-veil').hidden);
  r.check('a race starting under the on-screen keyboard closes it', kbOpen && kbGone);
  await page.evaluate(() => window.nitro.leave());
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
  const gpu = () => race.evaluate(() => ({ ...window.nitro.session.view.renderer.info.memory }));
  const gpu1 = await gpu();
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

  // Driver names: over rivals on screen by default, above the car, and gone when switched off.
  const tagCheck = () => race.evaluate(() => {
    const s = window.nitro.session;
    const box = s.view.renderer.domElement.getBoundingClientRect();
    const out = [];
    for (const el of document.querySelectorAll('.name-tag')) {
      const t = el.getBoundingClientRect();
      const car = [...s.cars.values()].find((c) => c.name === el.textContent);
      const st = car && s.drawnStates.get(car.id);
      const p = st && s.view.toScreen(st.x, 1, st.z);
      out.push({ name: el.textContent, you: Boolean(car?.you), above: p ? t.bottom - box.top < p.y : false });
    }
    return out;
  });
  const tags = await until(async () => { const t = await tagCheck(); return t.length ? t : null; }, { timeout: 60000 });
  r.check('driver names float over rivals, above each car, and not over your own', Boolean(tags) && tags.every((t) => t.above && !t.you),
    JSON.stringify(tags));
  await race.evaluate(() => window.nitro.settings.set('nameTags', 'off'));
  const tagsOff = await until(() => race.evaluate(() => document.querySelectorAll('.name-tag').length === 0 || null), { timeout: 5000 });
  r.check('and the setting turns them off mid-race', Boolean(tagsOff));

  // The winner home (#23): one celebration, fireworks and confetti over the line.
  await race.evaluate(() => {
    const v = window.nitro.session.view;
    const was = v.celebrate.bind(v);
    window.__cheers = [];
    v.celebrate = (x, z) => { const pops = was(x, z); window.__cheers.push(pops.length); return pops; };
  });
  await race.waitForSelector('#screen-results:not([hidden])', { timeout: 240000 });
  const cheers = await race.evaluate(() => window.__cheers);
  r.check('the winner crossing the line sets off one volley of fireworks', cheers.length === 1 && cheers[0] >= 5, JSON.stringify(cheers));
  const results = await race.evaluate(() => ({
    rows: document.querySelectorAll('#results-body tr').length,
    you: document.querySelectorAll('#results-body tr.you').length,
    title: document.getElementById('results-title').textContent,
    canvases: document.querySelectorAll('canvas.game-canvas').length,
    // The trophy (#12): in the Best lap column of the row with the fastest lap, and nowhere else.
    trophies: document.querySelectorAll('#results-body .fastest-lap').length,
    trophyAt: [...document.querySelectorAll('#results-body tr')].findIndex((tr) => tr.cells[3]?.querySelector('.fastest-lap')),
    bests: [...document.querySelectorAll('#results-body tr')].map((tr) => {
      const [m, sec] = (tr.cells[3]?.firstChild?.textContent ?? '').split(':');
      return sec === undefined ? Infinity : Number(m) * 60 + Number(sec);
    }),
  }));
  r.check('the race ends on a results table with the player marked', results.rows === 6 && results.you === 1 && /^You finished/.test(results.title) && results.canvases === 0,
    results.title);
  r.check('a trophy sits beside the fastest lap, and only there', results.trophies === 1 && results.bests[results.trophyAt] === Math.min(...results.bests),
    JSON.stringify({ at: results.trophyAt, bests: results.bests }));

  // Race again: the renderer is kept, and must hold what this race needs,
  // not that plus everything the last one left behind (the Xbox judder).
  await race.click('#btn-again');
  const again = await until(() => race.evaluate(() => {
    const s = window.nitro.session;
    return s && s.world.time > s.world.goTime + 3 ? true : null;
  }), { timeout: 60000 });
  const gpu2 = await gpu();
  r.check('a second race holds no more on the GPU than the first: the last race is freed', Boolean(again)
    && gpu2.geometries <= gpu1.geometries + 3 && gpu2.textures <= gpu1.textures + 1,
    `geometries ${gpu1.geometries} → ${gpu2.geometries}, textures ${gpu1.textures} → ${gpu2.textures}`);
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
    return p.wrecked === 0 && p.hp === 100 ? true : null;
  }), { timeout: 10000 });
  r.check('and is back on the road a few seconds later with full health', Boolean(back));
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

  /* ------------------------------------------------------- link preview */
  // What WhatsApp and friends read when a link is pasted: an absolute
  // og:image, and that picture really is in the repo at 1200x630 and small.
  {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const meta = (p) => html.match(new RegExp(`property="${p}" content="([^"]+)"`))?.[1];
    const img = meta('og:image') ?? '';
    const file = new URL('../' + img.replace('https://sheppio.github.io/nitro-carnage/', ''), import.meta.url);
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const jpg = bytes ? fs.readFileSync(file) : null;
    // A JPEG's size, from its first start-of-frame marker.
    let size = '';
    for (let i = 2; jpg && i < jpg.length - 9; ) {
      const m = jpg[i + 1], len = jpg.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xc2) { size = `${jpg.readUInt16BE(i + 7)}x${jpg.readUInt16BE(i + 5)}`; break; }
      i += 2 + len;
    }
    r.check('a pasted link previews: og:title, og:description and an absolute og:image, 1200x630 and under 300 KB',
      Boolean(meta('og:title') && meta('og:description')) && img.startsWith('https://') && size === '1200x630' && bytes < 300 * 1024,
      `${img} ${size} ${(bytes / 1024).toFixed(0)} KB`);
  }

  /* --------------------------------------------------- the daily link */
  // ?daily: today's Track of the Day as a hotlap, on the track screen with
  // Start focused, so one press (Enter, A, or a tap) drives it.
  {
    const dp = await browser.newPage({ viewport: { width: 800, height: 450 } });
    dp.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await dp.goto(`${url}?quality=potato&daily`);
    const landed = await until(() => dp.evaluate(() => (!document.getElementById('screen-track').hidden ? {
      mode: document.getElementById('track-mode').textContent,
      track: document.getElementById('menu-track').value,
      focus: document.activeElement?.id,
      go: document.getElementById('btn-track-go').textContent,
      seed: document.getElementById('menu-seed').value,
    } : null)));
    await dp.keyboard.press('Enter');
    const drove = await until(() => dp.evaluate(() => {
      const s = window.nitro.session;
      return s ? { mode: s.mode, id: s.world.track.def.id } : null;
    }), { timeout: 30000 });
    r.check('a ?daily link opens the Track of the Day as a hotlap, its date in the seed box, Start focused, and one press drives it',
      landed?.mode === 'Hotlap' && landed.track === 'day' && landed.seed === new Date().toISOString().slice(0, 10) && landed.focus === 'btn-track-go' && drove?.mode === 'hotlap' && /^seed-/.test(drove.id),
      `${JSON.stringify(landed)} -> ${JSON.stringify(drove)}`);
    await dp.close();
  }
  // ?daily=<date>: a past day's track races; a future day's is locked, with
  // no map and Start disabled, and typing it as a seed is locked the same.
  {
    const dayOf = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
    const dp = await browser.newPage({ viewport: { width: 800, height: 450 } });
    dp.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // The info for what the seed box holds now: waited for, not a fixed pause,
    // so a slow update is not read as the one before it.
    const state = (about = '') => until(() => dp.evaluate((a) => {
      const go = document.getElementById('btn-track-go');
      const info = document.getElementById('menu-track-info').textContent;
      return !document.getElementById('screen-track').hidden && info && info.includes(a) ? { info, disabled: go.disabled } : null;
    }, about));
    await dp.goto(`${url}?quality=potato&daily=${dayOf(1)}`);
    const tomorrow = await state();
    await dp.evaluate(() => { const s = document.getElementById('menu-seed'); s.value = 'green mile'; s.dispatchEvent(new Event('input')); });
    const word = await state('green mile');
    await dp.evaluate((d) => { const s = document.getElementById('menu-seed'); s.value = d; s.dispatchEvent(new Event('input')); }, dayOf(3));
    const typed = await state(dayOf(3));
    await dp.goto(`${url}?quality=potato&daily=${dayOf(-2)}`);
    const past = await state();
    await dp.keyboard.press('Enter');
    const drove = await until(() => dp.evaluate(() => window.nitro.session?.world.track.def.id ?? null), { timeout: 30000 });
    const want = await dp.evaluate(async (d) => {
      const main = document.querySelector('script[type="module"][src]').src;
      const g = await import(new URL('sim/track/generate.js', main).href);
      return g.generateTrack(g.daySeed(Date.parse(d))).id;
    }, dayOf(-2));
    r.check('?daily=<date> races a past day\'s Track of the Day; tomorrow\'s is locked (no map, Start disabled), typed or linked',
      /Locked/.test(tomorrow?.info) && tomorrow.disabled && word?.disabled === false && /Locked/.test(typed?.info) && typed.disabled
      && past?.info.includes(`Track of the day ${dayOf(-2)}`) && !past.disabled && drove === want,
      JSON.stringify([tomorrow, word, typed, past, drove, want]));
    await dp.close();
  }

  /* ---------------------------------------------------------------- zoom */
  // The mouse wheel zooms the race camera by changing the field-of-view setting;
  // it is kept, clamped, and the slider shows it.
  {
    const zp = await openPage('quality=potato&drive');
    await until(() => zp.evaluate(() => window.nitro.session?.world.time > 0.5), { timeout: 30000 });
    const fov0 = await zp.evaluate(() => window.nitro.session.view.rig.camera.fov);
    await zp.mouse.move(400, 225);
    for (let k = 0; k < 5; k++) await zp.mouse.wheel(0, 100);
    const wide = await until(() => zp.evaluate((f) => (window.nitro.session.view.rig.camera.fov > f + 8 ? window.nitro.settings.current.fov : null), fov0), { timeout: 5000 });
    for (let k = 0; k < 40; k++) await zp.mouse.wheel(0, -100);
    const tight = await until(() => zp.evaluate(() => (window.nitro.settings.current.fov === 35 ? window.nitro.session.view.rig.camera.fov : null)), { timeout: 5000 });
    r.check('the mouse wheel zooms the race camera out and in, down to the 35° limit', wide === 60 && tight !== null && tight < fov0,
      `rest ${fov0.toFixed(1)}°, wheel out → setting ${wide}, wheel in → camera ${tight?.toFixed(1)}°`);
    await zp.evaluate(() => window.nitro.settings.set('fov', 50));
    await zp.close();
  }

  /* -------------------------------------------------------------- garage */
  // A quick race's Car type (#17): Distinct puts no two cars in one body, Single all in yours.
  for (const [mode, want] of [['2', 'distinct'], ['1', 'single']]) {
    const ct = await openPage('quality=potato&bots=5');
    await ct.click('#btn-race');
    await ct.evaluate((m) => { const s = document.getElementById('menu-body'); s.value = m; s.dispatchEvent(new Event('change')); }, mode);
    await ct.click('#btn-track-go');
    await ct.waitForSelector('#screen-hud:not([hidden])');
    const cars = await ct.evaluate(() => [...window.nitro.session.cars.values()].map((c) => c.look.body));
    const own = await ct.evaluate(() => window.nitro.garage?.current.body ?? JSON.parse(localStorage.getItem('nitrocarnage.look') ?? 'null')?.body ?? null);
    r.check(`a quick race with the ${want} car type: ${want === 'distinct' ? 'no two cars alike' : 'every car in the player\'s body'}`,
      cars.length === 6 && (want === 'distinct' ? new Set(cars).size === 6 : new Set(cars).size === 1), `${cars.join()} (own ${own})`);
    await ct.close();
  }

  // Every body in every livery: built without error, inside the shared
  // collision footprint (4.4 m by 2.0 m, a few centimetres of bumper
  // allowed), within the triangle budget, and wearing its stripe.
  const gp = await openPage('quality=potato');
  await gp.click('#btn-race');
  await gp.click('#btn-garage');
  await gp.waitForSelector('#screen-garage:not([hidden])');
  // No dropdowns at all: arrows to click through (the race number too), colour squares to click on.
  const noSelects = await gp.evaluate(() => [...document.querySelectorAll('#screen-garage select:not(.stepped)')].map((s) => s.id).join());
  await gp.click('#garage-body .step:last-child');
  const clickedBody = await gp.evaluate(() => window.nitro.garage.current.body);
  await gp.click('#garage-stripe .swatch[title="Jade"]');
  const clickedStripe = await gp.evaluate(() => [window.nitro.garage.current.stripe, document.querySelectorAll('#garage-stripe .swatch.on').length]);
  r.check('the Garage picks by arrows and colour squares, the race number included; no dropdowns',
    noSelects === '' && clickedBody === 'hatch' && clickedStripe[0] === 'jade' && clickedStripe[1] === 1, `${noSelects}; › gave ${clickedBody}; square gave ${clickedStripe[0]}`);
  // A quick race's Garage picks the car's colour too; silver among them.
  const picked = await gp.evaluate(() => !document.getElementById('garage-colour-row').hidden);
  await gp.click('#garage-colour .swatch[title="Silver"]');
  const silver = await gp.evaluate(() => window.nitro.colour);
  r.check('offline, the Garage picks the car colour, silver included', picked && silver === 'silver', `${picked ? 'shown' : 'hidden'}, ${silver}`);
  const bodies = await gp.evaluate(async () => {
    const out = [];
    for (const body of ['coupe', 'hatch', 'muscle', 'wedge', 'buggy', 'tractor', 'forklift', 'f1']) {
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
  r.check('eight bodies (a tractor, a forklift and a Formula 1 car among them), six liveries each: all inside the shared footprint and under 600 triangles',
    bodies.length === 48 && outside.length === 0 && heavy.length === 0,
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
  r.check('the chosen look is kept for next time: after a reload it is the last one picked', kept.body === 'f1' && kept.pattern === 'roundel' && kept.stripe === 'jade',
    `${kept.body} / ${kept.pattern} / ${kept.stripe}`);
  // The main menu's Garage button (#1): drawn as your own car, and Done comes back to the menu.
  const menuCar = await gp.evaluate(() => document.querySelector('#btn-menu-garage .car-icon')?.dataset.body ?? null);
  await gp.click('#btn-menu-garage');
  await gp.waitForSelector('#screen-garage:not([hidden])');
  await gp.click('#btn-garage-back');
  const backOnMenu = await until(() => gp.evaluate(() => !document.getElementById('screen-menu').hidden || null), { timeout: 5000 });
  r.check('the main menu has a Garage button drawn as your car, and Done returns to the menu', menuCar === 'f1' && Boolean(backOnMenu), `icon ${menuCar}`);
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
  r.check('the browser generates the same track from a seed as Node does, to the byte', sameTrack === '9a8d4796', sameTrack);
  const label = await hl.evaluate(() => document.getElementById('hud-track').textContent);
  const shows = await hl.evaluate(() => ({ record: !document.getElementById('hud-record-row').hidden, pos: document.getElementById('hud-pos').parentElement.hidden, arms: getComputedStyle(document.getElementById('hud-arms')).display === 'none' }));
  r.check('a hotlap on the track of the day: named on the HUD, a record to beat, no position, no weapons',
    /^Track of the day \d{4}-\d{2}-\d{2} · /.test(label) && shows.record && shows.pos && shows.arms, label);
  // Built at the start, hidden: made at the end of the first lap, its shaders stalled the game (#4).
  const early = await hl.evaluate(() => {
    const g = window.nitro.session.view.scene.getObjectByName('ghost');
    return g ? { visible: g.visible, lap: window.nitro.session.player.lap.completed } : null;
  });
  r.check('the ghost is built, hidden, before the first lap is done', early && !early.visible && early.lap < 1, JSON.stringify(early));
  // Two laps on autopilot: the first sets the record, which is saved.
  const saved = await until(() => hl.evaluate(() => {
    const id = window.nitro.session.world.track.def.id;
    // best5 for a generated loop or long straights, or a real circuit (rounded in #20, #22), best2 for the rest;
    // .noturbo while the turbo is switched off (#19).
    const r = localStorage.getItem(`nitrocarnage.best5.${id}.noturbo`) ?? localStorage.getItem(`nitrocarnage.best2.${id}.noturbo`);
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

  // Damage from a lap is gone at the line (the turbo is off, #19, so its meter stays empty).
  // Read at the lap event itself: polled a moment later, the autopilot has
  // already started on the refilled turbo down the straight.
  await hl.evaluate(() => {
    const s = window.nitro.session;
    const p = s.player;
    p.hp = 40;
    p.car.turbo = 0;
    const pass = s.onEvent;
    s.onEvent = (ev) => {
      if (ev.kind === 'lap' && ev.id === s.playerId && !window.healed) window.healed = { hp: p.hp, turbo: p.car.turbo };
      pass?.(ev);
    };
  });
  const healed = await until(() => hl.evaluate(() => window.healed ?? null), { timeout: 150000, interval: 200 });
  r.check('in a hotlap every lap starts with full health, and no turbo', healed?.hp === 100 && healed.turbo === 0,
    `health ${healed?.hp}, turbo ${healed?.turbo.toFixed(2)} s after the line`);
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
    // Two of the real circuits (M9): a street circuit on the harbour, and the one with the most woods round it.
    monaco: ['towers', 'lamp-heads', 'water', 'props'],
    spa: ['tree-crowns', 'props', 'windmill-sails'],
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
  r.check('the built-in tracks and two real circuits boot from a link, with their scenery, inside 150 draw calls all the way round', tracksOk, trackNotes.join('; '));
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
  // The new voices: placed one-shots, missile whines, the ducking under a
  // blast, and the music's theme and build. Called directly: a race does not
  // promise a missile or a bump on cue.
  const extras = await snd.evaluate(async () => {
    const a = window.nitro.audio;
    const before = a.started;
    a.bump({ d: 4, pan: 0.7 }, 12);
    a.damage(20);
    for (const k of ['ammo', 'repair', 'turbo']) a.pickup(k);
    const oneShots = a.started - before;
    a.missiles([{ key: 'x:1', heard: { d: 10, pan: -0.5 }, closing: 40 }, { key: 'x:2', heard: { d: 20, pan: 0.5 }, closing: -40 }]);
    const flying = a.missileVoices;
    a.missiles([]);
    const landed = a.missileVoices;
    a.explosion({ d: 0, pan: 0 }, 1.5);
    await new Promise((res) => setTimeout(res, 80));
    const ducked = a.musicDuck;
    const theme = a.music.themeIndex;
    const themes = new Set(['downtown', 'greenbelt', 'docks', 'monza', 'monaco', 'suzuka'].map((id) => (a.music.setTheme(id), a.music.themeIndex)));
    return { oneShots, flying, landed, ducked, theme, themes: themes.size };
  });
  r.check('bumps, damage and every pickup make a sound; missiles whine while they fly and stop when they land; a blast ducks the music',
    extras.oneShots >= 8 && extras.flying === 2 && extras.landed === 0 && extras.ducked < 0.9, JSON.stringify(extras));
  r.check('tracks get music themes of their own', extras.theme >= 0 && extras.themes >= 3, JSON.stringify(extras));
  // The race ends inside a frame, and the menus after it are silent: the
  // frame used to carry on and voice fresh engines that nothing stopped.
  await snd.waitForSelector('#screen-results:not([hidden])', { timeout: 150000 });
  await snd.waitForTimeout(800);
  const after = await snd.evaluate(() => window.nitro.audio.engineVoices);
  r.check('when the race ends, the engines stop: none drone on under the results and menus', after === 0, `${after} engines`);
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

  /* ---------------------------------------------------------------- lobby */
  // Every control inside the lobby's card, as host with six cars and a seed:
  // in two 1fr columns "6 (fill with bots)" and the seed box ran off its edge.
  {
    const outside = [];
    for (const [w, h] of [[1022, 760], [760, 900], [400, 800]]) {
      const lp = await openPage('quality=potato', { width: w, height: h });
      await lp.click('#btn-create');
      await lp.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
      await lp.waitForFunction(() => window.nitro.room?.net.isHost);
      await lp.selectOption('#lobby-cars', '6');
      const inside = (screen) => lp.evaluate(([w, screen]) => {
        const card = document.querySelector(`#${screen} .menu-card`).getBoundingClientRect();
        return [...document.querySelectorAll(`#${screen} select, #${screen} input, #${screen} button`)]
          .filter((el) => el.offsetParent && (el.getBoundingClientRect().right > card.right || el.getBoundingClientRect().left < card.left))
          .map((el) => `${el.id} at ${w}px`);
      }, [w, screen]);
      outside.push(...(await inside('screen-lobby')));
      // The track and its seed are on their own screen.
      await lp.click('#btn-lobby-track');
      // Seeded, with the seed box, its dice and star (#18): the widest the chooser gets.
      await lp.selectOption('#lobby-track', 'seed');
      await lp.fill('#lobby-seed', 'EAR-DIN-EAT');
      outside.push(...(await inside('screen-lobby-track')));
      await lp.evaluate(() => window.nitro.room?.leave());
      await lp.close();
    }
    r.check('the lobby keeps every control inside its card, from phone to desktop', outside.length === 0, outside.join(', '));
  }

  r.check('no page errors or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  r.crashed(err);
} finally {
  await browser.close();
  server.close();
}
r.finish();
