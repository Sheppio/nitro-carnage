/**
 * What the tyres are on.
 *
 * One table, read by the car physics per axle. Grip is a multiplier on the
 * car's tarmac friction; drag is extra rolling resistance, which is what makes
 * grass *slow* you rather than merely slide you — otherwise cutting a corner
 * across the lawn would be free.
 */
export var Surface;
(function (Surface) {
    Surface[Surface["Tarmac"] = 0] = "Tarmac";
    Surface[Surface["Dirt"] = 1] = "Dirt";
    Surface[Surface["Grass"] = 2] = "Grass";
    Surface[Surface["Oil"] = 3] = "Oil";
    /** Kerbs and pavements: tarmac grip, a touch of drag. */
    Surface[Surface["Kerb"] = 4] = "Kerb";
    /** Off the quay (M5). Nothing to drive on: a car in it is put back on the road. */
    Surface[Surface["Water"] = 5] = "Water";
})(Surface || (Surface = {}));
export const SURFACES = {
    [Surface.Tarmac]: { name: 'tarmac', grip: 1.0, drag: 0 },
    [Surface.Dirt]: { name: 'dirt', grip: 0.7, drag: 1.2 },
    [Surface.Grass]: { name: 'grass', grip: 0.55, drag: 3.0 },
    [Surface.Oil]: { name: 'oil', grip: 0.18, drag: 0 },
    [Surface.Kerb]: { name: 'kerb', grip: 0.95, drag: 0.3 },
    [Surface.Water]: { name: 'water', grip: 0.1, drag: 12 },
};
//# sourceMappingURL=surfaces.js.map