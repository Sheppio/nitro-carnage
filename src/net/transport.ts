/**
 * What the room and race code need from a message bus. `MqttNet` provides it
 * over a real broker; `MemoryBroker` provides it in Node tests.
 */
export interface Transport {
  subscribe(pattern: string, handler: (topic: string, payload: string) => void): () => void;
  /** Fire-and-forget, QoS 0. A no-op while disconnected. */
  publish(topic: string, payload: string): void;
  /** Register the Last Will before connecting. */
  setWill(topic: string, payload: string): void;
}

/** Translate an MQTT filter (`+` single level, `#` multi level) into a regex. */
export function filterToRegex(filter: string): RegExp {
  const escaped = filter
    .split('/')
    .map((seg) => (seg === '+' ? '[^/]+' : seg === '#' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}
