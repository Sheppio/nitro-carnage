export function padFamily(id) {
    if (!id)
        return 'none';
    const s = id.toLowerCase();
    if (s.includes('28de') || s.includes('steam deck') || s.includes('valve'))
        return 'deck';
    // Xbox before the PlayStation checks: an Xbox pad announces itself as an
    // "Xbox Wireless Controller", and "wireless controller" alone is Sony's name.
    if (s.includes('045e') || s.includes('xbox') || s.includes('xinput'))
        return 'xbox';
    if (s.includes('054c') || s.includes('dualsense') || s.includes('dualshock') || s.includes('wireless controller') || s.includes('playstation'))
        return 'playstation';
    return 'generic';
}
const LABELS = {
    xbox: {
        confirm: 'A', back: 'B', menu: '☰ Menu', move: 'D-pad', throttle: 'RT', brake: 'LT', handbrake: 'A',
        turbo: 'B', front: 'RB', rear: 'LB', steer: 'Left stick',
    },
    playstation: {
        confirm: '✕', back: '○', menu: 'Options', move: 'D-pad', throttle: 'R2', brake: 'L2', handbrake: '✕',
        turbo: '○', front: 'R1', rear: 'L1', steer: 'Left stick',
    },
    deck: {
        confirm: 'A', back: 'B', menu: '☰', move: 'D-pad', throttle: 'R2', brake: 'L2', handbrake: 'A',
        turbo: 'B', front: 'R1', rear: 'L1', steer: 'Left stick',
    },
    generic: {
        confirm: 'A', back: 'B', menu: 'Start', move: 'D-pad', throttle: 'RT', brake: 'LT', handbrake: 'A',
        turbo: 'B', front: 'RB', rear: 'LB', steer: 'Left stick',
    },
};
const KEYS = {
    confirm: 'Enter', back: 'Esc', menu: 'Esc', move: 'Arrows', throttle: '↑ / W', brake: '↓ / S', handbrake: 'Space',
    turbo: 'Shift', front: 'Z / J', rear: 'X / K', steer: '← → / A D',
};
export function label(action, family) {
    return family === 'none' ? KEYS[action] : LABELS[family][action];
}
/** Rewrite every `[data-glyph]` element, and the controls lines, for the pad (or keyboard) in use. */
export function applyGlyphs(family) {
    document.body.dataset.pad = family;
    for (const el of document.querySelectorAll('[data-glyph]')) {
        el.textContent = label(el.dataset.glyph, family);
    }
    const line = (id) => {
        const el = document.getElementById(id);
        if (!el)
            return;
        const l = (a) => label(a, family);
        el.innerHTML =
            `<b>Drive</b> ${l('throttle')} · <b>Brake</b> ${l('brake')} · <b>Steer</b> ${l('steer')} · ` +
                `<b>Handbrake</b> ${l('handbrake')} · <b>Turbo</b> ${l('turbo')} · ` +
                `<b>Missile</b> ${l('front')} · <b>Mine / rear</b> ${l('rear')} · <b>Menu</b> ${l('menu')}`;
    };
    line('menu-keys');
    line('hud-help');
}
//# sourceMappingURL=glyphs.js.map