/**
 * Global tunables. Plain data only — no three, no DOM — so the simulation and
 * its Node tests read exactly the numbers the game plays with.
 *
 * Units throughout: metres, seconds, kilograms, radians.
 */
/** The simulation's fixed step. Rendering interpolates between steps. */
export const STEP = 1 / 60;
export const SIM = {
    gravity: 20,
    car: {
        mass: 1100,
        /** Yaw moment of inertia. */
        inertia: 1650,
        /** Centre of mass to front / rear axle. */
        cgToFront: 1.25,
        cgToRear: 1.3,
        /** Half-length of the collision capsule's core, and its radius: 4.4 m x 2.0 m overall. */
        capsuleHalf: 1.2,
        radius: 1.0,
        /** Cornering stiffness per axle, N/rad. */
        stiffnessFront: 60000,
        stiffnessRear: 66000,
        /** Base tyre friction on tarmac; surfaces and the tyre upgrade scale it. */
        grip: 1.45,
        /** Peak engine force at standstill, and the speed it tapers to nothing at. */
        engineForce: 9800,
        /** Share of the drive force at the rear axle. */
        driveRear: 0.6,
        topSpeed: 51,
        reverseForce: 4200,
        reverseTopSpeed: 12,
        brakeForce: 16000,
        /** Off-throttle engine braking plus rolling resistance, as a deceleration. */
        coastDecel: 0.9,
        /** Quadratic drag coefficient, N per (m/s)^2. */
        drag: 0.9,
        /** Steering lock at a standstill; it tightens with speed (see `steerLimit`). */
        maxSteer: 0.6,
        /** Speed at which steering lock has halved. */
        steerHalfSpeed: 22,
        /** Wheel angle slew rate, rad/s — the physical rack, not input smoothing. */
        steerRate: 5,
        /** How much the front wheels follow the direction of travel in a slide. */
        counterSteer: 0.55,
        /** Body slip an ordinary corner produces; the assist ignores slip up to here. */
        assistSlip: 0.12,
        /** Rear grip relative to base. Above the front bias is stable, below it is loose. */
        rearGripBias: 1.06,
        /** Front grip relative to base: how much steering the car takes before it pushes wide. */
        frontGripBias: 1.05,
        /** Downforce, N per (m/s)^2, split between the axles like the car's weight. */
        downforce: 1,
        /** Fraction of the drive force charged against cornering grip (1 = true friction circle). */
        driveGripShare: 0.4,
        /** Yaw rate allowed beyond what the steering asks for, rad/s, before the stability aid acts. */
        yawSlack: 0.22,
        /** How fast the stability aid removes excess yaw rate, 1/s. */
        yawDamping: 10,
        /** Body slip beyond which a slide is caught (without the handbrake), rad. */
        slideLimit: 0.3,
        /** How fast a slide past the limit is caught, 1/s. */
        slideCatch: 4,
        /** Rear grip multiplier with the handbrake on. */
        handbrakeGrip: 0.4,
        handbrakeDecel: 5,
        /** Below this, slip angles are computed against this speed instead: see `car.ts`. */
        slipFloorSpeed: 3,
        /** Body slip past this counts as drifting (tyre marks, smoke, squeal). */
        driftSlip: 0.14,
        /** Turbo: extra drive force and top speed while the meter lasts. */
        turboForce: 6000,
        turboTopSpeed: 12,
        turboCapacity: 4,
        /** Wall restitution and tangential friction. */
        wallBounce: 0.25,
        wallFriction: 0.3,
        /** A normal wall impact faster than this hurts, and each m/s past it costs this much health. */
        impactDamageSpeed: 12,
        impactDamage: 1.4,
        /** Landing faster than this costs speed. */
        hardLandingSpeed: 6,
        hardLandingLoss: 0.1,
    },
    /** Weapons, health and wrecks (PLAN.md §3.6). */
    weapons: {
        front: { speed: 90, life: 1.4, damage: 20, cooldown: 0.3 },
        rear: { speed: 70, life: 1.2, damage: 20, cooldown: 0.45 },
        mine: { arm: 0.6, life: 45, damage: 30, cooldown: 0.5, radius: 1.3 },
        /** A missile's own radius, for hitting a car. */
        missileRadius: 0.35,
        /** How far from the car's centre a shot leaves: just past the bumper. */
        muzzle: 2.8,
        /** What every car starts a race with, until the shop (M8) sells more. */
        loadout: { front: 10, rear: 5, mines: 3 },
        health: 100,
        /** Seconds a wrecked car burns before it is put back on the road, and with how much health. */
        wreckTime: 2.5,
        respawnHealth: 35,
        /** Seconds after GO before anyone may fire: the grid is not a firing range. */
        startGrace: 4,
        /** A wall that wrecks a car this soon after somebody hit it counts as their wreck. */
        creditWindow: 4,
    },
};
export const QUALITY = {
    // For the test rig: SwiftShader has to render several tabs at once.
    potato: {
        label: 'Potato', pixelRatioCap: 0.5, shadowMapSize: 0, softShadows: false,
        particles: 120, tyreMarks: 256, drawDistance: 160, antialias: false, sceneryDetail: 0,
    },
    low: {
        label: 'Low', pixelRatioCap: 1, shadowMapSize: 0, softShadows: false,
        particles: 300, tyreMarks: 1024, drawDistance: 180, antialias: false, sceneryDetail: 1,
    },
    medium: {
        label: 'Medium', pixelRatioCap: 1.25, shadowMapSize: 1024, softShadows: false,
        particles: 900, tyreMarks: 2048, drawDistance: 260, antialias: false, sceneryDetail: 2,
    },
    high: {
        label: 'High', pixelRatioCap: 1.5, shadowMapSize: 2048, softShadows: true,
        particles: 2000, tyreMarks: 4096, drawDistance: 360, antialias: true, sceneryDetail: 2,
    },
};
export const CAMERA = {
    /** Vertical FOV at rest and at top speed. */
    fov: 50,
    fovFast: 56,
    height: 56,
    heightFast: 68,
    /** Degrees the camera leans off vertical, looking "up" the screen (north). */
    tiltDeg: 10,
    /** Look-ahead: seconds of velocity, capped. */
    leadSeconds: 0.5,
    leadMax: 22,
    /** Minimum ground span on the narrow screen axis, so a phone in portrait is not a keyhole. */
    minSpan: 50,
    /** Trauma decay per second; shake amplitude is trauma squared. */
    traumaDecay: 1.5,
    shakeMetres: 1.6,
};
/**
 * Public, unauthenticated brokers. Anyone can subscribe — do not put secrets
 * on these topics. Pages is HTTPS, so every endpoint must be `wss://`: a
 * plaintext `ws://` connection is blocked as mixed content.
 */
export const BROKERS = [
    { id: 'hivemq', label: 'HiveMQ (public)', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { id: 'emqx', label: 'EMQX (public)', url: 'wss://broker.emqx.io:8084/mqtt' },
    { id: 'mosquitto', label: 'Eclipse Mosquitto (public)', url: 'wss://test.mosquitto.org:8081/mqtt' },
];
/** Networking. Election timings are glitchburst's, which were tuned the hard way. */
export const NET = {
    /** Root of the topic tree: `nc/room/<room>/…`. */
    topicRoot: 'nc',
    /** Room size, humans. A seventh arrival works out that it is the overflow and backs out. */
    maxPlayers: 6,
    /** Each car's state, baseline. */
    carHz: 20,
    /** Ceiling for dead-reckoning-triggered extra sends. */
    carMaxHz: 30,
    /** Sender re-publishes early once its own prediction is this far off. */
    drPositionError: 0.35,
    drYawError: (4 * Math.PI) / 180,
    /** Car events are batched and flushed this often. */
    eventFlushMs: 50,
    /** Host proves it is alive this often. */
    heartbeatHz: 2,
    /** No heartbeat for this long => the host is presumed dead and an election runs. */
    hostTimeoutMs: 2500,
    /** Presence ping interval. */
    presenceMs: 1000,
    /**
     * Silence for this long drops a peer. A backstop, not the mechanism: real
     * departures arrive instantly as the Last Will or an explicit `alive: 0`,
     * and five seconds of quiet is something a browser hands out for free.
     */
    presenceTimeoutMs: 15000,
    /** A gap this long between roster ticks means *we* slept; forgive everyone. */
    stallForgivenessMs: 2000,
    /** Clock pings: fast after a join or a host change, slow after. */
    clockFastMs: 500,
    clockFastForMs: 4000,
    clockSlowMs: 5000,
    /** Seconds between GO being announced and GO happening. */
    countdownMs: 4000,
    /** After the first car finishes, how long the rest get. */
    finishGraceMs: 30000,
    /** How long the results stay up before the room returns to the lobby. */
    resultsMs: 12000,
    /** A car silent this long mid-race is treated as gone (did not finish). */
    carSilenceMs: 5000,
    keepaliveSec: 30,
    connectTimeoutMs: 8000,
    reconnectMs: 2000,
};
//# sourceMappingURL=config.js.map