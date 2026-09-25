/**
 * Circuits drawn by hand (M9): the ones with no open outline to hand. Each
 * is a walk round the lap in real metres — straights, and corners as a
 * turn (degrees) at a radius — from the circuit maps' named corners, in the
 * direction the lap runs. `S` straight, `R` right, `L` left.
 *
 * Drawn from the shapes of the published maps, not surveyed: the lap is
 * closed by scaling the turns to exactly one revolution and spreading any
 * gap left over along the lap. They are approximations; the GeoJSON ones are
 * not.
 */

/** Walk the ops; returns points every ~8 m, closed. `heading` in degrees clockwise from north (screen up). */
function walk(heading, ops) {
  // Scale the turns so the lap turns exactly once.
  const net = ops.reduce((s, [k, a]) => s + (k === 'R' ? a : k === 'L' ? -a : 0), 0);
  const k = 360 / Math.abs(net);
  let x = 0, z = 0, h = (heading * Math.PI) / 180;
  const pts = [[0, 0]];
  const step = (d) => {
    x += Math.sin(h) * d;
    z -= Math.cos(h) * d;
    pts.push([x, z]);
  };
  for (const [kind, a, r] of ops) {
    if (kind === 'S') {
      const n = Math.max(1, Math.round(a / 8));
      for (let i = 0; i < n; i++) step(a / n);
    } else {
      const turn = ((a * k * Math.PI) / 180) * (kind === 'R' ? 1 : -1);
      const arc = Math.abs(turn) * r;
      const n = Math.max(2, Math.round(arc / 6));
      for (let i = 0; i < n; i++) {
        h += turn / n / 2;
        step(arc / n);
        h += turn / n / 2;
      }
    }
  }
  // Spread the gap between the end and the start along the lap.
  const [ex, ez] = pts[pts.length - 1];
  pts.pop();
  const n = pts.length;
  return pts.map(([px, pz], i) => [px - (ex * i) / n, pz - (ez * i) / n]);
}

export const HAND = {
  /** The Brickyard: 2.5 miles, four quarter-mile turns, anticlockwise. */
  indianapolis: () => walk(180, [
    ['S', 503], ['L', 90, 256], ['S', 201], ['L', 90, 256], ['S', 1006], ['L', 90, 256], ['S', 201], ['L', 90, 256], ['S', 503],
  ]),

  /** The tri-oval: the front stretch bent at the start line, Lake Lloyd in the infield. */
  daytona: () => walk(90, [
    ['L', 10, 600], ['S', 577], ['L', 170, 300], ['S', 914], ['L', 170, 300], ['S', 577], ['L', 10, 600],
  ]),

  /** Brands Hatch Indy: Paddock Hill Bend, Druids, Graham Hill Bend, Cooper Straight, Surtees, McLaren, Clearways, Clark Curve. */
  brandsIndy: () => walk(90, [
    ['S', 200], ['R', 60, 120], ['S', 180], ['R', 175, 28], ['S', 60], ['L', 60, 70], ['S', 330],
    ['L', 40, 90], ['S', 90], ['R', 60, 60], ['S', 60], ['R', 110, 90], ['R', 50, 120], ['S', 130],
  ]),

  /** Brands Hatch Grand Prix: the Indy loop, and out at Surtees round Hawthorn, Westfield, Dingle Dell, Sheene and Stirling's. */
  brandsGP: () => walk(90, [
    ['S', 200], ['R', 60, 120], ['S', 180], ['R', 175, 28], ['S', 60], ['L', 60, 70], ['S', 330],
    ['L', 50, 90], ['S', 350], ['R', 70, 150], ['S', 450], ['R', 80, 90], ['S', 150], ['L', 20, 150], ['S', 100],
    ['R', 70, 60], ['S', 120], ['L', 95, 40], ['S', 280], ['R', 80, 90], ['R', 45, 120], ['S', 130],
  ]),

  /** Laguna Seca, anticlockwise: the Andretti Hairpin, the Rahal Straight, the Corkscrew, Rainey Curve. */
  laguna: () => walk(0, [
    ['S', 300], ['L', 25, 200], ['S', 200], ['L', 170, 28], ['S', 200], ['R', 60, 60], ['S', 200], ['R', 70, 55],
    ['S', 250], ['L', 80, 45], ['S', 150], ['L', 70, 60], ['S', 500], ['R', 25, 150], ['S', 150],
    ['L', 80, 25], ['R', 60, 25], ['S', 150], ['L', 110, 70], ['S', 200], ['R', 50, 70], ['S', 250], ['L', 90, 30],
  ]),

  /** Road America: the Moraine Sweep, the Carousel, the Kink, Canada Corner. */
  roadAmerica: () => walk(90, [
    ['S', 700], ['R', 95, 45], ['S', 600], ['R', 85, 55], ['S', 400], ['L', 30, 400], ['S', 200], ['L', 110, 35],
    ['S', 200], ['R', 80, 40], ['S', 250], ['R', 60, 60], ['S', 450], ['L', 90, 40], ['R', 180, 120], ['S', 500],
    ['R', 25, 300], ['S', 500], ['R', 90, 35], ['S', 200], ['L', 20, 100], ['S', 200],
  ]),

  /** Sebring: the old airfield; the Hairpin, the Ulmann Straight, and the long bumpy Turn 17. */
  sebring: () => walk(90, [
    ['S', 600], ['R', 50, 120], ['S', 250], ['R', 40, 60], ['S', 300], ['L', 90, 40], ['R', 90, 40], ['S', 300],
    ['R', 175, 25], ['S', 300], ['L', 45, 80], ['S', 200], ['L', 45, 80], ['S', 1100], ['R', 185, 150], ['S', 200],
  ]),

  /** Mount Panorama, anticlockwise: Hell Corner, the Mountain Straight, the Cutting, Skyline, the Esses, Forrest's Elbow, Conrod, the Chase, Murray's. */
  bathurst: () => walk(90, [
    ['S', 900], ['L', 90, 30], ['S', 1000], ['R', 40, 60], ['S', 200], ['L', 110, 25], ['S', 250], ['R', 30, 80],
    ['S', 250], ['L', 40, 70], ['S', 200], ['R', 30, 80], ['S', 200], ['L', 50, 40], ['R', 40, 35], ['L', 40, 35],
    ['R', 40, 50], ['S', 150], ['L', 120, 25], ['S', 1900], ['R', 30, 80], ['L', 30, 60], ['R', 20, 80], ['S', 200], ['L', 110, 25],
  ]),

  /**
   * Circuit de la Sarthe: a long, thin triangle. Dunlop, the Esses and Tertre
   * Rouge, then 5.4 km of the Mulsanne Straight south-east with its two
   * chicanes, Mulsanne corner, Indianapolis and Arnage at the far corner, and
   * the long leg north through the Porsche Curves and the Ford chicanes.
   */
  lemans: () => walk(110, [
    ['S', 500], ['R', 30, 200], ['L', 25, 60], ['R', 25, 60], ['S', 300], ['L', 40, 150], ['R', 40, 150], ['S', 250],
    ['R', 15, 100], ['S', 2000], ['R', 15, 50], ['L', 30, 50], ['R', 15, 50], ['S', 2000], ['L', 15, 50], ['R', 30, 50],
    ['L', 15, 50], ['S', 1400], ['R', 100, 35], ['S', 1200], ['R', 8, 400], ['S', 900], ['L', 15, 150], ['R', 45, 40],
    ['S', 350], ['R', 95, 30], ['S', 2200], ['R', 45, 80], ['L', 60, 70], ['R', 40, 80], ['L', 25, 120], ['S', 700],
    ['R', 45, 30], ['L', 45, 30], ['R', 45, 30], ['S', 150], ['R', 45, 60], ['S', 200],
  ]),
};
