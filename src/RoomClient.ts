import { PumpedClock, startTicker } from './clock.js';
import { encodePresence } from './net/codec.js';
import { MqttNet } from './net/MqttNet.js';
import type { NetStatus } from './net/MqttNet.js';
import { NetRace } from './net/NetRace.js';
import { Topics } from './net/topics.js';
import { TRACKS } from './sim/track/index.js';
import type { PlayerId, RoomId } from './types.js';
import { VERSION } from './version.js';

/**
 * One networked room, in the browser: the broker connection, the room and
 * race logic (`NetRace`), and the clock that keeps both running when the tab
 * is hidden.
 *
 * The race session calls `net.update()` every frame while the tab is in
 * front. When it is not, the page's own timers are throttled to a crawl and
 * rAF stops altogether, so a Worker ticker takes over: it pumps the room's
 * timers (heartbeat, presence, clock pings) and steps the race, which keeps a
 * backgrounded host hosting and its bots driving.
 */
export class RoomClient {
  readonly clock = new PumpedClock();
  readonly mqtt = new MqttNet();
  readonly net: NetRace;
  private stopTicker: (() => void) | null = null;

  constructor(readonly roomId: RoomId, readonly playerId: PlayerId, name: string, colour: string) {
    this.net = new NetRace({
      transport: this.mqtt, clock: this.clock, roomId, playerId, name, colour, ver: VERSION, tracks: TRACKS,
    });
  }

  get status(): NetStatus {
    return this.mqtt.status;
  }

  /**
   * Connect, then join. The Last Will is registered first — it has to go in
   * the CONNECT packet — but the room is only joined once the broker answers,
   * so a slow connection cannot leave this client alone long enough to elect
   * itself host of a room that already has one.
   */
  async connect(url: string): Promise<void> {
    this.mqtt.setWill(
      Topics.presence(this.roomId, this.playerId),
      encodePresence({ name: '', colour: '', host: 0, alive: 0, ready: 0, ver: VERSION }),
    );
    await this.mqtt.connect(url, `nc-${this.playerId}`);
    this.net.start();
    this.stopTicker = startTicker(() => {
      this.clock.pump();
      if (document.hidden) this.net.update();
    });
  }

  leave(): void {
    this.stopTicker?.();
    this.stopTicker = null;
    this.net.stop();
    this.mqtt.disconnect();
  }
}
