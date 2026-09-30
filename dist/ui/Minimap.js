/**
 * The minimap: the track drawn once from its centreline into an offscreen
 * canvas, then copied each frame with a dot per car on top. North-up, like
 * the camera, so the map and the world always agree.
 */
export class Minimap {
    canvas;
    base;
    ctx;
    scale = 1;
    ox = 0;
    oz = 0;
    /** The dots grow with the map: its size over the 150 px it was drawn for. */
    dot = 1;
    constructor(canvas, track) {
        this.canvas = canvas;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        // Made before the HUD is shown: a hidden canvas has no client size, but its css width is set.
        const size = canvas.clientWidth || parseFloat(getComputedStyle(canvas).width) || 150;
        canvas.width = canvas.height = Math.round(size * dpr);
        this.dot = Math.max(1, size / 150);
        this.ctx = canvas.getContext('2d');
        this.base = document.createElement('canvas');
        this.base.width = this.base.height = canvas.width;
        const { px, pz } = track.line;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let i = 0; i < track.n; i++) {
            x0 = Math.min(x0, px[i]);
            x1 = Math.max(x1, px[i]);
            z0 = Math.min(z0, pz[i]);
            z1 = Math.max(z1, pz[i]);
        }
        const pad = track.wallOffset + 8;
        const span = Math.max(x1 - x0, z1 - z0) + pad * 2;
        this.scale = canvas.width / span;
        this.ox = (x0 + x1) / 2 - span / 2;
        this.oz = (z0 + z1) / 2 - span / 2;
        const g = this.base.getContext('2d');
        const path = new Path2D();
        for (let i = 0; i <= track.n; i++) {
            const j = i % track.n;
            const [x, y] = this.map(px[j], pz[j]);
            if (i === 0)
                path.moveTo(x, y);
            else
                path.lineTo(x, y);
        }
        g.lineJoin = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = track.halfWidth * 2 * this.scale + 6 * dpr;
        g.stroke(path);
        g.strokeStyle = 'rgba(235,230,245,0.85)';
        g.lineWidth = Math.max(2 * dpr, track.halfWidth * 2 * this.scale);
        g.stroke(path);
        // Start line: across the road, turned to the way the lap runs there (it
        // was drawn upright, which only lay across a start straight running east-west).
        const [sx, sy] = this.map(px[0], pz[0]);
        const [ax, ay] = this.map(px[1 % track.n], pz[1 % track.n]);
        const across = Math.max(10 * dpr, track.halfWidth * 2 * this.scale + 4 * dpr);
        g.save();
        g.translate(sx, sy);
        g.rotate(Math.atan2(ay - sy, ax - sx));
        g.fillStyle = '#ff4d2e';
        g.fillRect(-2 * dpr, -across / 2, 4 * dpr, across);
        g.restore();
    }
    map(x, z) {
        return [(x - this.ox) * this.scale, (z - this.oz) * this.scale];
    }
    draw(cars) {
        const g = this.ctx;
        const dpr = this.canvas.width / (this.canvas.clientWidth || this.canvas.width);
        g.clearRect(0, 0, this.canvas.width, this.canvas.height);
        g.drawImage(this.base, 0, 0);
        // The player last, so it is never hidden under a rival.
        for (const c of [...cars].sort((a, b) => Number(a.you) - Number(b.you))) {
            const [x, y] = this.map(c.x, c.z);
            g.beginPath();
            g.arc(x, y, (c.you ? 5 : 3.5) * dpr * this.dot, 0, Math.PI * 2);
            g.fillStyle = c.css;
            g.fill();
            g.lineWidth = (c.you ? 2 : 1) * dpr * this.dot;
            g.strokeStyle = c.you ? '#fff' : 'rgba(0,0,0,0.7)';
            g.stroke();
        }
    }
}
//# sourceMappingURL=Minimap.js.map