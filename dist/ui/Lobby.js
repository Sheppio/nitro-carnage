import { colourOf, PALETTE } from '../sim/palette.js';
import { TRACKS } from '../sim/track/index.js';
import { daySeed, generateTrack } from '../sim/track/generate.js';
import { carIcon } from './carIcon.js';
const $ = (id) => document.getElementById(id);
/**
 * The room's staging area: who is here, in which colour, and — for the host —
 * how many cars and laps, and the Start button. Everyone else sees what the
 * host has chosen, because it rides on the heartbeat.
 */
export class Lobby {
    net;
    constructor(net, roomId) {
        this.net = net;
        $('lobby-code').textContent = roomId;
        const link = `${location.origin}${location.pathname}?room=${roomId}`;
        $('lobby-link').textContent = link;
        const colour = $('lobby-colour');
        colour.replaceChildren(...PALETTE.map((c) => {
            const o = document.createElement('option');
            o.value = c.id;
            o.textContent = c.name;
            return o;
        }));
    }
    /** Redraw from the room as it stands. */
    render() {
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
        const select = $('lobby-colour');
        for (const o of select.options) {
            const owner = Object.entries(colours).find(([pid, c]) => c === o.value && pid !== net.playerId);
            o.textContent = colourOf(o.value).name + (owner ? ' (taken)' : '');
        }
        if (select.value !== mine)
            select.value = mine;
        $('lobby-cars').value = String(net.state.cars);
        $('lobby-laps').value = String(net.state.laps);
        const st = net.state;
        const today = st.seed !== 0 && st.seed === daySeed(Date.now());
        const trackSel = $('lobby-track');
        // The host's own pick is left alone while they type a seed.
        if (!(net.isHost && trackSel.value === 'seed' && st.seed !== 0 && !today)) {
            trackSel.value = st.seed === 0 ? String(st.track) : today ? 'day' : 'seed';
        }
        $('lobby-weapons').value = String(st.arms);
        $('lobby-wait').hidden = net.isHost;
        const track = st.seed === 0 ? (TRACKS[st.track]?.name ?? '') : `${today ? 'Track of the day · ' : ''}${generateTrack(st.seed).name}`;
        $('lobby-wait').textContent = room.hostId
            ? `Next race: ${track}, ${net.state.laps} lap${net.state.laps === 1 ? '' : 's'}${st.arms ? '' : ', no weapons'}. Waiting for the host to start it.`
            : 'Looking for the room…';
    }
    row(name, colourId, badges, look) {
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
//# sourceMappingURL=Lobby.js.map