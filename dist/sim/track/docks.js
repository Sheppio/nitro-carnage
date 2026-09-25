import { Surface } from '../surfaces.js';
/**
 * Tidewater Docks — a container port under an overcast sky.
 *
 * Tight right angles through canyons of stacked containers, a flat-out run
 * along the quay with nothing between the road and the harbour, oil where the
 * straddle carriers park, and a railway across the south straight. The train
 * keeps its own timetable and does not stop for anybody.
 */
export const DOCKS = {
    id: 'docks',
    name: 'Tidewater Docks',
    laps: 3,
    seed: 0xd0c45,
    theme: 'overcast',
    corners: [
        [0, 0, 12],
        [156, 0, 12],
        [156, 73, 12],
        [104, 73, 12],
        [104, 114, 12],
        [172, 114, 12],
        [172, 187, 12],
        [31, 187, 12],
        [31, 125, 12],
        [62, 125, 12],
        [62, 83, 12],
        [0, 83, 12],
    ],
    width: 16.25,
    verge: { width: 2, surface: Surface.Kerb },
    walls: true,
    // The quay: the harbour is on the left the whole way along the north straight.
    wallGaps: [{ from: 0.03, to: 0.13, side: 'left' }],
    water: [[-125, -300, 291, -10.5]],
    railway: { from: [90, 146], to: [90, 586], first: 18, period: 42, speed: 18, cars: 5 },
    start: [53, 0],
    checkpoints: [0.25, 0.5, 0.75],
    surfaces: [
        { shape: 'circle', at: [106, 97], r: 3.5, surface: Surface.Oil },
        { shape: 'circle', at: [62, 186], r: 4, surface: Surface.Oil },
        { shape: 'circle', at: [170, 156], r: 3, surface: Surface.Oil },
    ],
    ramps: [],
    props: [
        // A working port (M10): warehouses first, so the container stacks keep off them; yards between the stacks.
        { kind: 'warehouses', count: 4, clearance: 3 },
        { kind: 'containers', area: [-83, 10, 250, 270], clearance: 1.5, stack: 4, gaps: 0.1, yards: 0.2 },
        { kind: 'cranes', at: [[36, -22, 0], [88, -22, 0], [125, -22, 0]] },
        // One ship moored under the crane booms, one off the corner where the quay turns, and a marina off the other
        // corner: where the camera looks. The harbour is north, to the left of these lines, so `out` is negative.
        { kind: 'ships', from: [31, -10.5], to: [135, -10.5], out: -40, count: 1 },
        { kind: 'ships', from: [156, -10.5], to: [239, -10.5], out: -16, count: 1 },
        { kind: 'marina', from: [-57, -10.5], to: [-6, -10.5], out: -6 },
    ],
};
//# sourceMappingURL=docks.js.map