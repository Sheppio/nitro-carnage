import type { NetRace } from '../net/NetRace.js';
import { colourOf, PALETTE } from '../sim/palette.js';
import { TRACKS } from '../sim/track/index.js';

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
    const colour = $<HTMLSelectElement>('lobby-colour');
    colour.replaceChildren(
      ...PALETTE.map((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        return o;
      }),
    );
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
      ]));
    }
    // Bots that will fill the grid, shown faintly so nobody is surprised by them.
    const bots = Math.max(0, net.state.cars - ids.length);
    const taken = new Set(Object.values(colours));
    const free = PALETTE.map((c) => c.id).filter((c) => !taken.has(c));
    for (let b = 0; b < bots; b++) {
      const li = this.row(`BOT ${b + 1}`, free[b % free.length] ?? 'black', ['BOT']);
      li.classList.add('bot');
      list.appendChild(li);
    }

    // Colour picker: the colour you actually have (a clash may have moved
    // you off the one you asked for), with other people's marked.
    const mine = colours[net.playerId] ?? room.claimedColour;
    const select = $<HTMLSelectElement>('lobby-colour');
    for (const o of select.options) {
      const owner = Object.entries(colours).find(([pid, c]) => c === o.value && pid !== net.playerId);
      o.textContent = colourOf(o.value).name + (owner ? ' (taken)' : '');
    }
    if (select.value !== mine) select.value = mine;

    $<HTMLSelectElement>('lobby-cars').value = String(net.state.cars);
    $<HTMLSelectElement>('lobby-laps').value = String(net.state.laps);
    $<HTMLSelectElement>('lobby-track').value = String(net.state.track);
    $('lobby-wait').hidden = net.isHost;
    const track = TRACKS[net.state.track]?.name ?? '';
    $('lobby-wait').textContent = room.hostId
      ? `Next race: ${track}, ${net.state.laps} lap${net.state.laps === 1 ? '' : 's'}. Waiting for the host to start it.`
      : 'Looking for the room…';
  }

  private row(name: string, colourId: string, badges: string[]): HTMLLIElement {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = colourOf(colourId).cssColour;
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    li.append(sw, n);
    for (const b of badges.filter(Boolean)) {
      const tag = document.createElement('span');
      tag.className = `badge${b === 'HOST' ? ' host' : ''}`;
      tag.textContent = b;
      li.appendChild(tag);
    }
    return li;
  }
}
