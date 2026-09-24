import { GAME_NAME, SLUG } from './brand.js';
import { BROKERS } from './config.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { sanitizeName } from './net/codec.js';
import { RaceSession } from './RaceSession.js';
import { RoomClient } from './RoomClient.js';
import { isColourId } from './sim/palette.js';
import { TRACKS } from './sim/track/index.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { applyGlyphs, padFamily } from './ui/glyphs.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { Hud } from './ui/Hud.js';
import { Keyboard } from './ui/Keyboard.js';
import { Lobby } from './ui/Lobby.js';
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
/* ---------------------------------------------------------------- screens */
const screens = [
    'screen-menu', 'screen-join', 'screen-connecting', 'screen-lobby', 'screen-full', 'screen-settings', 'screen-hud', 'screen-results',
];
let current = 'screen-menu';
function show(id) {
    current = id;
    for (const s of screens)
        $(s).hidden = s !== id;
    if (id === 'screen-hud') {
        nav.stop();
    }
    else {
        nav.start();
        nav.focusFirst();
    }
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
/* ------------------------------------------------------------------ track */
const TRACK_KEY = `${SLUG}.track`;
const trackSelects = [$('menu-track'), $('lobby-track')];
for (const sel of trackSelects) {
    sel.replaceChildren(...TRACKS.map((t, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = t.name;
        return o;
    }));
}
/** `?track=docks` picks a track by id, for tests and links. */
const trackParam = TRACKS.findIndex((t) => t.id === params.get('track'));
const savedTrack = TRACKS.findIndex((t) => t.id === store.get(TRACK_KEY));
$('menu-track').value = String(trackParam >= 0 ? trackParam : Math.max(0, savedTrack));
$('menu-track').addEventListener('change', () => store.set(TRACK_KEY, chosenTrack().id));
const chosenTrack = () => TRACKS[Number($('menu-track').value)] ?? TRACKS[0];
const savedColour = store.get(COLOUR_KEY);
let colourId = isColourId(savedColour) ? savedColour : 'vermilion';
/* --------------------------------------------------------- race sessions */
let session = null;
let hud = null;
let helpTimer = 0;
let lastMode = 'race';
/** `?laps=1` shortens races, for tests and for trying things quickly. */
const lapsOverride = Number(params.get('laps')) || 0;
function begin(mode, s, track) {
    session = s;
    if (params.has('autopilot'))
        s.autopilot = true;
    hud = new Hud(s, params.has('debug'));
    s.onHud = (h) => hud?.update(h);
    s.onEvent = (ev) => hud?.event(ev);
    s.onOver = (rows) => {
        Hud.results(rows);
        const online = mode === 'net';
        $('btn-again').hidden = online;
        $('results-note').hidden = !online;
        $('btn-results-menu').textContent = online ? 'Leave room' : 'Menu';
        if (!online)
            stopSession();
        closePause();
        show('screen-results');
    };
    $('hud-track').textContent = track.name;
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
function startOffline(mode) {
    leaveRoom();
    stopSession();
    lastMode = mode;
    const quality = qualityOverride ?? settings.current.quality;
    const track = chosenTrack();
    begin(mode, new RaceSession(gameRoot, { mode, track, quality, colourId, bots: 5, laps: lapsOverride || track.laps }, input, settings), track);
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
function toMenu() {
    leaveRoom();
    stopSession();
    show('screen-menu');
}
/* ------------------------------------------------------------------ rooms */
let room = null;
let lobby = null;
async function openRoom(code) {
    leaveRoom();
    stopSession();
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length < 4)
        return;
    const broker = BROKERS.find((b) => b.id === settings.current.broker) ?? BROKERS[0];
    const client = new RoomClient(code, makePlayerId(), playerName(), colourId);
    room = client;
    $('connect-status').textContent = `Reaching ${broker.label}…`;
    show('screen-connecting');
    const net = client.net;
    const redraw = () => {
        if (room === client && current === 'screen-lobby')
            lobby?.render();
    };
    net.events.on('state', redraw);
    net.events.on('roster', redraw);
    net.events.on('hostChange', redraw);
    net.events.on('roomFull', () => {
        leaveRoom();
        show('screen-full');
    });
    net.events.on('raceStart', () => {
        if (room !== client)
            return;
        stopSession();
        const quality = qualityOverride ?? settings.current.quality;
        const track = TRACKS[net.state.track] ?? TRACKS[0];
        begin('net', new RaceSession(gameRoot, { mode: 'net', track, quality, colourId, bots: 0, laps: 0 }, input, settings, net), track);
    });
    net.events.on('raceEnd', () => {
        if (room !== client)
            return;
        stopSession();
        show('screen-lobby');
        lobby?.render();
    });
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
    lobby = new Lobby(net, code);
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
$('btn-race').addEventListener('click', () => startOffline('race'));
$('btn-free-drive').addEventListener('click', () => startOffline('free'));
$('btn-again').addEventListener('click', () => startOffline(lastMode === 'free' ? 'free' : 'race'));
$('btn-results-menu').addEventListener('click', toMenu);
$('btn-pause').addEventListener('click', openPause);
$('btn-resume').addEventListener('click', closePause);
$('btn-pause-leave').addEventListener('click', toMenu);
$('btn-lobby-leave').addEventListener('click', toMenu);
$('btn-start-race').addEventListener('click', () => room?.net.startRace());
$('btn-copy-link').addEventListener('click', () => void navigator.clipboard?.writeText($('lobby-link').textContent ?? ''));
$('lobby-colour').addEventListener('change', (e) => {
    colourId = e.target.value;
    store.set(COLOUR_KEY, colourId);
    room?.net.room.setIdentity(playerName(), colourId);
    lobby?.render();
});
const lobbySettings = () => {
    room?.net.configure(Number($('lobby-cars').value), Number($('lobby-laps').value), Number($('lobby-track').value));
};
$('lobby-cars').addEventListener('change', lobbySettings);
$('lobby-laps').addEventListener('change', lobbySettings);
$('lobby-track').addEventListener('change', lobbySettings);
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
    brokerSelect.value = settings.current.broker;
    $('set-sfx').value = String(settings.current.sfxVolume);
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
    if (!session)
        return;
    session.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
    if (!params.has('autopilot'))
        session.autopilot = settings.current.autopilot;
});
$('set-quality').addEventListener('change', (e) => settings.set('quality', e.target.value));
$('set-touch').addEventListener('change', (e) => settings.set('touchControls', e.target.value));
$('set-vibration').addEventListener('change', (e) => settings.set('vibration', e.target.checked));
$('set-motion').addEventListener('change', (e) => settings.set('reduceMotion', e.target.checked));
$('set-autopilot').addEventListener('change', (e) => settings.set('autopilot', e.target.checked));
brokerSelect.addEventListener('change', () => settings.set('broker', brokerSelect.value));
window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || keyboard.isOpen)
        return;
    if (current === 'screen-hud' && session)
        togglePause();
});
show('screen-menu');
if (params.has('drive'))
    startOffline('free');
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