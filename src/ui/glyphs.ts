/**
 * Button prompts that match the controller in the player's hands.
 *
 * Told apart by the Gamepad API `id`, which carries the USB vendor id on most
 * platforms: 045e is Microsoft, 054c is Sony, 28de is Valve (the Steam Deck's
 * built-in controls). A "Wireless Controller" with no vendor is a DualShock or
 * DualSense on some browsers.
 */
export type PadFamily = 'xbox' | 'playstation' | 'deck' | 'generic' | 'none';

export function padFamily(id: string | null | undefined): PadFamily {
  if (!id) return 'none';
  const s = id.toLowerCase();
  if (s.includes('28de') || s.includes('steam deck') || s.includes('valve')) return 'deck';
  // Xbox before the PlayStation checks: an Xbox pad announces itself as an
  // "Xbox Wireless Controller", and "wireless controller" alone is Sony's name.
  if (s.includes('045e') || s.includes('xbox') || s.includes('xinput')) return 'xbox';
  if (s.includes('054c') || s.includes('dualsense') || s.includes('dualshock') || s.includes('wireless controller') || s.includes('playstation')) return 'playstation';
  return 'generic';
}

export type Action = 'confirm' | 'back' | 'menu' | 'move' | 'throttle' | 'brake' | 'handbrake' | 'turbo' | 'front' | 'rear' | 'steer' | 'prev' | 'next';

const LABELS: Record<Exclude<PadFamily, 'none'>, Record<Action, string>> = {
  xbox: {
    confirm: 'A', back: 'B', menu: '☰ Menu', move: 'D-pad', throttle: 'RT', brake: 'LT', handbrake: 'A',
    turbo: 'B', front: 'RB', rear: 'LB', steer: 'Left stick', prev: 'LB', next: 'RB',
  },
  playstation: {
    confirm: '✕', back: '○', menu: 'Options', move: 'D-pad', throttle: 'R2', brake: 'L2', handbrake: '✕',
    turbo: '○', front: 'R1', rear: 'L1', steer: 'Left stick', prev: 'L1', next: 'R1',
  },
  deck: {
    confirm: 'A', back: 'B', menu: '☰', move: 'D-pad', throttle: 'R2', brake: 'L2', handbrake: 'A',
    turbo: 'B', front: 'R1', rear: 'L1', steer: 'Left stick', prev: 'L1', next: 'R1',
  },
  generic: {
    confirm: 'A', back: 'B', menu: 'Start', move: 'D-pad', throttle: 'RT', brake: 'LT', handbrake: 'A',
    turbo: 'B', front: 'RB', rear: 'LB', steer: 'Left stick', prev: 'LB', next: 'RB',
  },
};

const KEYS: Record<Action, string> = {
  confirm: 'Enter', back: 'Esc', menu: 'Esc', move: 'Arrows', throttle: '↑ / W', brake: '↓ / S', handbrake: 'Space',
  turbo: 'Shift', front: 'Z / J', rear: 'X / K', steer: '← → / A D', prev: '←', next: '→',
};

export function label(action: Action, family: PadFamily): string {
  return family === 'none' ? KEYS[action] : LABELS[family][action];
}

/** Rewrite every `[data-glyph]` element, and the controls lines, for the pad (or keyboard) in use. */
export function applyGlyphs(family: PadFamily): void {
  document.body.dataset.pad = family;
  for (const el of document.querySelectorAll<HTMLElement>('[data-glyph]')) {
    el.textContent = label(el.dataset.glyph as Action, family);
  }
  const line = (id: string): void => {
    const el = document.getElementById(id);
    if (!el) return;
    const l = (a: Action): string => label(a, family);
    el.innerHTML =
      `<b>Drive</b> ${l('throttle')} · <b>Brake</b> ${l('brake')} · <b>Steer</b> ${l('steer')} · ` +
      `<b>Handbrake</b> ${l('handbrake')} · <b>Turbo</b> ${l('turbo')} · ` +
      `<b>Missile</b> ${l('front')} · <b>Mine / rear</b> ${l('rear')} · <b>Menu</b> ${l('menu')}`;
  };
  line('menu-keys');
  line('hud-help');
}
