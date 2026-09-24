import { GAME_NAME } from './brand.js';
import type { QualityId } from './config.js';
import { RaceSession } from './RaceSession.js';
import type { SessionMode } from './RaceSession.js';
import { Hud } from './ui/Hud.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { DOWNTOWN } from './sim/track/downtown.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { VERSION } from './version.js';

/*
 * Wiring. Everything interesting lives elsewhere; this file only connects the
 * menus to a race session and exposes a debug handle for the test rig.
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

const screens = ['screen-menu', 'screen-settings', 'screen-hud', 'screen-results'] as const;
type ScreenId = (typeof screens)[number];

function show(id: ScreenId): void {
  for (const s of screens) $(s).hidden = s !== id;
  if (id === 'screen-hud') {
    nav.stop();
  } else {
    nav.start();
    nav.focusFirst();
  }
}

let session: RaceSession | null = null;
let hud: Hud | null = null;
let helpTimer = 0;
let lastMode: SessionMode = 'race';

/** `?laps=1` shortens races, for tests and for trying things quickly. */
const lapsOverride = Number(params.get('laps')) || 0;

function start(mode: SessionMode): void {
  stopSession();
  lastMode = mode;
  const quality = qualityOverride ?? settings.current.quality;
  session = new RaceSession(
    gameRoot,
    { mode, track: DOWNTOWN, quality, colourId: 'vermilion', bots: 5, laps: lapsOverride || DOWNTOWN.laps },
    input,
    settings,
  );
  if (params.has('autopilot')) session.autopilot = true;
  hud = new Hud(session, params.has('debug'));
  session.onHud = (h) => hud?.update(h);
  session.onEvent = (ev) => hud?.event(ev);
  session.onOver = (rows) => {
    Hud.results(rows);
    stopSession();
    show('screen-results');
  };
  $('hud-track').textContent = DOWNTOWN.name;
  // The controls hint is for free drive; in a race it would sit on the race
  // panel, and the menu already says what the keys are.
  const help = $('hud-help');
  help.hidden = mode === 'race';
  help.classList.remove('gone');
  clearTimeout(helpTimer);
  helpTimer = window.setTimeout(() => help.classList.add('gone'), 9000);
  show('screen-hud');
  session.start();
}

function stopSession(): void {
  session?.stop();
  hud?.dispose();
  session = null;
  hud = null;
}

function leave(): void {
  stopSession();
  show('screen-menu');
}

$('btn-race').addEventListener('click', () => start('race'));
$('btn-free-drive').addEventListener('click', () => start('free'));
$('btn-again').addEventListener('click', () => start(lastMode));
$('btn-results-menu').addEventListener('click', leave);
$('btn-leave').addEventListener('click', leave);
$('btn-settings').addEventListener('click', () => {
  $<HTMLSelectElement>('set-quality').value = settings.current.quality === 'potato' ? 'low' : settings.current.quality;
  $<HTMLSelectElement>('set-touch').value = settings.current.touchControls;
  $<HTMLInputElement>('set-vibration').checked = settings.current.vibration;
  $<HTMLInputElement>('set-motion').checked = settings.current.reduceMotion;
  $<HTMLInputElement>('set-autopilot').checked = settings.current.autopilot;
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

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && session) leave();
});

show('screen-menu');
if (params.has('drive')) start('free');
if (params.has('race')) start('race');

/** Debug handle for the test rig and the console. Not part of the game. */
declare global {
  interface Window {
    nitro: {
      settings: SettingsStore;
      input: InputManager;
      readonly session: RaceSession | null;
      start: (mode: SessionMode) => void;
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
  start,
  leave,
};
