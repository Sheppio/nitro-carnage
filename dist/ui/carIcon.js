import { colourOf } from '../sim/palette.js';
/** Plan-view proportions per body: overall length and width, cabin length and offset (fractions). */
const SHAPES = {
    coupe: { w: 0.44, cab: 0.42, cabAt: -0.07 },
    hatch: { w: 0.43, cab: 0.55, cabAt: -0.14 },
    muscle: { w: 0.45, cab: 0.34, cabAt: -0.18 },
    wedge: { w: 0.45, cab: 0.36, cabAt: -0.02 },
    buggy: { w: 0.34, cab: 0.3, cabAt: -0.05 },
};
/**
 * A little plan-view car for the lobby roster: body shape, colour, stripe
 * and number, drawn in 2D. Every roster row redraws on every presence
 * update, and a WebGL context per row would be absurd.
 */
export function carIcon(look, colourId, width = 44, height = 22) {
    const c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = width * dpr;
    c.height = height * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    c.className = 'car-icon';
    c.dataset.body = look.body;
    const g = c.getContext('2d');
    if (!g)
        return c;
    g.scale(dpr, dpr);
    const shape = SHAPES[look.body];
    // Nose to the right.
    const L = width - 4, W = height * (shape.w / 0.45) - 4;
    const x0 = 2, y0 = (height - W) / 2;
    g.fillStyle = colourOf(colourId).cssColour;
    g.beginPath();
    g.roundRect(x0, y0, L, W, look.body === 'wedge' ? [2, 7, 7, 2] : 4);
    g.fill();
    if (look.body === 'buggy') {
        g.fillStyle = '#16171b';
        for (const [fx, fy] of [[0.18, 0], [0.18, 1], [0.8, 0], [0.8, 1]])
            g.fillRect(x0 + L * fx - 3, y0 + (W - 2) * fy - 2, 6, 4);
    }
    // Cabin glass.
    g.fillStyle = 'rgba(20,26,38,0.85)';
    const cl = L * shape.cab;
    g.fillRect(x0 + L / 2 + L * shape.cabAt - cl / 2, y0 + W * 0.18, cl, W * 0.64);
    // Stripes.
    const stripe = colourOf(look.stripe).cssColour;
    g.fillStyle = stripe;
    if (look.pattern === 'twin') {
        g.fillRect(x0, y0 + W * 0.32, L, W * 0.1);
        g.fillRect(x0, y0 + W * 0.58, L, W * 0.1);
    }
    else if (look.pattern === 'offset') {
        g.fillRect(x0, y0 + W * 0.22, L, W * 0.18);
    }
    else if (look.pattern === 'flash') {
        g.fillRect(x0 + L * 0.3, y0, L * 0.5, 2);
        g.fillRect(x0 + L * 0.3, y0 + W - 2, L * 0.5, 2);
    }
    else if (look.pattern === 'chequer') {
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 4; j++)
                if ((i + j) % 2)
                    g.fillRect(x0 + L * 0.72 + i * (L * 0.08), y0 + j * (W / 4), L * 0.08, W / 4);
    }
    return c;
}
//# sourceMappingURL=carIcon.js.map