import { FEATURES } from '../config.js';
import { WIRE } from '../net/codec.js';
import type { NetRace } from '../net/NetRace.js';
import { isBotId } from '../sim/bots.js';
import { CUP_MAX, cupOn } from '../sim/championship.js';
import type { CupRace } from '../sim/championship.js';
import { PALETTE } from '../sim/palette.js';
import { TRACKS } from '../sim/track/index.js';
import { daySeed, generateTrack, utcDay } from '../sim/track/generate.js';
import { BODIES, BODY_NAMES } from '../sim/look.js';
import type { CarLook } from '../sim/look.js';
import type { Tally } from '../sim/raceLog.js';
import { carIcon } from './carIcon.js';
import { drawTrackPreview } from './trackPreview.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Draws a car for the roster: the real one where the page can render it, the plan-view icon otherwise. */
export type Portrait = (look: CarLook, colourId: string) => HTMLCanvasElement;

/**
 * The room's staging area: who is here, in which car, and — for the host —
 * how many cars and laps, and the Start button. Everyone else sees what the
 * host has chosen, because it rides on the heartbeat. The host's track and
 * championship have a screen of their own (`screen-lobby-track`); your colour
 * is picked in the Garage.
 */
export class Lobby {
  constructor(private net: NetRace, roomId: string, private tally: Tally | null = null, private portrait: Portrait = (l, c) => carIcon(l, c)) {
    $('lobby-code').textContent = roomId;
    const link = `${location.origin}${location.pathname}?room=${roomId}`;
    $('lobby-link').textContent = link;
  }

  /** The track the preview last drew, so a redraw only happens when it changes. */
  private drawn = '';
  /** Why the host's typed seed can't be used: a future day's Track of the Day. */
  private locked: string | null = null;
  /** Generated tracks' names by seed: generating one takes a moment, and the lobby redraws twice a second. */
  private names = new Map<number, string>();
  /** What the championship list last drew. */
  private cupDrawn = '';

  /** The host typed a future date (or stopped doing so): shown in place of the map. */
  lock(why: string | null): void {
    if (why === this.locked) return;
    this.locked = why;
    this.drawn = '';
    this.render();
  }

  /** Redraw from the room as it stands. */
  render(): void {
    const net = this.net;
    const room = net.room;
    document.body.classList.toggle('is-host', net.isHost);

    const ids = room.aliveIds;
    const colours = room.resolvedColours();
    const list = $('lobby-roster');
    list.replaceChildren();
    // A player on another wire protocol can't race with this one: their cars,
    // shots and bots would not show. Say who, and who should reload.
    let older = 0, newer = 0;
    // Tonight's points beside each name, once there has been a race: the lobby between races is where the score is argued over.
    this.tally?.sync(net.state.score, (id) => net.carInfo(id).name, isBotId);
    const standings = this.tally?.standings() ?? [];
    const score = (id: string): string => {
      const i = standings.findIndex((r) => r.id === id);
      if (i < 0) return '';
      const r = standings[i]!;
      return `${i === 0 && r.points > 0 ? '👑 ' : ''}${r.points} PTS${r.wins ? ` · ${r.wins} WIN${r.wins === 1 ? '' : 'S'}` : ''}`;
    };
    for (const id of ids) {
      const info = net.carInfo(id);
      const wire = id === net.playerId ? WIRE : (room.peers.get(id)?.wire ?? WIRE);
      if (wire < WIRE) older++;
      if (wire > WIRE) newer++;
      // How this client reaches their car: straight there, or through the
      // broker (slower). Shown so nobody wonders why one rival looks jumpier.
      const link = id === net.playerId ? null : net.links?.(id).link;
      list.appendChild(this.row(info.name, colours[id] ?? info.colour, [
        id === room.hostId ? 'HOST' : '', id === net.playerId ? 'YOU' : '',
        wire < WIRE ? 'OLD BUILD' : wire > WIRE ? 'NEWER BUILD' : '',
        link === 'direct' ? 'DIRECT' : link === 'broker' ? 'VIA BROKER' : '', score(id),
      ], info.look));
    }
    const builds = $('lobby-builds');
    builds.hidden = older + newer === 0;
    builds.textContent = newer
      ? 'Someone here is on a newer build. Reload this page to race with them.'
      : `${older === 1 ? 'A player here is' : 'Some players here are'} on an older build and must reload the page to race with you.`;
    // Bots that will fill the grid, shown faintly so nobody is surprised by them.
    const bots = Math.max(0, net.state.cars - ids.length);
    const taken = new Set(Object.values(colours));
    const free = PALETTE.map((c) => c.id).filter((c) => !taken.has(c));
    for (let b = 0; b < bots; b++) {
      const id = `b${ids.length + b}`;
      const li = this.row(net.carInfo(id).name, free[b % free.length] ?? 'black', ['BOT', score(id)], net.carInfo(id).look);
      li.classList.add('bot');
      list.appendChild(li);
    }

    $<HTMLSelectElement>('lobby-cars').value = String(net.state.cars);
    $<HTMLSelectElement>('lobby-laps').value = String(net.state.laps);
    const st = net.state;
    const today = st.seed !== 0 && st.seed === daySeed(Date.now());
    const trackSel = $<HTMLSelectElement>('lobby-track');
    // The host's own pick is left alone while they type a seed.
    if (!(net.isHost && trackSel.value === 'seed' && st.seed !== 0 && !today)) {
      trackSel.value = st.seed === 0 ? String(st.track) : today ? 'day' : 'seed';
    }
    // The day's seed is its date: the seed box says so.
    const seedBox = $<HTMLInputElement>('lobby-seed');
    if (today && document.activeElement !== seedBox) seedBox.value = utcDay(Date.now());
    $<HTMLSelectElement>('lobby-weapons').value = String(st.arms);
    $<HTMLSelectElement>('lobby-pickups').value = String(st.pick);
    $<HTMLSelectElement>('lobby-turbo').value = String(st.boost);
    $<HTMLSelectElement>('lobby-body').value = String(st.body);
    $('lobby-wait').hidden = net.isHost;
    this.renderCup();
    const track = st.seed === 0 ? (TRACKS[st.track]?.name ?? '') : `${today ? `Track of the day ${utcDay(Date.now())} · ` : ''}${generateTrack(st.seed).name}`;
    // A map of the room's track, for everyone: a seed is only a word until it's seen.
    // The track screen's own map shows a locked day while the host types it;
    // the lobby's card keeps the track the room will actually race.
    const key = this.locked && net.isHost ? 'locked' : `${st.track}:${st.seed}`;
    if (key === 'locked' && key !== this.drawn) {
      this.drawn = key;
      const canvas = $<HTMLCanvasElement>('lobby-track-map');
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      $('lobby-track-info').replaceChildren(Object.assign(document.createElement('b'), { textContent: '🔒 Locked' }), document.createElement('br'), this.locked!);
    } else if (key !== this.drawn) {
      this.drawn = key;
      drawTrackPreview($<HTMLCanvasElement>('lobby-track-map'), $('lobby-track-info'), this.def(), track);
    }
    this.renderCard(track);
    const on = cupOn(st);
    $('lobby-wait').textContent = room.hostId
      ? `${on ? `Championship race ${st.race + 1} of ${st.cup.length}` : 'Next race'}: ${track}, ${net.state.laps} lap${net.state.laps === 1 ? '' : 's'}${st.arms ? '' : ', no weapons'}${st.pick ? '' : ', no power-ups'}${st.boost || !FEATURES.turbo ? '' : ', no turbo'}${BODIES[st.body - 1] ? `, everyone in a ${BODY_NAMES[BODIES[st.body - 1]!]}` : ''}. Waiting for the host to start it.`
      : 'Looking for the room…';
  }

  /**
   * The championship's tracks, the next one lit. The host plans them (a chip
   * is its ✕) until the first race; then the room's track follows the list.
   */
  private renderCup(): void {
    const net = this.net;
    const st = net.state;
    const on = cupOn(st);
    const plan = net.isHost && !on;
    $('lobby-cup').hidden = !net.isHost && st.cup.length === 0;
    $('btn-cup-add').hidden = on;
    $<HTMLButtonElement>('btn-cup-add').disabled = st.cup.length >= CUP_MAX || this.locked !== null;
    $('btn-cup-end').hidden = !on;
    // The track is the championship's while it runs.
    for (const id of ['lobby-track', 'lobby-seed', 'lobby-seed-random']) $<HTMLInputElement>(id).disabled = on;
    $('btn-start-race').textContent = on ? `Start race ${st.race + 1} of ${st.cup.length}` : st.cup.length ? `Start championship · ${st.cup.length} race${st.cup.length === 1 ? '' : 's'}` : 'Start race';

    // Rebuilt only when it changes: a pad's focus on a chip would not survive every heartbeat.
    const key = `${plan}:${st.race}:${st.cup.map((c) => `${c.track}/${c.seed}`).join()}`;
    if (key === this.cupDrawn) return;
    this.cupDrawn = key;
    const list = $('lobby-cup-list');
    list.replaceChildren();
    if (!st.cup.length) {
      list.appendChild(Object.assign(document.createElement('li'), { className: 'empty', textContent: net.isHost ? 'Off · + adds this track' : 'Off' }));
      return;
    }
    st.cup.forEach((c, i) => {
      const chip = document.createElement(plan ? 'button' : 'span');
      chip.className = `cup-chip${on && i < st.race ? ' done' : ''}${on && i === st.race ? ' next' : ''}`;
      chip.textContent = this.cupName(c);
      if (chip instanceof HTMLButtonElement) {
        chip.type = 'button';
        chip.title = `Take ${chip.textContent} out`;
        chip.addEventListener('click', () => net.planCup(st.cup.filter((_, k) => k !== i)));
      }
      const li = document.createElement('li');
      li.appendChild(chip);
      list.appendChild(li);
    });
    // The next race in view, however far along the line it is.
    list.querySelector<HTMLElement>('.next')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** What the room's track is. */
  private def(): ReturnType<typeof generateTrack> {
    const st = this.net.state;
    return st.seed === 0 ? TRACKS[st.track] ?? TRACKS[0]! : generateTrack(st.seed);
  }

  /** What the lobby's card said last. */
  private cardDrawn = '';

  /**
   * The lobby's track card: the room's map, its name, and where the
   * championship is. The host's is the button to the track screen; everyone
   * else's is only a picture.
   */
  private renderCard(track: string): void {
    const st = this.net.state;
    const on = cupOn(st);
    const cup = on ? `Championship · race ${st.race + 1} of ${st.cup.length}` : st.cup.length ? `Championship · ${st.cup.length} race${st.cup.length === 1 ? '' : 's'} planned` : '';
    const key = `${st.track}:${st.seed}:${cup}`;
    if (key === this.cardDrawn) return;
    this.cardDrawn = key;
    for (const [map, info] of [['lobby-card-map', 'lobby-card-info'], ['lobby-guest-map', 'lobby-guest-info']] as const) {
      drawTrackPreview($<HTMLCanvasElement>(map), $(info), this.def(), track);
      if (cup) $(info).append(document.createElement('br'), Object.assign(document.createElement('b'), { textContent: cup }));
    }
  }

  /** Colours other people in the room have: marked in the Garage, where yours is picked. */
  takenColours(): Set<string> {
    const colours = this.net.room.resolvedColours();
    return new Set(Object.entries(colours).filter(([pid]) => pid !== this.net.playerId).map(([, c]) => c));
  }

  private cupName(c: CupRace): string {
    if (!c.seed) return TRACKS[c.track]?.name ?? '—';
    let name = this.names.get(c.seed);
    if (name === undefined) {
      name = generateTrack(c.seed).name;
      this.names.set(c.seed, name);
    }
    return name;
  }

  private row(name: string, colourId: string, badges: string[], look: CarLook): HTMLLIElement {
    const li = document.createElement('li');
    // The car itself, in its colour and livery, and in the body it will race:
    // the room's Car type, when the host has locked everyone into one.
    const forced = BODIES[this.net.state.body - 1];
    const car = forced ? { ...look, body: forced } : look;
    const icon = this.portrait(car, colourId);
    icon.classList.add('car-portrait');
    const n = document.createElement('span');
    n.className = 'name';
    n.append(name, Object.assign(document.createElement('small'), { textContent: BODY_NAMES[car.body] }));
    li.append(icon, n);
    for (const b of badges.filter(Boolean)) {
      const tag = document.createElement('span');
      tag.className = `badge${b === 'HOST' ? ' host' : b.endsWith('BUILD') ? ' warn' : b.includes('PTS') ? ' score' : b === 'DIRECT' ? ' direct' : ''}`;
      tag.textContent = b;
      li.appendChild(tag);
    }
    return li;
  }
}
