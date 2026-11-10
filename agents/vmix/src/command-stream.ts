import WebSocket from 'ws';

type Binding = { sessionGeneration: number; mappingVersion: number };
type Pending = { timingId: string; resolve: (data: unknown) => void; reject: () => void };

/** One socket or HTTP fallback. No buffered command can survive a transport switch. */
export class CommandStream {
  private socket?: WebSocket;
  private binding = '';
  private pending?: Pending;
  private retryAt = 0;
  private wakePending = false;
  private wake?: () => void;
  private transport?: 'WebSocket' | 'HTTPS fallback';
  constructor(private endpoint: string, private deviceId: string, private sessionId: string, private stop?: AbortSignal) {
    stop?.addEventListener('abort', () => this.close(), { once: true });
  }
  private close() {
    const socket = this.socket;
    this.socket = undefined;
    // Terminate before an HTTP fallback. Late frames have no consumer or pending resolver.
    socket?.terminate();
    const pending = this.pending; this.pending = undefined; pending?.reject();
  }
  private reportTransport(transport: 'WebSocket' | 'HTTPS fallback') {
    if (transport === this.transport) return;
    this.transport = transport;
    console.error(`Studio command delivery: ${transport}.`);
  }
  private async connect(token: string, binding: Binding) {
    const key = JSON.stringify(binding);
    if (this.socket?.readyState === WebSocket.OPEN && this.binding === key) return this.socket;
    this.close();
    const url = new URL(this.endpoint);
    url.search = new URLSearchParams({ sessionId: this.sessionId, deviceId: this.deviceId,
      sessionGeneration: String(binding.sessionGeneration), mappingVersion: String(binding.mappingVersion) }).toString();
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 3000, maxPayload: 6_100_000, perMessageDeflate: false, followRedirects: false });
    this.socket = socket; this.binding = key;
    socket.on('error', () => { if (this.socket === socket) this.close(); });
    socket.on('close', () => { if (this.socket === socket) this.close(); });
    socket.on('message', (bytes, binary) => {
      if (this.socket !== socket) return;
      try {
        if (binary) throw new Error('Invalid stream frame');
        const frame = JSON.parse(bytes.toString());
        if (frame.type === 'wake') { this.wakePending = true; this.wake?.(); return; }
        if (frame.type !== 'delivery' || !this.pending || frame.timingId !== this.pending.timingId) throw new Error('Unexpected stream frame');
        const pending = this.pending; this.pending = undefined; pending.resolve(frame.data);
      } catch { this.close(); }
    });
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error('Stream connection unavailable'));
      socket.once('open', resolve); socket.once('error', failed); socket.once('close', failed);
    });
    return socket;
  }
  async pull(token: string, binding: Binding, timingId: string, afterSequence: number): Promise<unknown | null> {
    if (this.stop?.aborted || performance.now() < this.retryAt) return null;
    try {
      const socket = await this.connect(token, binding);
      if (this.stop?.aborted || this.socket !== socket) throw new Error('Stream stopped');
      const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.close(); }, 5000);
        this.pending = { timingId,
          resolve: data => { clearTimeout(timer); resolve(data); },
          reject: () => { clearTimeout(timer); reject(new Error('Stream delivery unavailable')); } };
        socket.send(JSON.stringify({ type: 'pull', token, timingId, afterSequence }));
      });
      this.reportTransport('WebSocket');
      return data;
    } catch {
      this.close(); this.retryAt = performance.now() + 30_000;
      this.reportTransport('HTTPS fallback');
      return null;
    }
  }
  async wait(ms: number): Promise<void> {
    if (this.wakePending || this.stop?.aborted) { this.wakePending = false; return; }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.stop?.removeEventListener('abort', finish); this.wake = undefined; resolve(); };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      this.stop?.addEventListener('abort', finish, { once: true });
    });
    this.wakePending = false;
  }
}
