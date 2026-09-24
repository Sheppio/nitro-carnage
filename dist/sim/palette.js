/**
 * Player colours — ported from glitchburst, where colour is *who*.
 *
 * A room holds six and the palette holds ten, so a clash always has somewhere
 * to go, with room to spare for bots.
 *
 * Engine-agnostic and pure — no three, no DOM, no network. The resolver below
 * is the interesting part and is exactly the sort of thing that has to be
 * testable without a browser.
 */
/**
 * Chosen to stay apart from each other at 70 m up, and from the scenery:
 * none of them is the grey of a tower or the green of a park.
 */
export const PALETTE = [
    { id: 'vermilion', name: 'Vermilion', colour: 0xff4d2e, cssColour: '#ff4d2e' },
    { id: 'cyan', name: 'Cyan', colour: 0x00d5ef, cssColour: '#00d5ef' },
    { id: 'amber', name: 'Amber', colour: 0xffb300, cssColour: '#ffb300' },
    { id: 'magenta', name: 'Magenta', colour: 0xff2d95, cssColour: '#ff2d95' },
    { id: 'lime', name: 'Lime', colour: 0x8cf000, cssColour: '#8cf000' },
    { id: 'violet', name: 'Violet', colour: 0x9b5cff, cssColour: '#9b5cff' },
    { id: 'cobalt', name: 'Cobalt', colour: 0x2f6bff, cssColour: '#2f6bff' },
    { id: 'white', name: 'Pearl', colour: 0xf2f0ea, cssColour: '#f2f0ea' },
    { id: 'jade', name: 'Jade', colour: 0x00c07a, cssColour: '#00c07a' },
    { id: 'black', name: 'Onyx', colour: 0x2a2a30, cssColour: '#2a2a30' },
];
export const COLOUR_ORDER = PALETTE.map((c) => c.id);
export const DEFAULT_COLOUR = PALETTE[0].id;
const BY_ID = new Map(PALETTE.map((c) => [c.id, c]));
export function isColourId(value) {
    return BY_ID.has(value);
}
/** Never throws: an unknown id — an older client, a corrupted field — reads as the default. */
export function colourOf(id) {
    return BY_ID.get(id) ?? BY_ID.get(DEFAULT_COLOUR);
}
/**
 * Hand every player in the room a colour nobody else has.
 *
 * There is no server to arbitrate this, so the rule has to be one every client
 * can apply alone and arrive at the same answer — the same constraint the host
 * election works under. Two properties do it:
 *
 *   *Seniority.* Claims are settled in ascending player id, and ids are time
 *   prefixed, so the earliest joiner keeps what they asked for and a newcomer
 *   who picks a taken colour is the one who moves. Nobody's colour changes
 *   under them because somebody else walked in.
 *
 *   *Determinism.* The displaced player takes the next free entry walking
 *   forward from their choice, wrapping. No randomness and no negotiation, so
 *   every client — including the displaced one — computes the same result from
 *   the same roster without a message being sent.
 *
 * The picker greys out colours already spoken for, so in practice this only
 * fires on a genuine race: two people choosing the same colour in the same
 * half-second, before either has seen the other's presence.
 *
 * @returns player id → colour id, for every claim given.
 */
export function resolveColours(claims) {
    const order = [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const taken = new Set();
    const out = {};
    for (const claim of order) {
        const wanted = isColourId(claim.colour) ? claim.colour : DEFAULT_COLOUR;
        let pick = wanted;
        if (taken.has(pick)) {
            const start = COLOUR_ORDER.indexOf(wanted);
            for (let n = 1; n <= COLOUR_ORDER.length; n++) {
                const candidate = COLOUR_ORDER[(start + n) % COLOUR_ORDER.length];
                if (!taken.has(candidate)) {
                    pick = candidate;
                    break;
                }
            }
            // More players than colours cannot happen — the room holds six and the
            // palette holds ten — but if it ever did, a duplicate is a far better
            // outcome than an undefined colour.
        }
        taken.add(pick);
        out[claim.id] = pick;
    }
    return out;
}
//# sourceMappingURL=palette.js.map