import { GAME_NAME, SLUG } from './brand.js';
import { BROKERS } from './config.js';
import type { QualityId } from './config.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { sanitizeName } from './net/codec.js';
import { RaceSession } from './RaceSession.js';
import type { SessionMode } from './RaceSession.js';
import { RoomClient } from './RoomClient.js';
import { isColourId } from './sim/palette.js';
import { DOWNTOWN } from './sim/track/downtown.js';
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
const qualityOverride = params.get('quality') as QualityId | null;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

document.title = GAME_NAME;
for (const el of document.querySelectorAll('[data-brand]')) el.textContent = GAME_NAME;
$('version').textContent = `v${VERSION}`;

const gameRoot = $('game-root');
const settings = new SettingsStore();
const input = new InputManager(document.body, settings);
const nav = new GamepadNavigator(input.gamepad, $('ui-root'));
const keyboard = new Keyboard();

/* ---------------------------------------------------------------- screens */

const screens = [
  'screen-menu', 'screen-join', 'screen-connecting', 'screen-lobby', 'screen-full', 'screen-settings', 'screen-hud', 'screen-results',
] as const;
type ScreenId = (typeof screens)[number];
let current = 'screen-menu' as ScreenId;

function show(id: ScreenId): void {
  current = id;
  for (const s of screens) $(s).hidden = s !== id;
  if (id === 'screen-hud') {
    nav.stop();
  } else {
    nav.start();
    nav.focusFirst();
  }
}

/* --------------------------------------------------------- name and colour */

const NAME_KEY = `${SLUG}.name`;
const COLOUR_KEY = `${SLUG}.colour`;
const store = {
  get(k: string): string {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: fine */
    }
  },
};
const nameInput = $<HTMLInputElement>('input-name');
nameInput.value = store.get(NAME_KEY);
nameInput.addEventListener('input', () => {
  nameInput.value = nameInput.value.toUpperCase().replace(/[^A-Z0-9_\- ]/g, '');
  store.set(NAME_KEY, nameInput.value);
});
const playerName = (): string => sanitizeName(nameInput.value);
const savedColour = store.get(COLOUR_KEY);
let colourId = isColourId(savedColour) ? savedColour : 'vermilion';

/* --------------------------------------------------------- race sessions */

let session: RaceSession | null = null;
let hud: Hud | null = null;
let helpTimer = 0;
let lastMode: SessionMode = 'race';
/** `?laps=1` shortens races, for tests and for trying things quickly. */
const lapsOverride = Number(params.get('laps')) || 0;

function begin(mode: SessionMode, s: RaceSession): void {
  session = s;
  if (params.has('autopilot')) s.autopilot = true;
  hud = new Hud(s, params.has('debug'));
  s.onHud = (h) => hud?.update(h);
  s.onEvent = (ev) => hud?.event(ev);
  s.onOver = (rows) => {
    Hud.results(rows);
    const online = mode === 'net';
    $('btn-again').hidden = online;
    $('results-note').hidden = !online;
    $('btn-results-menu').textContent = online ? 'Leave room' : 'Menu';
    if (!online) stopSession();
    closePause();
    show('screen-results');
  };
  $('hud-track').textContent = DOWNTOWN.name;
  const help = $('hud-help');
  help.hidden = mode !== 'free';
  help.classList.remove('gone');
  clearTimeout(helpTimer);
  helpTimer = window.setTimeout(() => help.classList.add('gone'), 9000);
  show('screen-hud');
  s.start();
}

function startOffline(mode: 'race' | 'free'): void {
  leaveRoom();
  stopSession();
  lastMode = mode;
  const quality = qualityOverride ?? settings.current.quality;
  begin(mode, new RaceSession(
    gameRoot,
    { mode, track: DOWNTOWN, quality, colourId, bots: 5, laps: lapsOverride || DOWNTOWN.laps },
    input,
    settings,
  ));
}

function stopSession(): void {
  session?.stop();
  hud?.dispose();
  session = null;
  hud = null;
  closePause();
}

function toMenu(): void {
  leaveRoom();
  stopSession();
  show('screen-menu');
}

/* ------------------------------------------------------------------ rooms */

let room: RoomClient | null = null;
let lobby: Lobby | null = null;

async function openRoom(code: string): Promise<void> {
  leaveRoom();
  stopSession();
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (code.length < 4) return;
  const broker = BROKERS.find((b) => b.id === settings.current.broker) ?? BROKERS[0]!;
  const client = new RoomClient(code, makePlayerId(), playerName(), colourId);
  room = client;
  $('connect-status').textContent = `Reaching ${broker.label}…`;
  show('screen-connecting');

  const net = client.net;
  const redraw = (): void => {
    if (room === client && current === 'screen-lobby') lobby?.render();
  };
  net.events.on('state', redraw);
  net.events.on('roster', redraw);
  net.events.on('hostChange', redraw);
  net.events.on('roomFull', () => {
    leaveRoom();
    show('screen-full');
  });
  net.events.on('raceStart', () => {
    if (room !== client) return;
    stopSession();
    const quality = qualityOverride ?? settings.current.quality;
    begin('net', new RaceSession(gameRoot, { mode: 'net', track: DOWNTOWN, quality, colourId, bots: 0, laps: 0 }, input, settings, net));
  });
  net.events.on('raceEnd', () => {
    if (room !== client) return;
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
  } catch (err) {
    if (room !== client) return;
    $('connect-status').textContent = `Could not reach ${broker.label}: ${(err as Error).message}. Try another broker in Settings.`;
    room = null;
    return;
  }
  if (room !== client) return;
  lobby = new Lobby(net, code);
  history.replaceState(null, '', `?room=${code}${params.has('quality') ? `&quality=${params.get('quality')}` : ''}`);
  show('screen-lobby');
  lobby.render();
}

function leaveRoom(): void {
  if (!room) return;
  room.leave();
  room = null;
  lobby = null;
  document.body.classList.remove('is-host');
  if (params.has('room')) history.replaceState(null, '', location.pathname);
}

/* ------------------------------------------------------------------ pause */

/**
 * The pause menu — Esc, the pad's Menu/Options, or the ☰ button. Offline it
 * stops the world. Online it cannot (a race with other people in it does not
 * stop for one of them), so it holds your car on the brakes and says so.
 */
function openPause(): void {
  if (!session) return;
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

function closePause(): void {
  if (session) session.paused = false;
  $('pause-veil').hidden = true;
  if (current === 'screen-hud') nav.stop();
}

function togglePause(): void {
  if ($('pause-veil').hidden) openPause();
  else closePause();
}

// The pad's Menu/Options, on its own latch so the menu navigator can read the same button.
(function pollPause(): void {
  if (input.gamepad.readPause() && current === 'screen-hud' && session) togglePause();
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
window.addEventListener('gamepadconnected', (e) => applyGlyphs(padFamily((e as GamepadEvent).gamepad.id)));

/* ----------------------------------------------------------------- wiring */

$('btn-create').addEventListener('click', () => void openRoom(makeRoomCode()));
$('btn-join').addEventListener('click', () => show('screen-join'));
$('btn-join-go').addEventListener('click', () => void openRoom($<HTMLInputElement>('input-room').value));
$('btn-join-back').addEventListener('click', () => show('screen-menu'));
$('input-room').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('input-room').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void openRoom((e.target as HTMLInputElement).value);
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
  colourId = (e.target as HTMLSelectElement).value;
  store.set(COLOUR_KEY, colourId);
  room?.net.room.setIdentity(playerName(), colourId);
  lobby?.render();
});
const lobbySettings = (): void => {
  room?.net.configure(Number($<HTMLSelectElement>('lobby-cars').value), Number($<HTMLSelectElement>('lobby-laps').value));
};
$('lobby-cars').addEventListener('change', lobbySettings);
$('lobby-laps').addEventListener('change', lobbySettings);

const brokerSelect = $<HTMLSelectElement>('set-broker');
brokerSelect.replaceChildren(
  ...BROKERS.map((b) => {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.label;
    return o;
  }),
);
$('btn-settings').addEventListener('click', () => {
  $<HTMLSelectElement>('set-quality').value = settings.current.quality === 'potato' ? 'low' : settings.current.quality;
  $<HTMLSelectElement>('set-touch').value = settings.current.touchControls;
  $<HTMLInputElement>('set-vibration').checked = settings.current.vibration;
  $<HTMLInputElement>('set-motion').checked = settings.current.reduceMotion;
  $<HTMLInputElement>('set-autopilot').checked = settings.current.autopilot;
  brokerSelect.value = settings.current.broker;
  show('screen-settings');
});
$('btn-settings-back').addEventListener('click', () => show('screen-menu'));
$('set-quality').addEventListener('change', (e) => settings.set('quality', (e.target as HTMLSelectElement).value as QualityId));
$('set-touch').addEventListener('change', (e) =>
  settings.set('touchControls', (e.target as HTMLSelectElement).value as 'auto' | 'on' | 'off'),
);
$('set-vibration').addEventListener('change', (e) => settings.set('vibration', (e.target as HTMLInputElement).checked));
$('set-motion').addEventListener('change', (e) => settings.set('reduceMotion', (e.target as HTMLInputElement).checked));
$('set-autopilot').addEventListener('change', (e) => settings.set('autopilot', (e.target as HTMLInputElement).checked));
brokerSelect.addEventListener('change', () => settings.set('broker', brokerSelect.value));

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || keyboard.isOpen) return;
  if (current === 'screen-hud' && session) togglePause();
});

show('screen-menu');
if (params.has('drive')) startOffline('free');
if (params.has('race')) startOffline('race');
const linked = params.get('room');
if (linked) {
  $<HTMLInputElement>('input-room').value = linked.toUpperCase();
  void openRoom(linked);
}

/** Debug handle for the test rig and the console. Not part of the game. */
declare global {
  interface Window {
    nitro: {
      settings: SettingsStore;
      input: InputManager;
      readonly session: RaceSession | null;
      readonly room: RoomClient | null;
      start: (mode: 'race' | 'free') => void;
      openRoom: (code: string) => Promise<void>;
      leave: () => void;
    };
  }
}
window.nitro = {
  settings,
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
