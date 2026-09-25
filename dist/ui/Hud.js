import { SIM } from '../config.js';
import { Minimap } from './Minimap.js';
import { NameTags } from './NameTags.js';
import { RivalArrows } from './RivalArrows.js';
const $ = (id) => document.getElementById(id);
/** m:ss.cc */
export function formatTime(t) {
    if (t === null || !Number.isFinite(t))
        return '—';
    const neg = t < 0;
    const a = Math.abs(t);
    const m = Math.floor(a / 60);
    const s = a - m * 60;
    return `${neg ? '-' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
}
export function ordinal(n) {
    const s = ['TH', 'ST', 'ND', 'RD'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
/**
 * The race HUD: position, lap and times, the countdown, banners, minimap and
 * rival arrows, plus the results table. Reads snapshots; owns no game state.
 */
export class Hud {
    session;
    minimap;
    arrows;
    names;
    textAt = 0;
    bannerUntil = 0;
    bannerText = '';
    bannerWarn = false;
    constructor(session, debug) {
        this.session = session;
        this.minimap = new Minimap($('hud-minimap'), session.world.track);
        this.arrows = new RivalArrows($('hud-arrows'));
        this.names = new NameTags($('hud-names'));
        const hotlap = session.mode === 'hotlap';
        $('hud-race').hidden = false;
        $('hud-minimap').hidden = false;
        // A hotlap is you against the clock: no position, and a record to beat.
        $('hud-pos').parentElement.hidden = hotlap;
        $('hud-record-row').hidden = !hotlap;
        $('hud-debug').hidden = !debug;
        this.banner('', 0);
    }
    update(hud) {
        const now = performance.now();
        $('hud-turbo').style.transform = `scaleX(${Math.max(0, hud.turbo / SIM.car.turboCapacity)})`;
        const hp = $('hud-hp');
        hp.style.transform = `scaleX(${Math.max(0, hud.hp / SIM.weapons.health)})`;
        hp.classList.toggle('low', hud.hp < 50 && hud.hp >= 25);
        hp.classList.toggle('critical', hud.hp < 25);
        $('hud-arms').hidden = hud.spectating;
        // Countdown: 3, 2, 1, GO — GO lingers for a second after the lights.
        const cd = $('hud-countdown');
        const racing = hud.mode !== 'hotlap';
        $('hud-arms').hidden = !hud.weapons;
        if (racing && hud.countdown > 0) {
            cd.textContent = String(Math.ceil(hud.countdown));
            cd.classList.remove('go');
        }
        else if (racing && hud.raceTime < 1 && hud.raceTime > -0.5) {
            cd.textContent = 'GO';
            cd.classList.add('go');
        }
        else {
            cd.textContent = '';
        }
        const bannerEl = $('hud-banner');
        if (hud.wrongWay) {
            bannerEl.textContent = 'WRONG WAY';
            bannerEl.classList.add('warn');
        }
        else if (hud.spectating) {
            bannerEl.textContent = 'SPECTATING · YOU RACE NEXT';
            bannerEl.classList.remove('warn');
        }
        else if (now < this.bannerUntil) {
            bannerEl.textContent = this.bannerText;
            bannerEl.classList.toggle('warn', this.bannerWarn);
        }
        else if (hud.wrecked) {
            bannerEl.textContent = 'WRECKED';
            bannerEl.classList.add('warn');
        }
        else {
            bannerEl.textContent = '';
        }
        // Cars: minimap every frame (it is cheap), arrows every frame (they move).
        const s = this.session;
        const cars = [];
        const screen = [];
        const tags = [];
        const show = s.settings.current.nameTags;
        for (const [id, st] of s.drawnStates) {
            const info = s.cars.get(id);
            if (!info)
                continue;
            cars.push({ id, x: st.x, z: st.z, css: info.css, you: info.you });
            if (!info.you) {
                const p = s.view.toScreen(st.x, 1, st.z);
                screen.push({ id, css: info.css, ...p });
            }
            if (show === 'all' || (show === 'rivals' && !info.you))
                tags.push({ id, name: info.name, css: info.css, ...s.view.overCar(st.x, st.z) });
        }
        this.minimap.draw(cars);
        // The live split: green when up on the record, red when down.
        const split = $('hud-split');
        if (hud.split) {
            split.textContent = `${hud.split.delta <= 0 ? '−' : '+'}${Math.abs(hud.split.delta).toFixed(2)}`;
            split.className = `hud-split ${hud.split.delta <= 0 ? 'up' : 'down'}`;
        }
        else {
            split.textContent = '';
        }
        const rect = s.view.renderer.domElement.getBoundingClientRect();
        this.arrows.update(screen, rect.width, rect.height);
        this.names.update(tags);
        // Text at 10 Hz: nobody reads faster, and the DOM is not free.
        if (now - this.textAt < 100)
            return;
        this.textAt = now;
        $('hud-speed').textContent = String(Math.round(hud.speedKmh));
        $('hud-auto').hidden = !hud.autopilot;
        for (const k of ['front', 'rear', 'mines']) {
            const el = $(`hud-ammo-${k}`);
            el.textContent = String(hud.ammo[k]);
            el.classList.toggle('empty', hud.ammo[k] === 0);
        }
        if (racing) {
            $('hud-pos').textContent = String(hud.position);
            $('hud-of').textContent = `/${hud.of}`;
            $('hud-lap').textContent = String(hud.lap);
            $('hud-laps').textContent = `/${hud.laps}`;
            $('hud-time').textContent = formatTime(Math.max(0, hud.raceTime));
        }
        else {
            $('hud-lap').textContent = String(hud.lap);
            $('hud-laps').textContent = '';
            $('hud-time').textContent = formatTime(hud.lapTime);
            $('hud-record').textContent = formatTime(hud.record);
        }
        $('hud-last').textContent = formatTime(hud.lastLap);
        $('hud-best').textContent = formatTime(hud.bestLap);
        $('hud-debug').textContent = `${hud.fps.toFixed(0)} fps\n${hud.drawCalls} draws`;
    }
    /** React to a race event: lap banners, the final lap, the finish. */
    event(ev) {
        const w = this.session.world;
        const me = this.session.playerId;
        if (ev.kind === 'lap' && ev.id === me && this.session.mode === 'hotlap') {
            this.banner(`LAP ${ev.lap}  ·  ${formatTime(ev.lapTime)}`, 2.2);
        }
        else if (ev.kind === 'lap' && ev.id === me) {
            const next = ev.lap + 1;
            if (next === w.laps)
                this.banner('FINAL LAP', 2.2);
            else if (next < w.laps)
                this.banner(`LAP ${next}  ·  ${formatTime(ev.lapTime)}`, 2.2);
        }
        else if (ev.kind === 'finish' && ev.id === me) {
            const pos = this.session.results().findIndex((r) => r.car.you) + 1;
            this.banner(`FINISHED ${ordinal(pos)}`, 8);
        }
        else if (ev.kind === 'finish') {
            const info = this.session.cars.get(ev.id);
            const done = w.entrants.filter((e) => e.lap.finished).length;
            if (info && done === 1)
                this.banner(`${info.name} WINS`, 2.5);
        }
        else if (ev.kind === 'respawn' && ev.id === me) {
            this.banner('BACK ON TRACK', 1.5, true);
        }
        else if (ev.kind === 'wreck' && ev.by === me && ev.id !== me) {
            this.banner(`YOU WRECKED ${this.session.cars.get(ev.id)?.name ?? 'A RIVAL'}`, 2.2);
        }
        else if (ev.kind === 'wreck' && ev.id === me && ev.by) {
            this.banner(`WRECKED BY ${this.session.cars.get(ev.by)?.name ?? 'A RIVAL'}`, 2.5, true);
        }
    }
    banner(text, seconds, warn = false) {
        this.bannerText = text;
        this.bannerWarn = warn;
        this.bannerUntil = performance.now() + seconds * 1000;
    }
    /** Fill the results table. */
    static results(rows) {
        const winner = rows[0]?.time ?? null;
        const body = $('results-body');
        body.innerHTML = '';
        for (const r of rows) {
            const tr = document.createElement('tr');
            if (r.car.you)
                tr.className = 'you';
            const gap = r.time === null ? `${r.laps} lap${r.laps === 1 ? '' : 's'}` : r.position === 1 || winner === null ? formatTime(r.time) : `+${(r.time - winner).toFixed(2)}`;
            const cells = [ordinal(r.position), r.car.name, gap, formatTime(r.best)];
            cells.forEach((text, i) => {
                const td = document.createElement('td');
                if (i === 1) {
                    const sw = document.createElement('span');
                    sw.className = 'swatch';
                    sw.style.background = r.car.css;
                    td.appendChild(sw);
                }
                td.appendChild(document.createTextNode(text));
                tr.appendChild(td);
            });
            body.appendChild(tr);
        }
        const you = rows.find((r) => r.car.you);
        $('results-title').textContent = you ? `You finished ${ordinal(you.position).toLowerCase()}` : 'Results';
    }
    dispose() {
        this.arrows.clear();
        this.names.clear();
    }
}
//# sourceMappingURL=Hud.js.map