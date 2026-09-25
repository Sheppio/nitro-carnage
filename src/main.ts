import { GAME_NAME, SLUG } from './brand.js';
import { BROKERS, NET } from './config.js';
import type { QualityId } from './config.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import type { NameTags } from './input/settings.js';
import type { BotLevel } from './sim/autopilot.js';
import { sanitizeName } from './net/codec.js';
import { RaceSession } from './RaceSession.js';
import type { SessionMode } from './RaceSession.js';
import { RoomClient } from './RoomClient.js';
import { isColourId } from './sim/palette.js';
import { TRACKS } from './sim/track/index.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { daySeed, generateTrack, seedOf } from './sim/track/generate.js';
import type { LapRecord } from './RaceSession.js';
import { validTrace } from './sim/ghost.js';
import { drawTrackPreview } from './ui/trackPreview.js';
import { randomSeedText } from './sim/track/seedWords.js';
import { decodeLook, DEFAULT_LOOK, encodeLook } from './sim/look.js';
import type { CarLook } from './sim/look.js';
import { Garage } from './ui/Garage.js';
import { GaragePreview } from './render/GaragePreview.js';
import type { TrackDef } from './sim/track/TrackDef.js';
import { applyGlyphs, padFamily } from './ui/glyphs.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { formatTime, Hud } from './ui/Hud.js';
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
  'screen-garage', 'screen-track',
] as const;
type ScreenId = (typeof screens)[number];
let current = 'screen-menu' as ScreenId;

function show(id: ScreenId): void {
  // A race can start while the host's guest is in the Garage: stop its turntable.
  if (id !== 'screen-garage') garage?.close();
  current = id;
  for (const s of screens) $(s).hidden = s !== id;
  if (id === 'screen-hud') {
    nav.stop();
  } else {
    nav.start();
    nav.focusFirst();
  }
  if (id === 'screen-track') previewTrack();
  if (id === 'screen-lobby') $<HTMLInputElement>('lobby-name').value = $<HTMLInputElement>('input-name').value;
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
/* ------------------------------------------------------------------ track */

/**
 * Which track: one of the built-ins, the track of the day, or a seed of your
 * own (M7). Built-ins are their index in `TRACKS`; generated tracks travel
 * as their seed, and every client generates the same track from it.
 */
interface TrackChoice {
  def: TrackDef;
  /** 0 for a built-in. */
  seed: number;
  /** What the HUD and the lobby call it. */
  label: string;
}

const TRACK_KEY = `${SLUG}.track`;
const SEED_KEY = `${SLUG}.seed`;
const WEAPONS_KEY = `${SLUG}.weapons`;
for (const sel of [$<HTMLSelectElement>('menu-track'), $<HTMLSelectElement>('lobby-track')]) {
  const opt = (value: string, text: string): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  // Grouped: the game's own tracks, the real circuits (M9), and the generated ones.
  const group = (label: string, options: HTMLOptionElement[]): HTMLOptGroupElement => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...options);
    return g;
  };
  const own = TRACKS.flatMap((t, i) => (t.circuit ? [] : [opt(String(i), t.name)]));
  const real = TRACKS.flatMap((t, i) => (t.circuit ? [opt(String(i), t.name)] : []));
  sel.replaceChildren(group('Nitro Carnage', own), group('Real circuits', real), group('Generated', [opt('day', 'Track of the day'), opt('seed', 'Custom seed')]));
}

function trackChoice(value: string, seedText: string, index = 0): TrackChoice {
  if (value === 'day') {
    const seed = daySeed(Date.now());
    const def = generateTrack(seed);
    return { def, seed, label: `Track of the day · ${def.name}` };
  }
  if (value === 'seed') {
    const seed = seedOf(seedText || 'NITRO');
    const def = generateTrack(seed);
    return { def, seed, label: `${def.name} · seed ${seedText.trim().toLowerCase() || 'nitro'}` };
  }
  const def = TRACKS[Number(value)] ?? TRACKS[index] ?? TRACKS[0]!;
  return { def, seed: 0, label: def.name };
}

const menuTrack = $<HTMLSelectElement>('menu-track');
const menuSeed = $<HTMLInputElement>('menu-seed');
/** `?track=docks` or `?track=day` picks a track, and `?seed=word` a seed: for tests and links. */
const trackParam = params.get('seed') ? 'seed' : params.get('track') === 'day' ? 'day' : String(TRACKS.findIndex((t) => t.id === params.get('track')));
const savedTrack = store.get(TRACK_KEY);
menuTrack.value = trackParam !== '-1' ? trackParam : [...menuTrack.options].some((o) => o.value === savedTrack) ? savedTrack : '0';
menuSeed.value = params.get('seed') ?? store.get(SEED_KEY);
/** Touching the seed means racing it: the track switches to Custom seed. */
const useMenuSeed = (): void => {
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
menuTrack.addEventListener('change', () => store.set(TRACK_KEY, menuTrack.value));
menuSeed.addEventListener('input', useMenuSeed);
const chosenTrack = (): TrackChoice => trackChoice(menuTrack.value, menuSeed.value);

/** Draw the chosen track in the menu: redrawn as the choice changes, and as a seed is typed. */
let previewTimer = 0;
function previewTrack(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    if ($('screen-track').hidden) return;
    const c = chosenTrack();
    drawTrackPreview($<HTMLCanvasElement>('menu-track-map'), $('menu-track-info'), c.def, c.label);
  }, 60);
}
menuTrack.addEventListener('change', previewTrack);
const menuWeapons = $<HTMLSelectElement>('menu-weapons');
menuWeapons.value = store.get(WEAPONS_KEY) === '0' ? '0' : '1';
menuWeapons.addEventListener('change', () => store.set(WEAPONS_KEY, menuWeapons.value));

/* ---------------------------------------------------------------- records */

/** Hotlap bests, per track (a generated one by its seed), kept on this device. */
const recordKey = (def: TrackDef): string => `${SLUG}.best.${def.id}`;
function loadRecord(def: TrackDef): LapRecord | null {
  try {
    const r = JSON.parse(store.get(recordKey(def)) || 'null') as LapRecord | null;
    if (!r || !Number.isFinite(r.time) || r.time <= 0 || !Array.isArray(r.splits)) return null;
    // A record from before the ghost (or a damaged one) races without it.
    if (r.ghost !== undefined && !validTrace(r.ghost)) delete r.ghost;
    return r;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- look */

const LOOK_KEY = `${SLUG}.look`;
/** The car's look, stored as its six-character wire form: one format, one sanitiser. */
let look: CarLook = store.get(LOOK_KEY) ? decodeLook(store.get(LOOK_KEY)) : { ...DEFAULT_LOOK };
let garage: Garage | null = null;
let garageFromLobby = false;
function openGarage(fromLobby: boolean): void {
  garageFromLobby = fromLobby;
  // The preview is a WebGL context of its own: made on first use, not at boot.
  garage ??= (() => {
    const g = new Garage(new GaragePreview($('garage-view')), look);
    g.onChange = (l) => {
      look = l;
      store.set(LOOK_KEY, encodeLook(l));
      room?.net.room.setIdentity(playerName(), colourId, encodeLook(l));
    };
    return g;
  })();
  const colour = fromLobby && room ? (room.net.room.resolvedColours()[room.net.playerId] ?? colourId) : colourId;
  show('screen-garage');
  garage.open(colour);
}
$('btn-garage').addEventListener('click', () => openGarage(false));
$('btn-lobby-garage').addEventListener('click', () => openGarage(true));
$('btn-garage-back').addEventListener('click', () => {
  garage?.close();
  if (garageFromLobby && room) {
    show('screen-lobby');
    lobby?.render();
  } else {
    // The Garage is on the track screen, so Done goes back there.
    show('screen-track');
  }
});

const savedColour = store.get(COLOUR_KEY);
let colourId = isColourId(savedColour) ? savedColour : 'vermilion';

/* --------------------------------------------------------- race sessions */

let session: RaceSession | null = null;
let hud: Hud | null = null;
let helpTimer = 0;
let lastMode: SessionMode = 'race';
/** `?laps=1` shortens races, for tests and for trying things quickly. */
const lapsOverride = Number(params.get('laps')) || 0;

function begin(mode: SessionMode, s: RaceSession, track: TrackDef, label = track.name): void {
  session = s;
  if (params.has('autopilot')) s.autopilot = true;
  hud = new Hud(s, params.has('debug'));
  s.onHud = (h) => hud?.update(h);
  s.onEvent = (ev) => {
    hud?.event(ev);
    // Hotlap: a lap faster than the record is the new record.
    if (mode === 'hotlap' && ev.kind === 'lap' && ev.id === s.playerId && s.player) {
      if (!s.record || ev.lapTime < s.record.time) {
        const beaten = s.record !== null;
        s.record = { time: ev.lapTime, splits: [...s.player.lap.lastSplits], ghost: s.lastTrace };
        store.set(recordKey(track), JSON.stringify(s.record));
        if (beaten) hud?.banner(`NEW RECORD  ·  ${formatTime(ev.lapTime)}`, 3);
      }
    }
  };
  s.onOver = (rows) => {
    Hud.results(rows);
    const online = mode === 'net';
    // In a room the first button goes straight back to the lobby; the room
    // itself returns everyone there when the results time is up.
    $('btn-again').textContent = online ? 'Back to lobby' : 'Race again';
    $('results-note').hidden = !online;
    if (online) countDownToLobby();
    $('btn-results-menu').textContent = online ? 'Leave room' : 'Back';
    if (!online) stopSession();
    closePause();
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

/** `?bots=0` races alone, for tests. */
const botsOverride = params.has('bots') ? Math.max(0, Math.min(5, Number(params.get('bots')) || 0)) : 5;

/** The mode the track screen will start. */
let trackMode: 'race' | 'hotlap' = 'race';

/**
 * Quick race and Hotlap open the track screen first: which track (built-in,
 * of the day, or a seed), a map of it, weapons for a race, and the controls.
 * The menu itself keeps to the modes and settings.
 */
function chooseTrack(mode: 'race' | 'hotlap'): void {
  trackMode = mode;
  $('track-mode').textContent = mode === 'race' ? 'Quick race' : 'Hotlap';
  $('btn-track-go').textContent = mode === 'race' ? 'Start race' : 'Start hotlap';
  // A hotlap never has weapons: the switch only belongs to a race.
  $('menu-weapons-row').hidden = mode === 'hotlap';
  show('screen-track');
}

function startOffline(mode: 'race' | 'hotlap'): void {
  leaveRoom();
  stopSession();
  lastMode = mode;
  const quality = qualityOverride ?? settings.current.quality;
  const choice = chosenTrack();
  const track = choice.def;
  const s = new RaceSession(
    gameRoot,
    { mode, track, quality, colourId, bots: botsOverride, laps: lapsOverride || track.laps, look, weapons: menuWeapons.value !== '0' },
    input,
    settings,
  );
  if (mode === 'hotlap') s.record = loadRecord(track);
  begin(mode, s, track, choice.label);
}

function stopSession(): void {
  if (session) audio.music.play('menu');
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
function toMenu(): void {
  const wasRoom = room !== null;
  leaveRoom();
  stopSession();
  if (wasRoom) show('screen-menu');
  else chooseTrack(lastMode === 'hotlap' ? 'hotlap' : 'race');
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
  const client = new RoomClient(code, makePlayerId(), playerName(), colourId, encodeLook(look));
  client.net.botLevel = settings.current.botLevel;
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
    // The world the room built: a generated track when the heartbeat carried a seed.
    const track = net.world?.track.def ?? TRACKS[net.state.track] ?? TRACKS[0]!;
    begin('net', new RaceSession(gameRoot, { mode: 'net', track, quality, colourId, bots: 0, laps: 0 }, input, settings, net), track);
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
$('btn-race').addEventListener('click', () => chooseTrack('race'));
$('btn-free-drive').addEventListener('click', () => chooseTrack('hotlap'));
$('btn-track-go').addEventListener('click', () => startOffline(trackMode));
$('btn-track-back').addEventListener('click', () => show('screen-menu'));
$('btn-again').addEventListener('click', () => {
  if (room) {
    stopSession();
    show('screen-lobby');
    lobby?.render();
  } else {
    startOffline(lastMode === 'hotlap' ? 'hotlap' : 'race');
  }
});

/** "Back to the lobby in 9 s" on a room's results, counting down. */
let lobbyTimer = 0;
function countDownToLobby(): void {
  clearInterval(lobbyTimer);
  const until = performance.now() + NET.resultsMs;
  const tick = (): void => {
    const left = Math.ceil((until - performance.now()) / 1000);
    if (left <= 0 || $('screen-results').hidden) {
      clearInterval(lobbyTimer);
      return;
    }
    $('results-note').textContent = `Back to the lobby in ${left} s.`;
  };
  tick();
  lobbyTimer = window.setInterval(tick, 250);
}
$('btn-results-menu').addEventListener('click', toMenu);
$('btn-pause').addEventListener('click', openPause);
$('btn-resume').addEventListener('click', closePause);
$('btn-pause-leave').addEventListener('click', toMenu);
$('btn-lobby-leave').addEventListener('click', toMenu);
$('btn-start-race').addEventListener('click', () => room?.net.startRace());
$('btn-copy-link').addEventListener('click', () => void navigator.clipboard?.writeText($('lobby-link').textContent ?? ''));
// Your name, from the lobby as well as the menu: the two boxes are one setting.
const lobbyName = $<HTMLInputElement>('lobby-name');
lobbyName.addEventListener('input', () => {
  lobbyName.value = lobbyName.value.toUpperCase().replace(/[^A-Z0-9_\- ]/g, '');
  nameInput.value = lobbyName.value;
  store.set(NAME_KEY, nameInput.value);
  room?.net.room.setIdentity(playerName(), colourId, encodeLook(look));
  lobby?.render();
});
$('lobby-colour').addEventListener('change', (e) => {
  colourId = (e.target as HTMLSelectElement).value;
  store.set(COLOUR_KEY, colourId);
  room?.net.room.setIdentity(playerName(), colourId, encodeLook(look));
  lobby?.render();
});
const lobbySettings = (): void => {
  const pick = $<HTMLSelectElement>('lobby-track').value;
  const choice = trackChoice(pick, $<HTMLInputElement>('lobby-seed').value);
  room?.net.configure(
    Number($<HTMLSelectElement>('lobby-cars').value),
    Number($<HTMLSelectElement>('lobby-laps').value),
    choice.seed ? 0 : Number(pick),
    choice.seed,
    Number($<HTMLSelectElement>('lobby-weapons').value),
  );
};
$('lobby-cars').addEventListener('change', lobbySettings);
$('lobby-laps').addEventListener('change', lobbySettings);
$('lobby-track').addEventListener('change', lobbySettings);
$('lobby-weapons').addEventListener('change', lobbySettings);
$('lobby-seed').addEventListener('change', lobbySettings);
// As in the menu, typing a seed switches the room to it; the rest of the room hears when the typing is done.
$('lobby-seed').addEventListener('input', () => {
  const sel = $<HTMLSelectElement>('lobby-track');
  if (sel.value === 'seed') return;
  sel.value = 'seed';
  lobbySettings();
});
$('lobby-seed-random').addEventListener('click', () => {
  $<HTMLInputElement>('lobby-seed').value = randomSeedText();
  $<HTMLSelectElement>('lobby-track').value = 'seed';
  lobbySettings();
});

const brokerSelect = $<HTMLSelectElement>('set-broker');
brokerSelect.replaceChildren(
  ...BROKERS.map((b) => {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.label;
    return o;
  }),
);
/* ------------------------------------------------------------------ sound */

const audio = new AudioEngine();
const syncVolumes = (): void => audio.setVolumes(settings.current.sfxVolume, settings.current.musicVolume);
syncVolumes();
settings.events.on('change', syncVolumes);
// Browsers start audio only from a gesture: the first key, click or touch.
for (const type of ['keydown', 'pointerdown', 'touchstart'] as const) {
  window.addEventListener(type, () => {
    audio.unlock();
    audio.music.play(session ? 'race' : 'menu');
  }, { capture: true, passive: true });
}
// A soft tick as the focus ring moves through the menus.
document.addEventListener('focusin', () => {
  if (!session || session.paused) audio.blip();
});
$('set-ghost').addEventListener('change', (e) => settings.set('ghostLead', Number((e.target as HTMLSelectElement).value)));
$('set-fov').addEventListener('input', (e) => settings.set('fov', Number((e.target as HTMLInputElement).value)));
// The mouse wheel zooms the race camera: down (towards you) widens the view, up
// closes in. It changes the same setting as the slider, so it is kept.
addEventListener('wheel', (e) => {
  if (!session || $('screen-hud').hidden || !$('pause-veil').hidden) return;
  e.preventDefault();
  settings.set('fov', settings.current.fov + Math.sign(e.deltaY) * 2);
}, { passive: false });
$('set-bots').addEventListener('change', (e) => settings.set('botLevel', (e.target as HTMLSelectElement).value as BotLevel));
$('set-names').addEventListener('change', (e) => settings.set('nameTags', (e.target as HTMLSelectElement).value as NameTags));
$('set-sfx').addEventListener('input', (e) => settings.set('sfxVolume', Number((e.target as HTMLInputElement).value)));
$('set-music').addEventListener('input', (e) => settings.set('musicVolume', Number((e.target as HTMLInputElement).value)));

/** Where Settings' Back goes: the menu, or the pause menu of the race it was opened from. */
let settingsFromPause = false;
function openSettings(fromPause: boolean): void {
  settingsFromPause = fromPause;
  $<HTMLSelectElement>('set-quality').value = settings.current.quality === 'potato' ? 'low' : settings.current.quality;
  $<HTMLSelectElement>('set-touch').value = settings.current.touchControls;
  $<HTMLInputElement>('set-vibration').checked = settings.current.vibration;
  $<HTMLInputElement>('set-motion').checked = settings.current.reduceMotion;
  $<HTMLInputElement>('set-autopilot').checked = settings.current.autopilot;
  brokerSelect.value = settings.current.broker;
  $<HTMLInputElement>('set-sfx').value = String(settings.current.sfxVolume);
  $<HTMLSelectElement>('set-ghost').value = String(settings.current.ghostLead);
  $<HTMLSelectElement>('set-names').value = settings.current.nameTags;
  $<HTMLSelectElement>('set-bots').value = settings.current.botLevel;
  $<HTMLInputElement>('set-fov').value = String(settings.current.fov);
  $<HTMLInputElement>('set-music').value = String(settings.current.musicVolume);
  // The race stays where it is underneath: paused offline, held on the brakes online.
  if (fromPause) $('pause-veil').hidden = true;
  show('screen-settings');
}
$('btn-settings').addEventListener('click', () => openSettings(false));
$('btn-pause-settings').addEventListener('click', () => openSettings(true));
$('btn-settings-back').addEventListener('click', () => {
  if (settingsFromPause && session) {
    settingsFromPause = false;
    show('screen-hud');
    openPause();
  } else {
    show('screen-menu');
  }
});
// Settings that can change mid-race take effect at once.
settings.events.on('change', () => {
  // A host's bots take the new level from their next race.
  if (room) room.net.botLevel = settings.current.botLevel;
  if (!session) return;
  session.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
  session.view.rig.baseFov = settings.current.fov;
  if (!params.has('autopilot')) session.autopilot = settings.current.autopilot;
});
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
if (params.has('drive') || params.has('hotlap')) startOffline('hotlap');
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
      audio: AudioEngine;
      readonly garage: Garage | null;
      readonly look: CarLook;
      input: InputManager;
      readonly session: RaceSession | null;
      readonly room: RoomClient | null;
      start: (mode: 'race' | 'hotlap') => void;
      openRoom: (code: string) => Promise<void>;
      leave: () => void;
    };
  }
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
