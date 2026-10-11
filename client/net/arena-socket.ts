import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

const PINGS = 5;

/** WebSocket to /arena with a server-clock estimate and automatic reconnects. */
export class ArenaSocket {
  private ws!: WebSocket;
  private handlers = new Set<(m: ServerMsg) => void>();
  private closedByUs = false;
  private retries = 0;
  /** serverTime ≈ Date.now() + offset */
  offset = 0;
  rtt = 0;
  /** re-sent after a reconnect so the server re-attaches us to the room */
  rejoinCode: string | null = null;
  onStatus: (s: 'open' | 'reconnecting' | 'lost') => void = () => undefined;

  private constructor(private hello: Extract<ClientMsg, { t: 'hello' }>) {}

  static async connect(name: string, pid: string): Promise<ArenaSocket> {
    const s = new ArenaSocket({ t: 'hello', pid, name });
    await s.open();
    return s;
  }

  private url() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/arena`;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url());
      this.ws = ws;
      let opened = false;
      ws.onopen = async () => {
        opened = true;
        this.retries = 0;
        this.send(this.hello);
        await this.syncClock();
        if (this.rejoinCode) this.send({ t: 'join', code: this.rejoinCode });
        this.onStatus('open');
        resolve();
      };
      ws.onmessage = (e) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(e.data as string) as ServerMsg;
        } catch {
          return;
        }
        for (const h of this.handlers) h(msg);
      };
      ws.onclose = () => {
        if (!opened) return reject(new Error('Could not reach the Arena server.'));
        if (this.closedByUs) return;
        this.reconnect();
      };
    });
  }

  private reconnect() {
    if (this.retries >= 6) return this.onStatus('lost');
    this.onStatus('reconnecting');
    const delay = 400 * 2 ** this.retries++;
    setTimeout(() => this.open().catch(() => this.reconnect()), delay);
  }

  /** Pings 5 times and keeps the offset from the sample with the median round trip. */
  private async syncClock() {
    const samples: { rtt: number; offset: number }[] = [];
    for (let i = 0; i < PINGS; i++) {
      const sample = await new Promise<{ rtt: number; offset: number } | null>((resolve) => {
        const c = performance.now();
        const sentAt = Date.now();
        const timer = setTimeout(() => (off(), resolve(null)), 2000);
        const off = this.on((m) => {
          if (m.t !== 'pong' || m.c !== c) return;
          clearTimeout(timer);
          off();
          const now = Date.now();
          const rtt = now - sentAt;
          resolve({ rtt, offset: m.s + rtt / 2 - now });
        });
        this.send({ t: 'ping', c });
      });
      if (sample) samples.push(sample);
    }
    if (!samples.length) return;
    samples.sort((a, b) => a.rtt - b.rtt);
    const mid = samples[Math.floor(samples.length / 2)];
    this.offset = mid.offset;
    this.rtt = mid.rtt;
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(fn: (m: ServerMsg) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close() {
    this.closedByUs = true;
    this.handlers.clear();
    this.ws?.close();
  }
}
