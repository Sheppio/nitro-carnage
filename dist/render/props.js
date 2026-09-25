import { mulberry32 } from '../util.js';
import { MeshBuilder } from './geometry.js';
/**
 * The scenery models of M10: farm and port, all low-poly, all built in code
 * from boxes, frusta and extruded outlines, vertex-coloured, with no
 * textures. Each model stands on the ground at its origin and faces +Z.
 *
 * Most come in a few variants (a red barn or a grey one, a green tractor or
 * a red one); a variant is a whole model of its own, cached, so a hundred
 * cows are a handful of geometries baked many times over.
 */
const TAU = Math.PI * 2;
const TYRE = 0x1f2024;
const GLASS = 0x2f3d4c;
const STEEL = 0x3a3c42;
/** A wheel on its side, axle along X. */
function wheel(b, x, y, z, r, w, hub = 0x8a8c90) {
    b.at(x, y, z, 0, Math.PI / 2, (w2) => {
        w2.cylinder(0, 0, 0, r, r, w, 10, TYRE);
        w2.cylinder(0, 0, 0, r * 0.45, r * 0.45, w + 0.04, 6, hub);
    });
}
/** A gable roof over a w x d plan, the ridge along Z. */
function gable(b, y, w, d, rise, hex) {
    b.box(0, y + rise / 2, 0, w, rise, d, hex, { insetX: w / 2, skipBottom: true });
}
/**
 * A hull, bow to +Z: a square stern and a pointed bow, `bow` of its length.
 * The outline runs counter-clockwise on screen, the order `prism` wants.
 */
function hull(b, beam, len, y0, y1, side, deck, bow = 0.18) {
    const hb = beam / 2, hl = len / 2, zb = hl - len * bow;
    b.prism([[-hb, -hl], [-hb, zb], [0, hl], [hb, zb], [hb, -hl]], y0, y1, side, { top: deck });
}
const MODELS = {
    /* ------------------------------------------------------------ the farm */
    farmhouse(b, v) {
        const wall = [0xefe6d2, 0xf4f1ea, 0xb86a4a][v % 3];
        const roof = [0x7a3b2e, 0x4a4e58, 0x6a4a3a][v % 3];
        b.box(0, 3, 0, 9, 6, 11, wall, { skipBottom: true });
        gable(b, 6, 10, 12, 3.6, roof);
        b.box(-2.5, 8.2, -2.5, 0.9, 3, 0.9, 0x8a5a4a);
        // Door and windows on the front (+X, the long side faces the yard).
        b.box(4.53, 1.1, 0, 0.08, 2.2, 1.2, 0x5a3a2a);
        for (const z of [-3.2, 3.2])
            for (const y of [1.8, 4.3])
                b.box(4.53, y, z, 0.08, 1.2, 1.1, GLASS);
        for (const z of [-3.2, 0, 3.2])
            b.box(-4.53, 4.3, z, 0.08, 1.2, 1.1, GLASS);
        // A porch roof over the door.
        b.box(5.4, 2.7, 0, 1.8, 0.2, 3.2, roof);
    },
    barn(b, v) {
        const wall = [0xa8322a, 0x6a7a6a, 0x8a6a4a][v % 3];
        const roof = [0x4a4e58, 0x7a3b2e, 0x5a5e66][v % 3];
        b.box(0, 3.5, 0, 12, 7, 20, wall, { skipBottom: true });
        gable(b, 7, 13, 21, 5, roof);
        // Big white-framed doors on the end, and the hay loft above.
        b.box(0, 2.6, 10.03, 5.4, 5.2, 0.1, 0xf0ece0);
        b.box(0, 2.5, 10.08, 4.6, 4.8, 0.1, wall === 0xa8322a ? 0x7a2420 : 0x4a4a44);
        b.box(0, 8.4, 10.03, 2, 1.8, 0.1, 0xf0ece0);
        // A lean-to shed down one side.
        b.box(8.5, 2, 2, 5, 4, 12, wall, { skipBottom: true });
        b.box(8.7, 4.25, 2, 5.6, 0.35, 12.6, roof);
    },
    silo(b, v) {
        const metal = [0xc8ccd0, 0x6a8aa8, 0xb8a888][v % 3];
        b.cylinder(0, 8, 0, 3, 3, 16, 12, metal, { skipBottom: true });
        b.cylinder(0, 17.1, 0, 3.15, 0.5, 2.2, 12, 0xa8acb2);
        // Bands, and a ladder cage up the side.
        for (const y of [4, 8, 12])
            b.cylinder(0, y, 0, 3.08, 3.08, 0.25, 12, 0x8a8e94, { skipBottom: true });
        b.box(0, 8.5, 3.15, 0.6, 16, 0.2, 0x4a4c52);
    },
    /** A round hay bale, lying on its side. */
    bale(b, v) {
        const straw = [0xd9b44a, 0xc9a43e, 0xe0bf5a][v % 3];
        b.at(0, 0.8, 0, 0, Math.PI / 2, (w) => w.cylinder(0, 0, 0, 0.8, 0.8, 1.2, 10, straw, { top: 0xe8cc78 }));
    },
    /** A stack of square bales. */
    bales(b, v) {
        const straw = [0xd9b44a, 0xe0bf5a][v % 2];
        for (let row = 0; row < 3; row++) {
            for (let k = 0; k < 3 - row; k++)
                b.box((k - (2 - row) / 2) * 1.25, 0.28 + row * 0.56, 0, 1.2, 0.55, 2.4, straw, { top: 0xe8cc78 });
        }
    },
    tractor(b, v) {
        const paint = [0x3a8a3a, 0xc0302a, 0x2f5fa8][v % 3];
        b.box(0, 1.25, 0.6, 1.1, 0.9, 2.3, paint, { skipBottom: true, insetZFront: 0.2 });
        b.box(0, 2.15, -0.75, 1.5, 1.3, 1.4, GLASS, { top: paint, skipBottom: true });
        b.box(0, 2.85, -0.75, 1.7, 0.1, 1.6, paint);
        b.box(0, 1.1, -0.9, 1.2, 0.6, 1.6, paint, { skipBottom: true });
        b.box(0.35, 2.3, 1.3, 0.1, 1, 0.1, STEEL);
        wheel(b, 0.95, 0.85, -0.8, 0.85, 0.5);
        wheel(b, -0.95, 0.85, -0.8, 0.85, 0.5);
        wheel(b, 0.75, 0.5, 1.3, 0.5, 0.35);
        wheel(b, -0.75, 0.5, 1.3, 0.5, 0.35);
    },
    combine(b, v) {
        const paint = [0x3f8a3a, 0xc03a2a][v % 2];
        b.box(0, 2.3, -0.4, 3.2, 2.8, 6, paint, { skipBottom: true });
        b.box(0, 4.2, -1.2, 2.6, 1.2, 3.2, paint, { top: 0x2f6a2a });
        b.box(0, 4.3, 2, 2, 1.6, 1.8, GLASS, { top: paint, skipBottom: true });
        // The header across the front, with its reel.
        b.box(0, 1, 4.2, 7.2, 0.9, 1.8, 0xd8b030, { skipBottom: true });
        b.at(0, 1.9, 4.6, 0, Math.PI / 2, (w) => w.cylinder(0, 0, 0, 0.5, 0.5, 6.8, 6, 0xc02a22));
        // The unloading auger, folded along the side.
        b.box(1.9, 4.6, -1.2, 0.35, 0.35, 5, paint);
        wheel(b, 1.75, 1.1, 1.3, 1.1, 0.7);
        wheel(b, -1.75, 1.1, 1.3, 1.1, 0.7);
        wheel(b, 1.45, 0.6, -2.8, 0.6, 0.45);
        wheel(b, -1.45, 0.6, -2.8, 0.6, 0.45);
    },
    /** Variant 0-2 standing, 3-5 grazing, head down. */
    cow(b, v) {
        const coat = [0xf2f0ea, 0x7a4a2a, 0x2a2a2a][v % 3];
        const grazing = v >= 3;
        b.box(0, 1.05, 0, 0.72, 0.7, 1.6, coat, { skipBottom: true });
        if (coat === 0xf2f0ea) {
            b.box(0.12, 1.405, 0.2, 0.42, 0.02, 0.55, 0x1e1e1e);
            b.box(-0.2, 1.405, -0.45, 0.3, 0.02, 0.4, 0x1e1e1e);
        }
        b.box(0, grazing ? 0.62 : 1.25, 1.0, 0.36, 0.42, 0.52, coat === 0x2a2a2a ? 0x3a3a3a : 0x5a3a2a, { skipBottom: true });
        for (const [x, z] of [[0.24, 0.62], [-0.24, 0.62], [0.24, -0.62], [-0.24, -0.62]])
            b.box(x, 0.36, z, 0.16, 0.72, 0.16, coat, { skipBottom: true });
    },
    sheep(b, v) {
        const grazing = v % 2 === 1;
        b.box(0, 0.72, 0, 0.72, 0.56, 1.0, 0xeeeae0, { skipBottom: true, insetX: 0.08, insetZFront: 0.08, insetZBack: 0.08 });
        b.box(0, grazing ? 0.42 : 0.82, 0.6, 0.28, 0.32, 0.36, 0x2a2826, { skipBottom: true });
        for (const [x, z] of [[0.2, 0.34], [-0.2, 0.34], [0.2, -0.34], [-0.2, -0.34]])
            b.box(x, 0.24, z, 0.11, 0.48, 0.11, 0x2a2826, { skipBottom: true });
    },
    /** A tower windmill, its sails turning at the hub (see SAILS). */
    windmill(b) {
        b.cylinder(0, 7, 0, 4.2, 2.7, 14, 8, 0xeee8da, { skipBottom: true });
        b.cylinder(0, 5.2, 0, 5.2, 5.2, 0.35, 8, 0x6a5040);
        b.cylinder(0, 15.3, 0, 3, 0.6, 2.8, 8, 0x5a4636);
        b.box(0, 1.2, 4.1, 1.2, 2.4, 0.3, 0x5a3a2a);
        b.box(0, 15, 2.6, 0.7, 0.7, 1.4, 0x4a3828);
    },
    /* ------------------------------------------------------------ the port */
    forklift(b, v) {
        const paint = [0xf0b020, 0xe06a20, 0xd8d4cc][v % 3];
        b.box(0, 0.85, -0.1, 1.2, 1, 2, paint, { skipBottom: true });
        b.box(0, 0.9, -1.25, 1.2, 1.1, 0.5, STEEL, { skipBottom: true });
        b.box(0, 2.2, -0.2, 1.15, 0.08, 1.3, 0x2a2a2a);
        for (const [x, z] of [[0.52, 0.4], [-0.52, 0.4], [0.52, -0.8], [-0.52, -0.8]])
            b.box(x, 1.75, z, 0.07, 0.9, 0.07, 0x2a2a2a);
        for (const x of [0.36, -0.36]) {
            b.box(x, 1.45, 1.0, 0.12, 2.7, 0.14, STEEL);
            b.box(x, 0.12, 1.6, 0.12, 0.06, 1.1, 0x6a6a6a);
        }
        wheel(b, 0.55, 0.35, 0.6, 0.35, 0.3);
        wheel(b, -0.55, 0.35, 0.6, 0.35, 0.3);
        wheel(b, 0.55, 0.3, -0.9, 0.3, 0.26);
        wheel(b, -0.55, 0.3, -0.9, 0.3, 0.26);
    },
    /** Variants: cab colour, and an empty bed, a container or a load of crates. */
    flatbed(b, v) {
        const cab = [0xd8d4cc, 0x2f6fa8, 0xc0302a, 0x3a8a4a][v % 4];
        b.box(0, 1.75, 4.1, 2.4, 2.3, 2.2, cab, { skipBottom: true });
        b.box(0, 2.3, 5.22, 2.1, 0.8, 0.05, GLASS);
        b.box(0, 0.85, -0.6, 2.2, 0.35, 9.2, 0x2a2a2a, { skipBottom: true });
        b.box(0, 1.15, -1, 2.5, 0.25, 8, 0x6a6e76);
        const load = Math.floor(v / 4) % 3;
        if (load === 1)
            b.box(0, 2.6, -1, 2.4, 2.6, 6.1, [0xb8412f, 0x2f6fa8, 0x3f8a5a][v % 3], { skipBottom: true, sides: 0x8a8a8a });
        if (load === 2)
            for (const z of [-3.5, -1.5, 0.5])
                b.box(0, 1.8, z, 1.8, 1.1, 1.6, 0xa87a48, { skipBottom: true, top: 0xc0945e });
        for (const z of [4, -2.5, -4])
            for (const x of [1.15, -1.15])
                wheel(b, x, 0.5, z, 0.5, 0.35);
    },
    /** A stack of 1-4 pallets. */
    pallets(b, v) {
        const n = 1 + (v % 4);
        for (let k = 0; k < n; k++)
            b.box(0, 0.075 + k * 0.15, 0, 1.2, 0.14, 1.0, 0xb08a58, { skipBottom: true, sides: 0x7a5a38 });
    },
    /** A crate, or two stacked. */
    crates(b, v) {
        const s = [1.1, 1.4][v % 2];
        const wood = [0xa87a48, 0x9a6e40, 0xb88a54][v % 3];
        b.box(0, s / 2, 0, s, s, s, wood, { skipBottom: true, top: 0xc0945e });
        b.box(0, s / 2, 0, s + 0.04, 0.12, s + 0.04, 0x6a4a2a, { skipBottom: true });
        if (v >= 3)
            b.at(0.1, s, 0.05, 0.4, 0, (w) => w.box(0, 0.45, 0, 0.9, 0.9, 0.9, wood, { skipBottom: true, top: 0xc0945e }));
    },
    /** Oil drums on a pallet, 4 to 9 of them. */
    drums(b, v) {
        const paint = [0x2f5fa8, 0xc0302a, 0xe0b020, 0x2a2a2a, 0x3a8a4a][v % 5];
        const n = 4 + (v % 6);
        b.box(0, 0.075, 0, 2.0, 0.14, 1.9, 0xb08a58, { skipBottom: true });
        for (let k = 0; k < n; k++) {
            const x = ((k % 3) - 1) * 0.64, z = (Math.floor(k / 3) - 1) * 0.62;
            b.cylinder(x, 0.6, z, 0.3, 0.3, 0.9, 6, paint, { skipBottom: true, top: 0x5a5c60 });
            b.cylinder(x, 0.45, z, 0.32, 0.32, 0.06, 6, 0x3a3a3a, { skipBottom: true });
        }
    },
    /** A mooring bollard. */
    bollard(b) {
        b.cylinder(0, 0.4, 0, 0.3, 0.26, 0.8, 8, 0x2a2a2e, { skipBottom: true });
    },
    /**
     * Cargo ships, 130-170 m, bow to +Z. Container ships carry stacks in bays
     * the length of the deck; bulk carriers (every third variant) have hatch
     * covers and deck cranes. The bridge is aft, as on the real thing.
     */
    ship(b, v) {
        const rand = mulberry32(0x5417 + v * 101);
        const len = 130 + (v % 3) * 20;
        const beam = 22 + (v % 2) * 4;
        const paint = [0x2a3a5a, 0x8a2a2a, 0x262628, 0x2f4a3a][v % 4];
        hull(b, beam, len, 0, 7, paint, 0x5a5e5a, 0.14);
        hull(b, beam + 0.3, len * 0.998, 0, 1.2, 0x9a2a24, 0x9a2a24, 0.14);
        const bridgeZ = -len / 2 + 10;
        b.box(0, 13, bridgeZ, beam * 0.8, 12, 9, 0xf0ece4, { skipBottom: true });
        b.box(0, 18.2, bridgeZ + 3.6, beam * 1.02, 1.6, 2.4, 0xf0ece4);
        b.box(0, 17.6, bridgeZ + 4.55, beam * 0.78, 1.1, 0.1, GLASS);
        b.box(0, 22, bridgeZ - 3.5, 4, 6, 4, [0xd8a030, 0xf0ece4, 0xc0302a][v % 3], { skipBottom: true, top: 0x1a1a1a });
        const bulk = v % 3 === 2;
        const bays = Math.floor((len - 40) / 13);
        const containers = [0xb8412f, 0x2f6fa8, 0xd9a13b, 0x3f8a5a, 0x8a8f96, 0xd8d4c8, 0x6a3a7a, 0x2f8f8a];
        for (let k = 0; k < bays; k++) {
            const z = bridgeZ + 11 + k * 13 + 6.5;
            if (bulk) {
                b.box(0, 7.8, z, beam * 0.7, 1.6, 10, 0x6a2a24, { skipBottom: true, top: 0x7a3a2a });
                if (k % 3 === 1) {
                    b.box(beam * 0.3, 11, z + 6.5, 0.8, 8, 0.8, 0xd8b030);
                    b.at(beam * 0.3, 14.5, z + 6.5, 0.8, 0, (w) => w.box(0, 0, 6, 0.6, 0.6, 14, 0xd8b030));
                }
                continue;
            }
            const across = Math.floor(beam / 2.5);
            for (let c = 0; c < across; c++) {
                const tiers = 1 + Math.floor(rand() * 4);
                const x = (c - (across - 1) / 2) * 2.5;
                for (let t = 0; t < tiers; t++) {
                    b.box(x, 7 + 1.3 + t * 2.6, z, 2.4, 2.58, 12.2, containers[Math.floor(rand() * containers.length)], { skipBottom: true, sides: 0xa0a0a0 });
                }
            }
        }
    },
    /** Yachts, 9-15 m: a sloop with a mast (even variants) or a motor cruiser. */
    yacht(b, v) {
        const len = 9 + (v % 4) * 2;
        const beam = len * 0.32;
        const stripe = [0x1f3a6a, 0xc0302a, 0x2f8f8a, 0x3a3a3a][v % 4];
        hull(b, beam, len, 0, 1.3, 0xf4f2ec, 0xb08a58, 0.3);
        hull(b, beam + 0.05, len * 0.99, 0.9, 1.05, stripe, stripe, 0.3);
        if (v % 2 === 0) {
            b.box(0, 1.8, -len * 0.08, beam * 0.55, 0.9, len * 0.36, 0xf4f2ec, { skipBottom: true, insetX: 0.2 });
            b.box(0, 8.5, len * 0.12, 0.16, 14, 0.16, 0xd8d8d8);
            b.box(0, 2.6, -len * 0.12, 0.12, 0.12, len * 0.45, 0xd8d8d8);
        }
        else {
            b.box(0, 2, -len * 0.05, beam * 0.7, 1.4, len * 0.5, 0xf4f2ec, { skipBottom: true, insetX: 0.25 });
            b.box(0, 1.9, -len * 0.05 + len * 0.25, beam * 0.6, 0.6, 0.06, GLASS);
            b.box(0, 3.1, -len * 0.12, beam * 0.5, 0.7, len * 0.28, 0xf4f2ec, { skipBottom: true, insetX: 0.15 });
        }
    },
    /** A pontoon: a 2 m wooden walkway, 1 m long, to be stretched. */
    pontoon(b) {
        b.box(0, 0.35, 0, 2, 0.3, 1, 0xa8845a, { skipBottom: true, sides: 0x6a5a48 });
    },
    /** Reeds at a pond's edge: a clump of thin stems. */
    reeds(b, v) {
        const rand = mulberry32(0x7eed + v);
        for (let k = 0; k < 7; k++) {
            const a = rand() * TAU, r = rand() * 0.8, h = 1 + rand() * 0.9;
            b.box(Math.cos(a) * r, h / 2, Math.sin(a) * r, 0.08, h, 0.08, rand() < 0.3 ? 0x8a7a3a : 0x4a7a32, { skipBottom: true });
        }
    },
};
const cache = new Map();
/** The geometry of one model variant, built once. */
export function model(kind, variant = 0) {
    const key = `${kind}:${variant}`;
    let g = cache.get(key);
    if (!g) {
        const build = MODELS[kind];
        if (!build)
            throw new Error(`no model "${kind}"`);
        const b = new MeshBuilder();
        build(b, variant);
        g = b.build();
        cache.set(key, g);
    }
    return g;
}
/** The windmill's four sails, as a separate model turning about its hub (+Z is the way it faces). */
export function sailsModel() {
    const b = new MeshBuilder();
    for (let k = 0; k < 4; k++) {
        b.at(0, 0, 0, 0, (k * Math.PI) / 2, (w) => {
            // The whip, and the sail cloth on its frame: wide enough to read from above.
            w.box(0, 5.6, 0, 0.32, 11.2, 0.32, 0x4a3828);
            w.box(1.3, 6.6, 0.05, 2.4, 8.8, 0.12, 0xf2ece0);
            w.box(1.3, 6.6, 0.12, 2.5, 0.18, 0.1, 0x6a5040);
            w.box(2.5, 6.6, 0.12, 0.14, 8.8, 0.1, 0x6a5040);
        });
    }
    return b.build();
}
/**
 * A field: a crop on a w x d patch, built for its own size. `crop` 0 is
 * maize (tall green rows), 1 wheat (gold, in stripes), 2 ploughed (brown
 * ridges), 3 cut (stubble, lighter stripes). Returns the ground part and the
 * standing part separately: the ground is laid flat under everything else.
 */
export function fieldModel(w, d, crop) {
    const g = new MeshBuilder();
    const s = new MeshBuilder();
    const base = [0x5a4a2a, 0xc9a43e, 0x6a4a30, 0xb8a060][crop];
    g.box(0, 0.02, 0, w, 0.04, d, base, { skipBottom: true });
    const rows = Math.floor(w / 1.6);
    for (let k = 0; k < rows; k++) {
        const x = -w / 2 + 0.8 + k * 1.6;
        if (crop === 0)
            s.box(x, 1.1, 0, 0.9, 2.2, d - 1.2, k % 2 ? 0x5a8a2e : 0x4f7e2a, { skipBottom: true, top: 0x9aa040 });
        else if (crop === 1)
            g.box(x, 0.05, 0, 0.8, 0.06, d, k % 2 ? 0xd9b44a : 0xc49a36, { skipBottom: true });
        else if (crop === 2)
            s.box(x, 0.12, 0, 0.7, 0.24, d - 0.4, 0x7a5638, { skipBottom: true, insetX: 0.25 });
        else
            g.box(x, 0.05, 0, 0.8, 0.06, d, k % 2 ? 0xd0bc78 : 0xa89050, { skipBottom: true });
    }
    return { ground: g.build(), standing: s.triangles ? s.build() : null };
}
/** A flower bed along the road: soil and a double row of blooms, built for its length. */
export function flowerBedModel(len, seed) {
    const rand = mulberry32(0xf10e + Math.floor(seed * 1e6));
    const g = new MeshBuilder().box(0, 0.03, 0, 2.4, 0.06, len, 0x4a3424, { skipBottom: true });
    const s = new MeshBuilder();
    // One colour per bed, or a mix.
    const colours = [0xe8394a, 0xf2c230, 0x9a5ad8, 0xf4f0f0, 0xf07ab0, 0xf08a30];
    const mixed = rand() < 0.4;
    const one = colours[Math.floor(rand() * colours.length)];
    for (let z = -len / 2 + 0.5; z < len / 2 - 0.3; z += 0.7) {
        for (const x of [-0.55, 0.55]) {
            const jx = x + (rand() - 0.5) * 0.25, jz = z + (rand() - 0.5) * 0.2;
            s.box(jx, 0.18, jz, 0.42, 0.36, 0.42, 0x3f7a32, { skipBottom: true });
            s.box(jx, 0.44, jz, 0.3, 0.18, 0.3, mixed ? colours[Math.floor(rand() * colours.length)] : one, { skipBottom: true });
        }
    }
    return { ground: g.build(), standing: s.build() };
}
/** A paddock fence round a w x d rectangle: posts every 3 m and two rails, a gap for the gate. */
export function fenceModel(w, d) {
    const b = new MeshBuilder();
    const wood = 0x8a6a48;
    const side = (x0, z0, x1, z1, gate) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const yaw = Math.atan2(x1 - x0, z1 - z0);
        b.at(x0, 0, z0, yaw, 0, (f) => {
            const posts = Math.max(1, Math.round(len / 3));
            for (let k = 0; k <= posts; k++)
                f.box(0, 0.6, (k * len) / posts, 0.14, 1.2, 0.14, wood, { skipBottom: true });
            const railLen = gate ? len / 2 - 2 : len;
            for (const y of [0.55, 1.0]) {
                f.box(0, y, railLen / 2, 0.06, 0.08, railLen, wood);
                if (gate)
                    f.box(0, y, len - railLen / 2, 0.06, 0.08, railLen, wood);
            }
        });
    };
    const hw = w / 2, hd = d / 2;
    side(-hw, -hd, hw, -hd, false);
    side(hw, -hd, hw, hd, false);
    side(hw, hd, -hw, hd, true);
    side(-hw, hd, -hw, -hd, false);
    return b.build();
}
/** A warehouse, w x d x h, doors down its +Z side: corrugated walls, a low pitched roof. */
export function warehouseModel(w, d, h, v) {
    const b = new MeshBuilder();
    const wall = [0x8a9aa8, 0xb8a88a, 0x6a7a8a, 0xa8584a, 0xc8c4bc][v % 5];
    const rib = [0x7a8a98, 0xa8987a, 0x5a6a7a, 0x98483a, 0xb8b4ac][v % 5];
    b.box(0, h / 2, 0, w, h, d, wall, { skipBottom: true });
    // A low pitch, the ridge along the length.
    b.at(0, 0, 0, Math.PI / 2, 0, (r) => gable(r, h, d + 0.8, w + 0.8, 2.2, 0x5a5e66));
    // Ribs down the long walls: corrugation read from above as stripes.
    for (let x = -w / 2 + 1.5; x < w / 2; x += 3) {
        for (const z of [d / 2 + 0.06, -d / 2 - 0.06])
            b.box(x, h / 2, z, 0.35, h - 0.3, 0.12, rib);
    }
    // Roller doors and a painted band.
    const doors = Math.max(1, Math.floor(w / 14));
    for (let k = 0; k < doors; k++) {
        const x = (k - (doors - 1) / 2) * (w / doors);
        b.box(x, 2.9, d / 2 + 0.14, 5, 5.8, 0.1, 0x5a5e66);
        b.box(x, 6.3, d / 2 + 0.14, 5.6, 0.5, 0.1, 0xe0b020);
    }
    b.box(0, h - 1, d / 2 + 0.1, w * 0.9, 1.2, 0.1, [0x2f6fa8, 0xc0302a, 0x3f8a5a][v % 3]);
    return b.build();
}
/** A pond: open water in a ring of muddy bank, as flat discs. */
export function pondModel(r) {
    const bank = new MeshBuilder().cylinder(0, 0.02, 0, r + 1.6, r + 1.6, 0.04, 18, 0x6a5a3a, { skipBottom: true, top: 0x6a5a3a }).build();
    const water = new MeshBuilder().cylinder(0, 0.05, 0, r, r, 0.04, 18, 0xffffff, { skipBottom: true }).build();
    return { bank, water };
}
//# sourceMappingURL=props.js.map