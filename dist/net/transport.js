/** Translate an MQTT filter (`+` single level, `#` multi level) into a regex. */
export function filterToRegex(filter) {
    const escaped = filter
        .split('/')
        .map((seg) => (seg === '+' ? '[^/]+' : seg === '#' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
    return new RegExp(`^${escaped}$`);
}
//# sourceMappingURL=transport.js.map