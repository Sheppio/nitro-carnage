import { Track } from '../sim/track/buildTrack.js';
import { Minimap } from './Minimap.js';
/** How each theme reads on the menu: a name and the map's ground colour. */
const STYLES = {
    dusk: { name: 'City at dusk', ground: '#2b2d3a' },
    park: { name: 'Parkland', ground: '#3f6a34' },
    overcast: { name: 'Docks, overcast', ground: '#5a5e66' },
};
/**
 * The menu's track preview: a little map of the circuit on its theme's
 * ground, and a line on what it is like — so a seed typed in shows its track
 * before anyone drives it. Built bare (no scenery), which is quick enough to
 * redraw on every keystroke.
 */
export function drawTrackPreview(canvas, info, def, label) {
    const track = new Track({ ...def, props: [] });
    const style = STYLES[def.theme] ?? STYLES.dusk;
    canvas.style.background = style.ground;
    new Minimap(canvas, track).draw([]);
    let corners = 0;
    let inCorner = false;
    for (let i = 0; i < track.n; i++) {
        const bend = Math.abs(track.line.curvature[i]) > 1 / 120;
        if (bend && !inCorner)
            corners++;
        inCorner = bend;
    }
    const extras = [
        track.ramps.length ? 'a jump' : '',
        track.rail ? 'a level crossing' : '',
        def.water?.length ? 'water' : '',
        def.surfaces.some((z) => z.surface === 3) ? 'oil' : '',
    ].filter(Boolean);
    info.innerHTML = '';
    const title = document.createElement('b');
    title.textContent = label;
    info.append(title, document.createElement('br'), `${style.name} · ${(track.length / 1000).toFixed(2)} km · ${corners} corners${extras.length ? ` · ${extras.join(', ')}` : ''}`);
}
//# sourceMappingURL=trackPreview.js.map