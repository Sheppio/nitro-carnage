/** Distance in from the screen edge at which arrows sit, CSS pixels. */
const INSET = 28;

/**
 * Chevrons at the edge of the screen pointing at rivals out of view, in their
 * colours (the glitchburst edge-marker idea).
 *
 * A marker goes where the ray from the middle of the screen to the car crosses
 * an *inset* rectangle: on the edge itself half the arrow would be clipped,
 * which reads as a rendering fault rather than a pointer.
 */
export class RivalArrows {
  private arrows = new Map<string, HTMLDivElement>();

  constructor(private root: HTMLElement) {}

  update(cars: readonly { id: string; css: string; x: number; y: number; onScreen: boolean }[], width: number, height: number): void {
    const seen = new Set<string>();
    const cx = width / 2;
    const cy = height / 2;
    for (const c of cars) {
      if (c.onScreen) continue;
      seen.add(c.id);
      let el = this.arrows.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rival-arrow';
        this.root.appendChild(el);
        this.arrows.set(c.id, el);
      }
      const dx = c.x - cx;
      const dy = c.y - cy;
      const hx = cx - INSET;
      const hy = cy - INSET;
      const t = Math.min(hx / Math.max(1e-6, Math.abs(dx)), hy / Math.max(1e-6, Math.abs(dy)));
      const ax = cx + dx * t;
      const ay = cy + dy * t;
      el.style.transform = `translate(${ax}px, ${ay}px) rotate(${Math.atan2(dy, dx)}rad)`;
      el.style.setProperty('--c', c.css);
    }
    for (const [id, el] of this.arrows) {
      if (seen.has(id)) continue;
      el.remove();
      this.arrows.delete(id);
    }
  }

  clear(): void {
    for (const el of this.arrows.values()) el.remove();
    this.arrows.clear();
  }
}
