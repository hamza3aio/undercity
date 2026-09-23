// Glitch net — serverless player-hosted P2P (listen-server model).
// The HOSTING player is the authority: they own the sim and broadcast
// snapshots; guests send action requests. No dedicated server, no accounts,
// no matchmaking. Guests join with manual codes (works over LAN or internet
// with NAT-tolerant STUN). Host leaves = session ends (no migration yet).

export type NetMode = "off" | "host" | "guest";
export const MAX_PLAYERS = 4; // 1 host + 3 guests

export interface RemotePlayer {
  id: string; name: string; color: [number, number, number];
  x: number; y: number; z: number; ry: number;
}

interface WireMsg { t: string; [k: string]: unknown; }

const RTC_CFG: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function encode(o: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
}

function decode<T>(code: string): T {
  return JSON.parse(decodeURIComponent(escape(atob(code.trim())))) as T;
}

function waitIce(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        finish();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", check); finish(); }, 5000);
  });
}

const PALETTE: [number, number, number][] = [
  [0.2, 0.5, 1.0], [0.9, 0.35, 0.3], [0.3, 0.85, 0.45], [0.9, 0.8, 0.25],
];

export class P2PNet {
  mode: NetMode = "off";
  selfId = "p" + Math.random().toString(36).slice(2, 8);
  selfName = "Player";
  selfColor: [number, number, number] = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  players = new Map<string, RemotePlayer>();

  onSnap: ((s: unknown) => void) | null = null;
  onPos: ((p: RemotePlayer) => void) | null = null;
  onReq: ((from: string, action: string, args: Record<string, unknown>, reqId: string) => void) | null = null;
  onRes: ((reqId: string, ok: boolean, msg: string) => void) | null = null;
  onRoster: ((list: { id: string; name: string; color: [number, number, number] }[]) => void) | null = null;
  onToast: ((text: string) => void) | null = null;
  onPeerLeft: ((id: string) => void) | null = null;

  private hostConns = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel }>();
  private pendingPc: RTCPeerConnection | null = null;
  private guestPc: RTCPeerConnection | null = null;
  private guestDc: RTCDataChannel | null = null;
  private reqSeq = 0;

  isHost() { return this.mode === "host"; }
  isGuest() { return this.mode === "guest"; }
  peerCount() { return 1 + this.players.size; }

  // ---------- host side ----------
  async createInvite(): Promise<string> {
    if (this.mode === "off") this.mode = "host";
    if (1 + this.hostConns.size >= MAX_PLAYERS) throw new Error("Lobby full (4 max).");
    const pc = new RTCPeerConnection(RTC_CFG);
    const dc = pc.createDataChannel("game");
    this.pendingPc = pc;
    this.wireHostConn(pc, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    return encode({ sdp: pc.localDescription, host: this.selfId });
  }

  async acceptGuest(answerCode: string): Promise<string> {
    const pc = this.pendingPc;
    if (!pc) throw new Error("Create an invite first.");
    const { sdp } = decode<{ sdp: RTCSessionDescriptionInit }>(answerCode);
    await pc.setRemoteDescription(sdp);
    this.pendingPc = null;
    return "ok";
  }

  // ---------- guest side ----------
  async join(hostCode: string, name: string): Promise<string> {
    this.leave();
    this.mode = "guest";
    this.selfName = name.trim().slice(0, 16) || "Player";
    const { sdp } = decode<{ sdp: RTCSessionDescriptionInit }>(hostCode);
    const pc = new RTCPeerConnection(RTC_CFG);
    this.guestPc = pc;
    pc.ondatachannel = (ev) => {
      this.guestDc = ev.channel;
      this.wireGuestDc(ev.channel);
    };
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    return encode({ sdp: pc.localDescription });
  }

  // ---------- messaging ----------
  private send(dc: RTCDataChannel | null, msg: WireMsg) {
    try {
      if (dc && dc.readyState === "open") dc.send(JSON.stringify(msg));
    } catch { /* peer gone */ }
  }

  private wireHostConn(pc: RTCPeerConnection, dc: RTCDataChannel) {
    let peerId = "";
    dc.onmessage = (ev) => {
      let m: WireMsg;
      try { m = JSON.parse(ev.data as string) as WireMsg; } catch { return; }
      if (m.t === "hello") {
        peerId = String(m.id ?? "");
        const rp: RemotePlayer = {
          id: peerId, name: String(m.name ?? "Player"),
          color: (m.color as [number, number, number]) ?? [1, 1, 1],
          x: 0, y: 2, z: 6, ry: 0,
        };
        this.players.set(peerId, rp);
        this.hostConns.set(peerId, { pc, dc });
        this.pushRoster();
        this.onToast?.(`${rp.name} joined the crew.`);
      } else if (m.t === "pos" && peerId) {
        const rp = this.players.get(peerId);
        if (rp) {
          rp.x = Number(m.x); rp.y = Number(m.y); rp.z = Number(m.z); rp.ry = Number(m.ry);
          this.onPos?.(rp);
        }
      } else if (m.t === "req" && peerId) {
        this.onReq?.(peerId, String(m.action), (m.args ?? {}) as Record<string, unknown>, String(m.reqId));
      }
    };
    const drop = () => {
      if (!peerId) return;
      this.players.delete(peerId);
      this.hostConns.delete(peerId);
      this.pushRoster();
      this.onPeerLeft?.(peerId);
      this.onToast?.("A player left the crew.");
    };
    dc.onclose = drop;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") drop();
    };
  }

  private wireGuestDc(dc: RTCDataChannel) {
    dc.onopen = () => {
      this.send(dc, { t: "hello", id: this.selfId, name: this.selfName, color: this.selfColor });
    };
    dc.onmessage = (ev) => {
      let m: WireMsg;
      try { m = JSON.parse(ev.data as string) as WireMsg; } catch { return; }
      if (m.t === "snap") this.onSnap?.(m.state);
      else if (m.t === "poslist" && Array.isArray(m.list)) {
        for (const p of m.list as RemotePlayer[]) {
          if (p.id === this.selfId) continue;
          const cur = this.players.get(p.id);
          if (cur) Object.assign(cur, p);
          else this.players.set(p.id, p);
          this.onPos?.(this.players.get(p.id)!);
        }
      } else if (m.t === "roster" && Array.isArray(m.list)) {
        const list = m.list as { id: string; name: string; color: [number, number, number] }[];
        for (const r of list) {
          if (r.id === this.selfId) continue;
          if (!this.players.has(r.id)) this.players.set(r.id, { ...r, x: 0, y: 2, z: 6, ry: 0 });
        }
        for (const id of [...this.players.keys()]) {
          if (!list.some((r) => r.id === id)) {
            this.players.delete(id);
            this.onPeerLeft?.(id);
          }
        }
        this.onRoster?.(list);
      } else if (m.t === "res") {
        this.onRes?.(String(m.reqId), m.ok === true, String(m.msg ?? ""));
      } else if (m.t === "toast") {
        this.onToast?.(String(m.text ?? ""));
      }
    };
    dc.onclose = () => this.onToast?.("Disconnected from host.");
  }

  // host broadcasts
  snap(state: unknown) {
    for (const [, c] of this.hostConns) this.send(c.dc, { t: "snap", state });
  }

  posList(list: RemotePlayer[]) {
    for (const [, c] of this.hostConns) this.send(c.dc, { t: "poslist", list });
  }

  pushRoster() {
    const list = [
      { id: this.selfId, name: this.selfName + " (host)", color: this.selfColor },
      ...[...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })),
    ];
    for (const [, c] of this.hostConns) this.send(c.dc, { t: "roster", list });
    this.onRoster?.(list);
  }

  toastAll(text: string) {
    for (const [, c] of this.hostConns) this.send(c.dc, { t: "toast", text });
  }

  respond(to: string, reqId: string, ok: boolean, msg: string) {
    const c = this.hostConns.get(to);
    if (c) this.send(c.dc, { t: "res", reqId, ok, msg });
  }

  // guest sends
  sendPos(x: number, y: number, z: number, ry: number) {
    this.send(this.guestDc, { t: "pos", x, y, z, ry });
  }

  request(action: string, args: Record<string, unknown> = {}): string {
    const reqId = `${this.selfId}:${++this.reqSeq}`;
    this.send(this.guestDc, { t: "req", reqId, action, args });
    return reqId;
  }

  leave() {
    try { this.guestDc?.close(); } catch { /* closed */ }
    try { this.guestPc?.close(); } catch { /* closed */ }
    for (const [, c] of this.hostConns) {
      try { c.dc.close(); } catch { /* closed */ }
      try { c.pc.close(); } catch { /* closed */ }
    }
    try { this.pendingPc?.close(); } catch { /* closed */ }
    this.hostConns.clear();
    this.players.clear();
    this.pendingPc = null;
    this.guestPc = null;
    this.guestDc = null;
    this.mode = "off";
  }
}
