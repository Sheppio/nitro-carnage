import { GAME_NAME } from './brand.js';
import { SIM } from './config.js';
import type { QualityId } from './config.js';
import { DriveSession } from './DriveSession.js';
import type { HudSnapshot } from './DriveSession.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { DOWNTOWN } from './sim/track/downtown.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { VERSION } from './version.js';

/*
 * Wiring. Everything interesting lives elsewhere; this file only connects the
 * menus to a drive session and exposes a debug handle for the test rig.
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

const screens = ['screen-menu', 'screen-settings', 'screen-hud'] as const;
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

let session: DriveSession | null = null;
let helpTimer = 0;

function startDrive(): void {
  session?.stop();
  const quality = qualityOverride ?? settings.current.quality;
  session = new DriveSession(gameRoot, DOWNTOWN, input, settings, quality, 'vermilion');
  session.onHud = renderHud;
  $('hud-track').textContent = DOWNTOWN.name;
  const help = $('hud-help');
  help.classList.remove('gone');
  clearTimeout(helpTimer);
  helpTimer = window.setTimeout(() => help.classList.add('gone'), 9000);
  show('screen-hud');
  session.start();
}

function leave(): void {
  session?.stop();
  session = null;
  show('screen-menu');
}

let hudTick = 0;
function renderHud(hud: HudSnapshot): void {
  // Text updates at 10 Hz; the turbo bar is a transform and can go every frame.
  $('hud-turbo').style.transform = `scaleX(${Math.max(0, hud.turbo / SIM.car.turboCapacity)})`;
  const now = performance.now();
  if (now - hudTick < 100) return;
  hudTick = now;
  $('hud-speed').textContent = String(Math.round(hud.speedKmh));
  if (params.has('debug')) $('hud-debug').textContent = `${hud.fps.toFixed(0)} fps\n${hud.drawCalls} draws`;
}

$('btn-free-drive').addEventListener('click', startDrive);
$('btn-leave').addEventListener('click', leave);
$('btn-settings').addEventListener('click', () => {
  $<HTMLSelectElement>('set-quality').value = settings.current.quality === 'potato' ? 'low' : settings.current.quality;
  $<HTMLSelectElement>('set-touch').value = settings.current.touchControls;
  $<HTMLInputElement>('set-vibration').checked = settings.current.vibration;
  $<HTMLInputElement>('set-motion').checked = settings.current.reduceMotion;
  show('screen-settings');
});
$('btn-settings-back').addEventListener('click', () => show('screen-menu'));
$('set-quality').addEventListener('change', (e) => settings.set('quality', (e.target as HTMLSelectElement).value as QualityId));
$('set-touch').addEventListener('change', (e) =>
  settings.set('touchControls', (e.target as HTMLSelectElement).value as 'auto' | 'on' | 'off'),
);
$('set-vibration').addEventListener('change', (e) => settings.set('vibration', (e.target as HTMLInputElement).checked));
$('set-motion').addEventListener('change', (e) => settings.set('reduceMotion', (e.target as HTMLInputElement).checked));

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && session) leave();
});

show('screen-menu');
if (params.has('drive')) startDrive();

/** Debug handle for the test rig and the console. Not part of the game. */
declare global {
  interface Window {
    nitro: { settings: SettingsStore; input: InputManager; readonly session: DriveSession | null; startDrive: () => void; leave: () => void };
  }
}
window.nitro = {
  settings,
  input,
  get session() {
    return session;
  },
  startDrive,
  leave,
};
