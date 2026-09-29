import { GAME_NAME, SLUG } from './brand.js';
import { BROKERS, NET } from './config.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { tvLayout } from './input/settings.js';
import { sanitizeName } from './net/codec.js';
import { RaceSession } from './RaceSession.js';
import { RoomClient } from './RoomClient.js';
import { LOBBY_STATE } from './net/RoomSession.js';
import { colourOf, isColourId } from './sim/palette.js';
import { TRACKS } from './sim/track/index.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { dateSeed, daySeed, generateTrack, seedOf, utcDay } from './sim/track/generate.js';
import { validTrace } from './sim/ghost.js';
import { drawTrackPreview } from './ui/trackPreview.js';
import { randomSeedText } from './sim/track/seedWords.js';
import { BODIES, BODY_NAMES, bodyCode, decodeLook, DEFAULT_LOOK, encodeLook } from './sim/look.js';
import { Garage } from './ui/Garage.js';
import { GaragePreview } from './render/GaragePreview.js';
import { PodiumView } from './render/PodiumView.js';
import { applyGlyphs, padFamily } from './ui/glyphs.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { formatTime, Hud } from './ui/Hud.js';
import { Keyboard } from './ui/Keyboard.js';
import { ChoiceList } from './ui/ChoiceList.js';
import { stepperFor } from './ui/Picker.js';
import { Lobby } from './ui/Lobby.js';
import { awards, Tally } from './sim/raceLog.js';
import { isBotId } from './sim/bots.js';
import { makePlayerId, makeRoomCode } from './util.js';
import { VERSION } from './version.js';
/*
 * Wiring. Everything interesting lives elsewhere; this file connects the
 * menus, the room and the race sessions, and exposes a debug handle for the
 * test rig.
 */
const params = new URLSearchParams(location.search);
const qualityOverride = params.get('quality');
const $ = (id) => {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`#${id} missing from index.html`);
    return el;
};
document.title = GAME_NAME;
for (const el of document.querySelectorAll('[data-brand]'))
    el.textContent = GAME_NAME;
$('version').textContent = `v${VERSION}`;
const gameRoot = $('game-root');
const settings = new SettingsStore();
const input = new InputManager(document.body, settings);
const nav = new GamepadNavigator(input.gamepad, $('ui-root'));
const keyboard = new Keyboard();
const choices = new ChoiceList();
choices.focus = (el) => nav.focusOn(el);
/* ---------------------------------------------------------------- screens */
const screens = [
    'screen-menu', 'screen-join', 'screen-connecting', 'screen-lobby', 'screen-full', 'screen-settings', 'screen-hud', 'screen-results',
    'screen-garage', 'screen-track',
];
let current = 'screen-menu';
/** The results' podium: its own WebGL context, made the first time a race ends. */
let podium = null;
function show(id) {
    // A race can start while the host's guest is in the Garage: stop its turntable.
    if (id !== 'screen-garage')
        garage?.close();
    current = id;
    if (id !== 'screen-results')
        podium?.stop();
    for (const s of screens)
        $(s).hidden = s !== id;
    if (id === 'screen-hud') {
        nav.stop();
    }
    else {
        nav.start();
        nav.focusFirst();
    }
    if (id === 'screen-track')
        previewTrack();
    if (id === 'screen-lobby')
        $('lobby-name').value = $('input-name').value;
}
/* --------------------------------------------------------- name and colour */
const NAME_KEY = `${SLUG}.name`;
const COLOUR_KEY = `${SLUG}.colour`;
const store = {
    get(k) {
        try {
            return localStorage.getItem(k) ?? '';
        }
        catch {
            return '';
        }
    },
    set(k, v) {
        try {
            localStorage.setItem(k, v);
        }
        catch {
            /* private mode: fine */
        }
    },
};
const nameInput = $('input-name');
nameInput.value = store.get(NAME_KEY);
nameInput.addEventListener('input', () => {
    nameInput.value = nameInput.value.toUpperCase().replace(/[^A-Z0-9_\- ]/g, '');
    store.set(NAME_KEY, nameInput.value);
});
const playerName = () => sanitizeName(nameInput.value);
const TRACK_KEY = `${SLUG}.track`;
const SEED_KEY = `${SLUG}.seed`;
const WEAPONS_KEY = `${SLUG}.weapons`;
const PICKUPS_KEY = `${SLUG}.pickups`;
const TURBO_KEY = `${SLUG}.turbo`;
const BODY_KEY = `${SLUG}.body`;
for (const sel of [$('menu-track'), $('lobby-track')]) {
    const opt = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        return o;
    };
    // Grouped: the game's own tracks, the real circuits (M9), and the generated ones.
    const group = (label, options) => {
        const g = document.createElement('optgroup');
        g.label = label;
        g.append(...options);
        return g;
    };
    const own = TRACKS.flatMap((t, i) => (t.circuit ? [] : [opt(String(i), t.name)]));
    const real = TRACKS.flatMap((t, i) => (t.circuit ? [opt(String(i), t.name)] : []));
    sel.replaceChildren(group('Nitro Carnage', own), group('Real circuits', real), group('Generated', [opt('day', 'Track of the day'), opt('seed', 'Custom seed')]));
}
function trackChoice(value, seedText, index = 0) {
    if (value === 'day') {
        const seed = daySeed(Date.now());
        const def = generateTrack(seed);
        return { def, seed, label: `Track of the day ${utcDay(Date.now())} · ${def.name}` };
    }
    const dated = value === 'seed' ? dateSeed(seedText, Date.now()) : null;
    if (dated?.locked) {
        // Not even generated: the map would give it away.
        return { def: TRACKS[0], seed: 0, label: dated.day, locked: `${dated.day}'s Track of the Day opens at midnight UTC that day. No practising ahead!` };
    }
    if (dated) {
        const def = generateTrack(dated.seed);
        return { def, seed: dated.seed, label: `Track of the day ${dated.day} · ${def.name}` };
    }
    if (value === 'seed') {
        const seed = seedOf(seedText || 'NITRO');
        const def = generateTrack(seed);
        return { def, seed, label: `${def.name} · seed ${seedText.trim().toLowerCase() || 'nitro'}` };
    }
    const def = TRACKS[Number(value)] ?? TRACKS[index] ?? TRACKS[0];
    return { def, seed: 0, label: def.name };
}
const menuTrack = $('menu-track');
const menuSeed = $('menu-seed');
/** `?track=docks` or `?track=day` picks a track, and `?seed=word` a seed: for tests and links. */
const trackParam = params.get('seed') ? 'seed' : params.get('track') === 'day' ? 'day' : String(TRACKS.findIndex((t) => t.id === params.get('track')));
const savedTrack = store.get(TRACK_KEY);
menuTrack.value = trackParam !== '-1' ? trackParam : [...menuTrack.options].some((o) => o.value === savedTrack) ? savedTrack : '0';
menuSeed.value = params.get('seed') ?? store.get(SEED_KEY);
/** Touching the seed means racing it: the track switches to Custom seed. */
const useMenuSeed = () => {
    menuTrack.value = 'seed';
    store.set(TRACK_KEY, 'seed');
    store.set(SEED_KEY, menuSeed.value);
    previewTrack();
};
// Three words from the list, hyphenated: "egg-cup-top".
$('menu-seed-random').addEventListener('click', () => {
    menuSeed.value = randomSeedText();
    useMenuSeed();
});
/**
 * The seed box shows the seed being raced: today's date for the Track of the
 * Day (its seed is the date), and your own word back for Custom seed.
 */
const showMenuSeed = () => {
    if (menuTrack.value === 'day')
        menuSeed.value = utcDay(Date.now());
    else if (menuTrack.value === 'seed' && dateSeed(menuSeed.value, Date.now())?.day === utcDay(Date.now()))
        menuSeed.value = store.get(SEED_KEY);
};
showMenuSeed();
menuTrack.addEventListener('change', () => {
    store.set(TRACK_KEY, menuTrack.value);
    showMenuSeed();
});
menuSeed.addEventListener('input', useMenuSeed);
const chosenTrack = () => trackChoice(menuTrack.value, menuSeed.value);
/** Draw the chosen track in the menu: redrawn as the choice changes, and as a seed is typed. */
let previewTimer = 0;
function previewTrack() {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
        if ($('screen-track').hidden)
            return;
        const c = chosenTrack();
        $('btn-track-go').disabled = !!c.locked;
        if (c.locked)
            showLocked($('menu-track-map'), $('menu-track-info'), c.locked);
        else
            drawTrackPreview($('menu-track-map'), $('menu-track-info'), c.def, c.label);
    }, 60);
}
menuTrack.addEventListener('change', previewTrack);
/** A blank map and the reason, in place of a track that isn't open yet. */
function showLocked(canvas, info, why) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    info.replaceChildren(Object.assign(document.createElement('b'), { textContent: '🔒 Locked' }), document.createElement('br'), why);
}
/** A quick race's laps, remembered; five until changed, like a room's. */
const LAPS_KEY = `${SLUG}.laps`;
const menuLaps = $('menu-laps');
menuLaps.value = store.get(LAPS_KEY);
// Nothing stored, or a value the list no longer has.
if (!menuLaps.value)
    menuLaps.value = String(LOBBY_STATE.laps);
menuLaps.addEventListener('change', () => store.set(LAPS_KEY, menuLaps.value));
const menuWeapons = $('menu-weapons');
menuWeapons.value = store.get(WEAPONS_KEY) === '0' ? '0' : '1';
menuWeapons.addEventListener('change', () => store.set(WEAPONS_KEY, menuWeapons.value));
const menuPickups = $('menu-pickups');
menuPickups.value = store.get(PICKUPS_KEY) === '0' ? '0' : '1';
menuPickups.addEventListener('change', () => store.set(PICKUPS_KEY, menuPickups.value));
const menuTurbo = $('menu-turbo');
menuTurbo.value = store.get(TURBO_KEY) === '0' ? '0' : '1';
menuTurbo.addEventListener('change', () => store.set(TURBO_KEY, menuTurbo.value));
/** The car-type lock's choices: everybody's own, or one body for the whole grid. Values are `bodyCode`s. */
for (const id of ['menu-body', 'lobby-body']) {
    $(id).replaceChildren(new Option('Own cars', '0'), ...BODIES.map((b) => new Option(`All ${BODY_NAMES[b]}`, String(bodyCode(b)))));
}
/**
 * The Garage's ‹ arrows › in place of dropdowns, for the short lists: the
 * race's switches, the room's, the race number and the settings. The track
 * lists stay dropdowns: thirty tracks in groups are better seen as a list.
 */
for (const id of [
    'menu-laps', 'menu-weapons', 'menu-pickups', 'menu-turbo', 'menu-body',
    'lobby-cars', 'lobby-laps', 'lobby-weapons', 'lobby-pickups', 'lobby-turbo', 'lobby-body',
    'garage-number',
    'set-quality', 'set-touch', 'set-bots', 'set-ghost', 'set-uisize', 'set-names', 'set-broker',
])
    stepperFor($(id));
const menuBody = $('menu-body');
menuBody.value = store.get(BODY_KEY);
if (!menuBody.value)
    menuBody.value = '0';
menuBody.addEventListener('change', () => store.set(BODY_KEY, menuBody.value));
/* ---------------------------------------------------------------- records */
/** Hotlap bests, per track (a generated one by its seed), kept on this device. */
// "best2": the tracks were shortened to ~30 s laps, and a record (and its
// ghost) from the old, longer shape of a track would be unbeatable and drive
// through the new one's walls.
const recordKey = (def) => `${SLUG}.best2.${def.id}`;
/** The Track of the Day mode's own records: laps without turbo are not comparable with a turbo hotlap's. */
const dailyKey = (def) => `${recordKey(def)}.noturbo`;
function loadRecord(key) {
    try {
        const r = JSON.parse(store.get(key) || 'null');
        if (!r || !Number.isFinite(r.time) || r.time <= 0 || !Array.isArray(r.splits))
            return null;
        // A record from before the ghost (or a damaged one) races without it.
        if (r.ghost !== undefined && !validTrace(r.ghost))
            delete r.ghost;
        return r;
    }
    catch {
        return null;
    }
}
/* ------------------------------------------------------------------- look */
const LOOK_KEY = `${SLUG}.look`;
/** The car's look, stored as its six-character wire form: one format, one sanitiser. */
let look = store.get(LOOK_KEY) ? decodeLook(store.get(LOOK_KEY)) : { ...DEFAULT_LOOK };
let garage = null;
let garageFromLobby = false;
function openGarage(fromLobby) {
    garageFromLobby = fromLobby;
    // The preview is a WebGL context of its own: made on first use, not at boot.
    garage ??= (() => {
        const g = new Garage(new GaragePreview($('garage-view')), look);
        g.onChange = (l) => {
            look = l;
            store.set(LOOK_KEY, encodeLook(l));
            room?.net.room.setIdentity(playerName(), colourId, encodeLook(l));
        };
        // Only offline: a room's colour is picked in its lobby.
        g.onColour = (c) => {
            colourId = c;
            store.set(COLOUR_KEY, c);
        };
        return g;
    })();
    const colour = fromLobby && room ? (room.net.room.resolvedColours()[room.net.playerId] ?? colourId) : colourId;
    show('screen-garage');
    garage.open(colour, !(fromLobby && room));
}
$('btn-garage').addEventListener('click', () => openGarage(false));
$('btn-lobby-garage').addEventListener('click', () => openGarage(true));
$('btn-garage-back').addEventListener('click', () => {
    garage?.close();
    if (garageFromLobby && room) {
        show('screen-lobby');
        lobby?.render();
    }
    else {
        // The Garage is on the track screen, so Done goes back there.
        show('screen-track');
    }
});
const savedColour = store.get(COLOUR_KEY);
let colourId = isColourId(savedColour) ? savedColour : 'vermilion';
/* --------------------------------------------------------- race sessions */
let session = null;
let hud = null;
let helpTimer = 0;
let lastMode = 'race';
/** `?laps=1` shortens races, for tests and for trying things quickly. */
const lapsOverride = Number(params.get('laps')) || 0;
function begin(mode, s, track, label = track.name, bestKey = recordKey(track)) {
    session = s;
    if (params.has('autopilot'))
        s.autopilot = true;
    hud = new Hud(s, params.has('debug'));
    s.onHud = (h) => hud?.update(h);
    s.onWreck = (w) => hud?.wreck(w);
    s.onEvent = (ev) => {
        hud?.event(ev);
        // Hotlap: a lap faster than the record is the new record.
        if (mode === 'hotlap' && ev.kind === 'lap' && ev.id === s.playerId && s.player) {
            if (!s.record || ev.lapTime < s.record.time) {
                const beaten = s.record !== null;
                s.record = { time: ev.lapTime, splits: [...s.player.lap.lastSplits], ghost: s.lastTrace };
                store.set(bestKey, JSON.stringify(s.record));
                if (beaten)
                    hud?.banner(`NEW RECORD  ·  ${formatTime(ev.lapTime)}`, 3);
            }
        }
    };
    s.onOver = (rows) => {
        Hud.results(rows);
        showPodium(rows);
        const online = mode === 'net';
        // Names as the room knows them (the session calls you YOU), and each car's colour.
        const name = (id) => (room ? room.net.carInfo(id).name : id === s.playerId ? playerName() || 'You' : (s.cars.get(id)?.name ?? '—'));
        const css = (id) => s.cars.get(id)?.css ?? (room ? colourOf(room.net.carInfo(id).colour).cssColour : '#fff');
        const order = rows.map((r) => r.car.id);
        if (online)
            tally?.add(order, s.log, name, isBotId);
        Hud.awards(awards(s.log, order, name), css);
        Hud.tonight(online ? tally : null, s.playerId, css);
        // In a room the first button goes straight back to the lobby; the room
        // itself returns everyone there when the results time is up, unless the
        // host starts a rematch first.
        $('btn-again').textContent = online ? 'Back to lobby' : 'Race again';
        $('results-note').hidden = !online;
        rematchButton();
        if (online)
            countDownToLobby();
        $('btn-results-menu').textContent = online ? 'Leave room' : 'Back';
        if (!online)
            stopSession();
        closePause();
        // The results appear mid-drive: a handbrake press (A, Space) must not dismiss them unseen.
        nav.quiet(1200);
        show('screen-results');
    };
    $('hud-track').textContent = label;
    const help = $('hud-help');
    // The controls, briefly, at the start of every drive: weapons are new to everybody once.
    help.hidden = false;
    help.classList.remove('gone');
    clearTimeout(helpTimer);
    helpTimer = window.setTimeout(() => help.classList.add('gone'), 9000);
    s.audio = audio;
    audio.music.play('race');
    show('screen-hud');
    s.start();
}
function showPodium(rows) {
    const top = rows.slice(0, 3);
    // A race with nobody to beat has no podium.
    $('results-podium').hidden = top.length < 2;
    if (top.length < 2)
        return;
    podium ??= new PodiumView($('results-podium'));
    podium.show(top.map((r) => ({ look: r.car.look, colour: r.car.colour })));
    top.forEach((r, i) => {
        const el = $(`podium-${i + 1}`);
        el.textContent = r.car.name;
        el.style.color = r.car.css;
    });
    for (let i = top.length; i < 3; i++)
        $(`podium-${i + 1}`).textContent = '';
    podium.start();
}
/** `?bots=0` races alone, for tests. */
const botsOverride = params.has('bots') ? Math.max(0, Math.min(5, Number(params.get('bots')) || 0)) : 5;
/** The mode the track screen will start. */
let trackMode = 'race';
/**
 * Quick race and Hotlap open the track screen first: which track (built-in,
 * of the day, or a seed), a map of it, weapons for a race, and the controls.
 * The menu itself keeps to the modes and settings.
 */
function chooseTrack(mode) {
    trackMode = mode;
    $('track-mode').textContent = mode === 'race' ? 'Quick race' : 'Hotlap';
    $('btn-track-go').textContent = mode === 'race' ? 'Start race' : 'Start hotlap';
    // A hotlap never has weapons or boxes, and always has its turbo: the switches only belong to a race.
    $('menu-weapons-row').hidden = mode === 'hotlap';
    $('menu-pickups-row').hidden = mode === 'hotlap';
    $('menu-turbo-row').hidden = mode === 'hotlap';
    $('menu-body-row').hidden = mode === 'hotlap';
    $('menu-laps-row').hidden = mode === 'hotlap';
    show('screen-track');
}
function startOffline(mode) {
    leaveRoom();
    stopSession();
    lastMode = mode;
    const quality = qualityOverride ?? settings.current.quality;
    // The Track of the Day skips the track screen: today's track, set up and ready.
    const daily = mode === 'daily';
    const choice = daily ? trackChoice('day', '') : chosenTrack();
    if (choice.locked && !daily) {
        chooseTrack(mode);
        return;
    }
    const track = choice.def;
    const race = mode === 'race';
    const s = new RaceSession(gameRoot, { mode: race ? 'race' : 'hotlap', track, quality, colourId, bots: botsOverride, laps: lapsOverride || Number(menuLaps.value) || track.laps, look,
        weapons: menuWeapons.value !== '0', pickups: menuPickups.value !== '0',
        // A hotlap has its turbo; the Track of the Day is driven without.
        turbo: race ? menuTurbo.value !== '0' : !daily,
        body: race ? BODIES[Number(menuBody.value) - 1] : undefined }, input, settings);
    const bestKey = daily ? dailyKey(track) : recordKey(track);
    if (!race)
        s.record = loadRecord(bestKey);
    begin(race ? 'race' : 'hotlap', s, track, daily ? `${choice.label} · no turbo` : choice.label, bestKey);
}
function stopSession() {
    if (session)
        audio.music.play('menu');
    session?.stop();
    hud?.dispose();
    session = null;
    hud = null;
    closePause();
}
/**
 * Out of a race: back to the screen it was started from. Offline that is the
 * track screen, set up as it was, so another go on the same track or a change
 * of seed is one step away. Leaving a room leaves it, so that goes to the menu.
 */
function toMenu() {
    const wasRoom = room !== null;
    leaveRoom();
    stopSession();
    // The Track of the Day came straight from the menu, so it goes back there.
    if (wasRoom || lastMode === 'daily')
        show('screen-menu');
    else
        chooseTrack(lastMode === 'hotlap' ? 'hotlap' : 'race');
}
/* ------------------------------------------------------------------ rooms */
let room = null;
let lobby = null;
/** The room's running score across tonight's races; a new room starts a new one. */
let tally = null;
/** Rematch, on the results, for the host of a room: it becomes the button the pad lands on. */
function rematchButton() {
    const host = room?.net.isHost === true && room.net.phase === 'X';
    const btn = $('btn-rematch');
    btn.hidden = !host;
    btn.toggleAttribute('data-nav-default', host);
    $('btn-again').toggleAttribute('data-nav-default', !host);
    // One bright button: Rematch when there is one.
    $('btn-again').classList.toggle('primary', !host);
}
async function openRoom(code) {
    leaveRoom();
    stopSession();
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length < 4)
        return;
    const broker = BROKERS.find((b) => b.id === settings.current.broker) ?? BROKERS[0];
    // Direct links unless switched off (Settings, or ?nop2p); ?nostun keeps them
    // to this network, which is what the test rig wants.
    const direct = settings.current.direct && !params.has('nop2p');
    const ice = direct ? (params.has('nostun') ? [] : NET.rtc.iceServers) : null;
    const client = new RoomClient(code, makePlayerId(), playerName(), colourId, encodeLook(look), ice);
    client.net.botLevel = settings.current.botLevel;
    room = client;
    tally = new Tally();
    $('connect-status').textContent = `Reaching ${broker.label}…`;
    show('screen-connecting');
    const net = client.net;
    const redraw = () => {
        if (room === client && current === 'screen-lobby')
            lobby?.render();
    };
    net.events.on('state', redraw);
    net.events.on('roster', redraw);
    net.events.on('hostChange', () => {
        redraw();
        // The host left during the results: Rematch moves to whoever took over.
        if (room === client && current === 'screen-results')
            rematchButton();
    });
    net.events.on('roomFull', () => {
        leaveRoom();
        show('screen-full');
    });
    net.events.on('raceStart', () => {
        if (room !== client)
            return;
        stopSession();
        const quality = qualityOverride ?? settings.current.quality;
        // The world the room built: a generated track when the heartbeat carried a seed.
        const track = net.world?.track.def ?? TRACKS[net.state.track] ?? TRACKS[0];
        begin('net', new RaceSession(gameRoot, { mode: 'net', track, quality, colourId, bots: 0, laps: 0 }, input, settings, net), track);
    });
    net.events.on('raceEnd', () => {
        if (room !== client)
            return;
        stopSession();
        show('screen-lobby');
        lobby?.render();
    });
    // A link opening or falling back to the broker changes the lobby's badges.
    client.mesh?.events.on('link', redraw);
    client.mqtt.events.on('status', ({ status }) => {
        const pill = $('net-status');
        pill.textContent = status;
        pill.className = `pill ${status}`;
    });
    try {
        await client.connect(broker.url);
    }
    catch (err) {
        if (room !== client)
            return;
        $('connect-status').textContent = `Could not reach ${broker.label}: ${err.message}. Try another broker in Settings.`;
        room = null;
        return;
    }
    if (room !== client)
        return;
    lobby = new Lobby(net, code, tally);
    history.replaceState(null, '', `?room=${code}${params.has('quality') ? `&quality=${params.get('quality')}` : ''}`);
    show('screen-lobby');
    lobby.render();
}
function leaveRoom() {
    if (!room)
        return;
    room.leave();
    room = null;
    lobby = null;
    tally = null;
    document.body.classList.remove('is-host');
    if (params.has('room'))
        history.replaceState(null, '', location.pathname);
}
/* ------------------------------------------------------------------ pause */
/**
 * The pause menu — Esc, the pad's Menu/Options, or the ☰ button. Offline it
 * stops the world. Online it cannot (a race with other people in it does not
 * stop for one of them), so it holds your car on the brakes and says so.
 */
function openPause() {
    if (!session)
        return;
    session.paused = true;
    const online = session.mode === 'net';
    $('pause-note').textContent = online
        ? 'The race goes on without you: your car is held on the brakes until you resume.'
        : 'The race is paused.';
    $('btn-pause-leave').textContent = online ? 'Leave room' : 'Leave race';
    $('pause-veil').hidden = false;
    nav.start();
    nav.focusFirst();
}
function closePause() {
    if (session)
        session.paused = false;
    $('pause-veil').hidden = true;
    if (current === 'screen-hud')
        nav.stop();
}
function togglePause() {
    if ($('pause-veil').hidden)
        openPause();
    else
        closePause();
}
// The pad's Menu/Options, on its own latch so the menu navigator can read the same button.
(function pollPause() {
    if (input.gamepad.readPause() && current === 'screen-hud' && session)
        togglePause();
    requestAnimationFrame(pollPause);
})();
/* ---------------------------------------------------------- the controller */
nav.onConnection = (connected) => {
    $('console-banner').hidden = !connected;
    applyGlyphs(connected ? padFamily(input.gamepad.padId) : 'none');
};
applyGlyphs('none');
// A different pad can replace the last one without the navigator ever seeing
// "no pad" in between, so prompts follow every connection, not just the first.
window.addEventListener('gamepadconnected', (e) => applyGlyphs(padFamily(e.gamepad.id)));
/* ----------------------------------------------------------------- wiring */
$('btn-create').addEventListener('click', () => void openRoom(makeRoomCode()));
$('btn-join').addEventListener('click', () => show('screen-join'));
$('btn-join-go').addEventListener('click', () => void openRoom($('input-room').value));
$('btn-join-back').addEventListener('click', () => show('screen-menu'));
$('input-room').addEventListener('input', (e) => {
    const el = e.target;
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('input-room').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')
        void openRoom(e.target.value);
});
$('btn-connect-cancel').addEventListener('click', toMenu);
$('btn-full-back').addEventListener('click', () => show('screen-menu'));
$('btn-race').addEventListener('click', () => chooseTrack('race'));
$('btn-free-drive').addEventListener('click', () => chooseTrack('hotlap'));
$('btn-daily').addEventListener('click', () => startOffline('daily'));
$('btn-track-go').addEventListener('click', () => startOffline(trackMode));
$('btn-track-back').addEventListener('click', () => show('screen-menu'));
$('btn-again').addEventListener('click', () => {
    if (room) {
        stopSession();
        show('screen-lobby');
        lobby?.render();
    }
    else {
        startOffline(lastMode);
    }
});
/** "Back to the lobby in 9 s" on a room's results, counting down. */
let lobbyTimer = 0;
function countDownToLobby() {
    clearInterval(lobbyTimer);
    const until = performance.now() + NET.resultsMs;
    const tick = () => {
        const left = Math.ceil((until - performance.now()) / 1000);
        if (left <= 0 || $('screen-results').hidden) {
            clearInterval(lobbyTimer);
            return;
        }
        const host = room?.net.room.hostId ? room.net.carInfo(room.net.room.hostId) : null;
        $('results-note').textContent = host && !host.you
            ? `Back to the lobby in ${left} s, unless ${host.name} starts a rematch.`
            : `Back to the lobby in ${left} s.`;
    };
    tick();
    lobbyTimer = window.setInterval(tick, 250);
}
$('btn-rematch').addEventListener('click', () => room?.net.rematch());
$('btn-results-menu').addEventListener('click', toMenu);
$('btn-pause').addEventListener('click', openPause);
$('btn-resume').addEventListener('click', closePause);
$('btn-pause-leave').addEventListener('click', toMenu);
$('btn-lobby-leave').addEventListener('click', toMenu);
$('btn-start-race').addEventListener('click', () => room?.net.startRace());
$('btn-copy-link').addEventListener('click', () => void navigator.clipboard?.writeText($('lobby-link').textContent ?? ''));
// Your name, from the lobby as well as the menu: the two boxes are one setting.
const lobbyName = $('lobby-name');
lobbyName.addEventListener('input', () => {
    lobbyName.value = lobbyName.value.toUpperCase().replace(/[^A-Z0-9_\- ]/g, '');
    nameInput.value = lobbyName.value;
    store.set(NAME_KEY, nameInput.value);
    room?.net.room.setIdentity(playerName(), colourId, encodeLook(look));
    lobby?.render();
});
$('lobby-colour').addEventListener('change', () => {
    colourId = $('lobby-colour').dataset.value ?? colourId;
    store.set(COLOUR_KEY, colourId);
    room?.net.room.setIdentity(playerName(), colourId, encodeLook(look));
    lobby?.render();
});
const lobbySettings = () => {
    const pick = $('lobby-track').value;
    const choice = trackChoice(pick, $('lobby-seed').value);
    lobby?.lock(choice.locked ?? null);
    // A future day's track never reaches the room: it keeps the last one.
    if (choice.locked)
        return;
    room?.net.configure(Number($('lobby-cars').value), Number($('lobby-laps').value), choice.seed ? 0 : Number(pick), choice.seed, Number($('lobby-weapons').value), Number($('lobby-pickups').value), Number($('lobby-turbo').value), Number($('lobby-body').value));
};
$('lobby-cars').addEventListener('change', lobbySettings);
$('lobby-laps').addEventListener('change', lobbySettings);
$('lobby-track').addEventListener('change', () => {
    if ($('lobby-track').value === 'day')
        $('lobby-seed').value = utcDay(Date.now());
    lobbySettings();
});
$('lobby-weapons').addEventListener('change', lobbySettings);
$('lobby-pickups').addEventListener('change', lobbySettings);
$('lobby-turbo').addEventListener('change', lobbySettings);
$('lobby-body').addEventListener('change', lobbySettings);
$('lobby-seed').addEventListener('change', lobbySettings);
// As in the menu, typing a seed switches the room to it; the rest of the room hears when the typing is done.
$('lobby-seed').addEventListener('input', () => {
    const sel = $('lobby-track');
    if (sel.value === 'seed')
        return;
    sel.value = 'seed';
    lobbySettings();
});
$('lobby-seed-random').addEventListener('click', () => {
    $('lobby-seed').value = randomSeedText();
    $('lobby-track').value = 'seed';
    lobbySettings();
});
const brokerSelect = $('set-broker');
brokerSelect.replaceChildren(...BROKERS.map((b) => {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.label;
    return o;
}));
/* ------------------------------------------------------------------ sound */
const audio = new AudioEngine();
const syncVolumes = () => audio.setVolumes(settings.current.sfxVolume, settings.current.musicVolume);
syncVolumes();
settings.events.on('change', syncVolumes);
// Browsers start audio only from a gesture: the first key, click or touch.
for (const type of ['keydown', 'pointerdown', 'touchstart']) {
    window.addEventListener(type, () => {
        audio.unlock();
        audio.music.play(session ? 'race' : 'menu');
    }, { capture: true, passive: true });
}
// A soft tick as the focus ring moves through the menus.
document.addEventListener('focusin', () => {
    if (!session || session.paused)
        audio.blip();
});
$('set-ghost').addEventListener('change', (e) => settings.set('ghostLead', Number(e.target.value)));
$('set-fov').addEventListener('input', (e) => settings.set('fov', Number(e.target.value)));
// The mouse wheel zooms the race camera: down (towards you) widens the view, up
// closes in. It changes the same setting as the slider, so it is kept.
addEventListener('wheel', (e) => {
    if (!session || $('screen-hud').hidden || !$('pause-veil').hidden)
        return;
    e.preventDefault();
    settings.set('fov', settings.current.fov + Math.sign(e.deltaY) * 2);
}, { passive: false });
$('set-bots').addEventListener('change', (e) => settings.set('botLevel', e.target.value));
$('set-uisize').addEventListener('change', (e) => settings.set('uiSize', e.target.value));
/** The TV layout: everything larger, and kept clear of the edges a TV may crop. */
const applyUiSize = () => {
    document.body.classList.toggle('tv', tvLayout(settings.current.uiSize));
};
applyUiSize();
settings.events.on('change', applyUiSize);
$('set-names').addEventListener('change', (e) => settings.set('nameTags', e.target.value));
$('set-sfx').addEventListener('input', (e) => settings.set('sfxVolume', Number(e.target.value)));
$('set-music').addEventListener('input', (e) => settings.set('musicVolume', Number(e.target.value)));
/** Where Settings' Back goes: the menu, or the pause menu of the race it was opened from. */
let settingsFromPause = false;
function openSettings(fromPause) {
    settingsFromPause = fromPause;
    $('set-quality').value = settings.current.quality === 'potato' ? 'low' : settings.current.quality;
    $('set-touch').value = settings.current.touchControls;
    $('set-vibration').checked = settings.current.vibration;
    $('set-motion').checked = settings.current.reduceMotion;
    $('set-autopilot').checked = settings.current.autopilot;
    $('set-direct').checked = settings.current.direct;
    brokerSelect.value = settings.current.broker;
    $('set-sfx').value = String(settings.current.sfxVolume);
    $('set-ghost').value = String(settings.current.ghostLead);
    $('set-names').value = settings.current.nameTags;
    $('set-uisize').value = settings.current.uiSize;
    $('set-bots').value = settings.current.botLevel;
    $('set-fov').value = String(settings.current.fov);
    $('set-music').value = String(settings.current.musicVolume);
    // The race stays where it is underneath: paused offline, held on the brakes online.
    if (fromPause)
        $('pause-veil').hidden = true;
    show('screen-settings');
}
$('btn-settings').addEventListener('click', () => openSettings(false));
$('btn-pause-settings').addEventListener('click', () => openSettings(true));
$('btn-settings-back').addEventListener('click', () => {
    if (settingsFromPause && session) {
        settingsFromPause = false;
        show('screen-hud');
        openPause();
    }
    else {
        show('screen-menu');
    }
});
// Settings that can change mid-race take effect at once.
settings.events.on('change', () => {
    // A host's bots take the new level from their next race.
    if (room)
        room.net.botLevel = settings.current.botLevel;
    if (!session)
        return;
    session.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
    session.view.rig.baseFov = settings.current.fov;
    if (!params.has('autopilot'))
        session.autopilot = settings.current.autopilot;
});
$('set-quality').addEventListener('change', (e) => settings.set('quality', e.target.value));
$('set-touch').addEventListener('change', (e) => settings.set('touchControls', e.target.value));
$('set-vibration').addEventListener('change', (e) => settings.set('vibration', e.target.checked));
$('set-motion').addEventListener('change', (e) => settings.set('reduceMotion', e.target.checked));
$('set-autopilot').addEventListener('change', (e) => settings.set('autopilot', e.target.checked));
$('set-direct').addEventListener('change', (e) => settings.set('direct', e.target.checked));
brokerSelect.addEventListener('change', () => settings.set('broker', brokerSelect.value));
window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || keyboard.isOpen || choices.isOpen)
        return;
    if (current === 'screen-hud' && session)
        togglePause();
});
show('screen-menu');
/**
 * A link to a ready-to-go track screen: `?daily` is today's Track of the Day
 * as a hotlap, and `?pick=hotlap` or `?pick=race` with `&track=` or `&seed=`
 * any other. The player lands on the track screen with Start focused, so one
 * press drives. (`?hotlap` and `?race` skip even that: for tests.)
 */
if (params.has('daily') || params.has('pick')) {
    // `?daily=2026-09-20` is that day's (a future day shows as locked).
    const day = params.get('daily');
    if (day) {
        menuTrack.value = 'seed';
        menuSeed.value = day;
    }
    else if (params.has('daily')) {
        menuTrack.value = 'day';
        showMenuSeed();
    }
    chooseTrack(params.get('pick') === 'race' ? 'race' : 'hotlap');
}
if (params.has('drive') || params.has('hotlap'))
    startOffline('hotlap');
if (params.has('race'))
    startOffline('race');
const linked = params.get('room');
if (linked) {
    $('input-room').value = linked.toUpperCase();
    void openRoom(linked);
}
window.nitro = {
    settings,
    audio,
    get garage() {
        return garage;
    },
    get look() {
        return look;
    },
    get colour() {
        return colourId;
    },
    input,
    get session() {
        return session;
    },
    get room() {
        return room;
    },
    start: startOffline,
    openRoom,
    leave: toMenu,
};
//# sourceMappingURL=main.js.map