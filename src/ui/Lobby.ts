import type { NetRace } from '../net/NetRace.js';
import { PALETTE } from '../sim/palette.js';
import { TRACKS } from '../sim/track/index.js';
import { daySeed, generateTrack, utcDay } from '../sim/track/generate.js';
import type { CarLook } from '../sim/look.js';
import { carIcon } from './carIcon.js';
import { Picker } from './Picker.js';
import { drawTrackPreview } from './trackPreview.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * The room's staging area: who is here, in which colour, and — for the host —
 * how many cars and laps, and the Start button. Everyone else sees what the
 * host has chosen, because it rides on the heartbeat.
 */
export class Lobby {
  constructor(private net: NetRace, roomId: string) {
    $('lobby-code').textContent = roomId;
    const link = `${location.origin}${location.pathname}?room=${roomId}`;
    $('lobby-link').textContent = link;
    // Colour squares, not a dropdown: a colour is better seen than read.
    this.colour = new Picker($('lobby-colour'), PALETTE.map((c) => ({ value: c.id, label: c.name, swatch: c.cssColour })));
  }

  private readonly colour: Picker;
  /** The track the preview last drew, so a redraw only happens when it changes. */
  private drawn = '';
  /** Why the host's typed seed can't be used: a future day's Track of the Day. */
  private locked: string | null = null;

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
    for (const id of ids) {
      const info = net.carInfo(id);
      list.appendChild(this.row(info.name, colours[id] ?? info.colour, [
        id === room.hostId ? 'HOST' : '', id === net.playerId ? 'YOU' : '',
      ], info.look));
    }
    // Bots that will fill the grid, shown faintly so nobody is surprised by them.
    const bots = Math.max(0, net.state.cars - ids.length);
    const taken = new Set(Object.values(colours));
    const free = PALETTE.map((c) => c.id).filter((c) => !taken.has(c));
    for (let b = 0; b < bots; b++) {
      const li = this.row(net.carInfo(`b${ids.length + b}`).name, free[b % free.length] ?? 'black', ['BOT'], net.carInfo(`b${ids.length + b}`).look);
      li.classList.add('bot');
      list.appendChild(li);
    }

    // Colour picker: the colour you actually have (a clash may have moved
    // you off the one you asked for), with other people's marked.
    const mine = colours[net.playerId] ?? room.claimedColour;
    this.colour.mark(new Set(Object.entries(colours).filter(([pid]) => pid !== net.playerId).map(([, c]) => c)), 'taken');
    if (this.colour.value !== mine) this.colour.value = mine;

    $<HTMLSelectElement>('lobby-cars').value = String(net.state.cars);
    $<HTMLSelectElement>('lobby-laps').value = String(net.state.laps);
    const st = net.state;
    const today = st.seed !== 0 && st.seed === daySeed(Date.now());
    const trackSel = $<HTMLSelectElement>('lobby-track');
    // The host's own pick is left alone while they type a seed.
    if (!(net.isHost && trackSel.value === 'seed' && st.seed !== 0 && !today)) {
      trackSel.value = st.seed === 0 ? String(st.track) : today ? 'day' : 'seed';
    }
    $<HTMLSelectElement>('lobby-weapons').value = String(st.arms);
    $('lobby-wait').hidden = net.isHost;
    const track = st.seed === 0 ? (TRACKS[st.track]?.name ?? '') : `${today ? `Track of the day ${utcDay(Date.now())} · ` : ''}${generateTrack(st.seed).name}`;
    // A map of the room's track, for everyone: a seed is only a word until it's seen.
    const key = this.locked && net.isHost ? 'locked' : `${st.track}:${st.seed}`;
    if (key === 'locked' && key !== this.drawn) {
      this.drawn = key;
      const canvas = $<HTMLCanvasElement>('lobby-track-map');
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      $('lobby-track-info').replaceChildren(Object.assign(document.createElement('b'), { textContent: '🔒 Locked' }), document.createElement('br'), this.locked!);
    } else if (key !== this.drawn) {
      this.drawn = key;
      const def = st.seed === 0 ? TRACKS[st.track] ?? TRACKS[0]! : generateTrack(st.seed);
      drawTrackPreview($<HTMLCanvasElement>('lobby-track-map'), $('lobby-track-info'), def, track);
    }
    $('lobby-wait').textContent = room.hostId
      ? `Next race: ${track}, ${net.state.laps} lap${net.state.laps === 1 ? '' : 's'}${st.arms ? '' : ', no weapons'}. Waiting for the host to start it.`
      : 'Looking for the room…';
  }

  private row(name: string, colourId: string, badges: string[], look: CarLook): HTMLLIElement {
    const li = document.createElement('li');
    // The car itself, in its colour and livery, rather than a plain swatch.
    const icon = carIcon(look, colourId);
    icon.classList.add('swatch-car');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    li.append(icon, n);
    for (const b of badges.filter(Boolean)) {
      const tag = document.createElement('span');
      tag.className = `badge${b === 'HOST' ? ' host' : ''}`;
      tag.textContent = b;
      li.appendChild(tag);
    }
    return li;
  }
}
