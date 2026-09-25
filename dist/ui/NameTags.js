/**
 * Driver names floating over the cars, in each car's colour. DOM, not WebGL:
 * text stays sharp at every zoom and costs no draw calls. Positions come in
 * already projected; this only places, adds and removes the tags.
 */
export class NameTags {
    root;
    tags = new Map();
    constructor(root) {
        this.root = root;
    }
    update(cars) {
        const seen = new Set();
        for (const c of cars) {
            if (!c.onScreen)
                continue;
            seen.add(c.id);
            let el = this.tags.get(c.id);
            if (!el) {
                el = document.createElement('div');
                el.className = 'name-tag';
                this.root.appendChild(el);
                this.tags.set(c.id, el);
            }
            if (el.textContent !== c.name)
                el.textContent = c.name;
            el.style.setProperty('--c', c.css);
            el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) translate(-50%, -100%)`;
        }
        for (const [id, el] of this.tags) {
            if (seen.has(id))
                continue;
            el.remove();
            this.tags.delete(id);
        }
    }
    clear() {
        for (const el of this.tags.values())
            el.remove();
        this.tags.clear();
    }
}
//# sourceMappingURL=NameTags.js.map