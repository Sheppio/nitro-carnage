import type { Track } from '../sim/track/buildTrack.js';

/**
 * The minimap: the track drawn once from its centreline into an offscreen
 * canvas, then copied each frame with a dot per car on top. North-up, like
 * the camera, so the map and the world always agree.
 */
export class Minimap {
  private base: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private ox = 0;
  private oz = 0;

  constructor(private canvas: HTMLCanvasElement, track: Track) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = canvas.clientWidth || 150;
    canvas.width = canvas.height = Math.round(size * dpr);
    this.ctx = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = canvas.width;

    const { px, pz } = track.line;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < track.n; i++) {
      x0 = Math.min(x0, px[i]!);
      x1 = Math.max(x1, px[i]!);
      z0 = Math.min(z0, pz[i]!);
      z1 = Math.max(z1, pz[i]!);
    }
    const pad = track.wallOffset + 8;
    const span = Math.max(x1 - x0, z1 - z0) + pad * 2;
    this.scale = canvas.width / span;
    this.ox = (x0 + x1) / 2 - span / 2;
    this.oz = (z0 + z1) / 2 - span / 2;

    const g = this.base.getContext('2d')!;
    const path = new Path2D();
    for (let i = 0; i <= track.n; i++) {
      const j = i % track.n;
      const [x, y] = this.map(px[j]!, pz[j]!);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = track.halfWidth * 2 * this.scale + 6 * dpr;
    g.stroke(path);
    g.strokeStyle = 'rgba(235,230,245,0.85)';
    g.lineWidth = Math.max(2 * dpr, track.halfWidth * 2 * this.scale);
    g.stroke(path);
    // Start line.
    const [sx, sy] = this.map(px[0]!, pz[0]!);
    g.fillStyle = '#ff4d2e';
    g.fillRect(sx - 2 * dpr, sy - 5 * dpr, 4 * dpr, 10 * dpr);
  }

  private map(x: number, z: number): [number, number] {
    return [(x - this.ox) * this.scale, (z - this.oz) * this.scale];
  }

  draw(cars: readonly { x: number; z: number; css: string; you: boolean }[]): void {
    const g = this.ctx;
    const dpr = this.canvas.width / (this.canvas.clientWidth || this.canvas.width);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.base, 0, 0);
    // The player last, so it is never hidden under a rival.
    for (const c of [...cars].sort((a, b) => Number(a.you) - Number(b.you))) {
      const [x, y] = this.map(c.x, c.z);
      g.beginPath();
      g.arc(x, y, (c.you ? 5 : 3.5) * dpr, 0, Math.PI * 2);
      g.fillStyle = c.css;
      g.fill();
      g.lineWidth = (c.you ? 2 : 1) * dpr;
      g.strokeStyle = c.you ? '#fff' : 'rgba(0,0,0,0.7)';
      g.stroke();
    }
  }
}
