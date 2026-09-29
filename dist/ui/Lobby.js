import { WIRE } from '../net/codec.js';
import { PALETTE } from '../sim/palette.js';
import { TRACKS } from '../sim/track/index.js';
import { daySeed, generateTrack, utcDay } from '../sim/track/generate.js';
import { BODIES, BODY_NAMES } from '../sim/look.js';
import { carIcon } from './carIcon.js';
import { Picker } from './Picker.js';
import { drawTrackPreview } from './trackPreview.js';
const $ = (id) => document.getElementById(id);
/**
 * The room's staging area: who is here, in which colour, and — for the host —
 * how many cars and laps, and the Start button. Everyone else sees what the
 * host has chosen, because it rides on the heartbeat.
 */
export class Lobby {
    net;
    tally;
    constructor(net, roomId, tally = null) {
        this.net = net;
        this.tally = tally;
        $('lobby-code').textContent = roomId;
        const link = `${location.origin}${location.pathname}?room=${roomId}`;
        $('lobby-link').textContent = link;
        // Colour squares, not a dropdown: a colour is better seen than read.
        this.colour = new Picker($('lobby-colour'), PALETTE.map((c) => ({ value: c.id, label: c.name, swatch: c.cssColour })));
    }
    colour;
    /** The track the preview last drew, so a redraw only happens when it changes. */
    drawn = '';
    /** Why the host's typed seed can't be used: a future day's Track of the Day. */
    locked = null;
    /** The host typed a future date (or stopped doing so): shown in place of the map. */
    lock(why) {
        if (why === this.locked)
            return;
        this.locked = why;
        this.drawn = '';
        this.render();
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
        // A player on another wire protocol can't race with this one: their cars,
        // shots and bots would not show. Say who, and who should reload.
        let older = 0, newer = 0;
        // Tonight's points beside each name, once there has been a race: the lobby between races is where the score is argued over.
        const standings = this.tally?.standings() ?? [];
        const score = (id) => {
            const i = standings.findIndex((r) => r.id === id);
            if (i < 0)
                return '';
            const r = standings[i];
            return `${i === 0 && r.points > 0 ? '👑 ' : ''}${r.points} PTS${r.wins ? ` · ${r.wins} WIN${r.wins === 1 ? '' : 'S'}` : ''}`;
        };
        for (const id of ids) {
            const info = net.carInfo(id);
            const wire = id === net.playerId ? WIRE : (room.peers.get(id)?.wire ?? WIRE);
            if (wire < WIRE)
                older++;
            if (wire > WIRE)
                newer++;
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
        // Colour picker: the colour you actually have (a clash may have moved
        // you off the one you asked for), with other people's marked.
        const mine = colours[net.playerId] ?? room.claimedColour;
        this.colour.mark(new Set(Object.entries(colours).filter(([pid]) => pid !== net.playerId).map(([, c]) => c)), 'taken');
        if (this.colour.value !== mine)
            this.colour.value = mine;
        $('lobby-cars').value = String(net.state.cars);
        $('lobby-laps').value = String(net.state.laps);
        const st = net.state;
        const today = st.seed !== 0 && st.seed === daySeed(Date.now());
        const trackSel = $('lobby-track');
        // The host's own pick is left alone while they type a seed.
        if (!(net.isHost && trackSel.value === 'seed' && st.seed !== 0 && !today)) {
            trackSel.value = st.seed === 0 ? String(st.track) : today ? 'day' : 'seed';
        }
        // The day's seed is its date: the seed box says so.
        const seedBox = $('lobby-seed');
        if (today && document.activeElement !== seedBox)
            seedBox.value = utcDay(Date.now());
        $('lobby-weapons').value = String(st.arms);
        $('lobby-pickups').value = String(st.pick);
        $('lobby-turbo').value = String(st.boost);
        $('lobby-body').value = String(st.body);
        $('lobby-wait').hidden = net.isHost;
        const track = st.seed === 0 ? (TRACKS[st.track]?.name ?? '') : `${today ? `Track of the day ${utcDay(Date.now())} · ` : ''}${generateTrack(st.seed).name}`;
        // A map of the room's track, for everyone: a seed is only a word until it's seen.
        const key = this.locked && net.isHost ? 'locked' : `${st.track}:${st.seed}`;
        if (key === 'locked' && key !== this.drawn) {
            this.drawn = key;
            const canvas = $('lobby-track-map');
            canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
            $('lobby-track-info').replaceChildren(Object.assign(document.createElement('b'), { textContent: '🔒 Locked' }), document.createElement('br'), this.locked);
        }
        else if (key !== this.drawn) {
            this.drawn = key;
            const def = st.seed === 0 ? TRACKS[st.track] ?? TRACKS[0] : generateTrack(st.seed);
            drawTrackPreview($('lobby-track-map'), $('lobby-track-info'), def, track);
        }
        $('lobby-wait').textContent = room.hostId
            ? `Next race: ${track}, ${net.state.laps} lap${net.state.laps === 1 ? '' : 's'}${st.arms ? '' : ', no weapons'}${st.pick ? '' : ', no power-ups'}${st.boost ? '' : ', no turbo'}${BODIES[st.body - 1] ? `, everyone in a ${BODY_NAMES[BODIES[st.body - 1]]}` : ''}. Waiting for the host to start it.`
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
            tag.className = `badge${b === 'HOST' ? ' host' : b.endsWith('BUILD') ? ' warn' : b.includes('PTS') ? ' score' : b === 'DIRECT' ? ' direct' : ''}`;
            tag.textContent = b;
            li.appendChild(tag);
        }
        return li;
    }
}
//# sourceMappingURL=Lobby.js.map