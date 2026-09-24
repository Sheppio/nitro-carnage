export const THEMES = {
    dusk: {
        sky: 0x2a2440,
        fog: 0x3a2f52,
        ground: 0x2b2d3a,
        road: 0x3b3d48,
        pavement: 0x6f6d78,
        kerbA: 0xe8e4dc,
        kerbB: 0xd6394a,
        line: 0xf2eee6,
        barrierA: 0xb8b4ae,
        barrierB: 0xf0b429,
        towerPalette: [0x5a6078, 0x6e6a86, 0x4c5a6e, 0x7a6f7e, 0x55627a, 0x837b8f, 0x4a4f63],
        roof: 0x353848,
        windowWarm: 0xffc873,
        windowCool: 0x8fd8ff,
        windowsLit: 0.42,
        hemiSky: 0x9a8cc8,
        hemiGround: 0x2a2233,
        hemiIntensity: 1.25,
        sun: 0xffb27a,
        sunIntensity: 2.1,
        sunAzimuth: 235,
        sunElevation: 38,
    },
};
export function themeFor(id) {
    return THEMES[id] ?? THEMES.dusk;
}
//# sourceMappingURL=themes.js.map