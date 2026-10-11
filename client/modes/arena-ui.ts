import { ARENA } from '../../shared/arena.ts';
import { padPlayerNumber } from '../../shared/constants.ts';
import type { LobbyPlayer, ServerMsg } from '../../shared/protocol.ts';
import { dateKey, prettyDate } from '../../shared/rng.ts';
import { STANDING_LABEL, formatScore, type Square } from '../../shared/scoring.ts';
import type { Stage } from '../game/stage.ts';
import { me } from '../identity.ts';
import { ArenaSocket } from '../net/arena-socket.ts';
import { store } from '../prefs.ts';
import { h } from '../ui/dom.ts';
import { clearHud } from '../ui/hud.ts';
import { icon } from '../ui/icons.ts';
import { hideOverlay, showOverlay } from '../ui/overlay.ts';
import { showResults } from '../ui/results.ts';
import { clearToasts, toast } from '../ui/toast.ts';
import { Backdrop } from './backdrop.ts';
import { ArenaRun, type ArenaOutcome } from './arena.ts';

export interface ArenaDeps {
  stage: Stage;
  onExit(): void;
  stopRun(): void;
  /** join this room right away (from a ?room= link) */
  joinCode?: string;
}

/** Stable per-browser id so a cookieless reconnect still finds its seat. */
const localPid = (): string => {
  const k = store<string>('lcs-arena-pid', '');
  if (k) return k;
  const id = Math.random().toString(36).slice(2, 12);
  try {
    localStorage.setItem('lcs-arena-pid', JSON.stringify(id));
  } catch {
    /* fine */
  }
  return id;
};

let session: ArenaSession | null = null;

export async function showArenaHome(deps: ArenaDeps) {
  deps.stopRun();
  session?.leave(false);
  showOverlay(h('div', { class: 'panel' }, h('div', { class: 'eyebrow' }, icon('users', 14), 'Arena'), h('p', { class: 'lede' }, 'Connecting to the Arena…')));
  try {
    const sock = await ArenaSocket.connect(me.name, localPid());
    session = new ArenaSession(sock, deps);
    if (deps.joinCode) sock.send({ t: 'join', code: deps.joinCode });
    else session.home();
  } catch (e) {
    toast((e as Error).message, 'pink');
    deps.onExit();
  }
}

class ArenaSession {
  private code = '';
  private myId = '';
  private myNum = me.num;
  private hostId = '';
  private phase: 'lobby' | 'running' | 'over' = 'lobby';
  private isPublic = false;
  private autoStartAt: number | null = null;
  private clock = 0;
  private players: LobbyPlayer[] = [];
  private run: ArenaRun | null = null;
  private view: 'home' | 'lobby' | 'game' | 'results' = 'home';

  constructor(private sock: ArenaSocket, private deps: ArenaDeps) {
    sock.on((m) => this.onMsg(m));
    sock.onStatus = (s) => {
      if (s === 'reconnecting') toast('Connection dropped. Reconnecting…', 'amber', { key: 'reconnect', throttleMs: 3000 });
      if (s === 'lost') {
        toast('Lost the connection to the Arena.', 'pink');
        this.leave(true);
      }
    };
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'welcome':
        this.myId = m.id;
        this.myNum = m.num;
        break;
      case 'error':
        toast(m.msg, 'pink');
        if (this.view === 'lobby' && /no room/i.test(m.msg)) {
          // the room vanished (e.g. a server restart while we were reconnecting)
          this.code = '';
          this.sock.rejoinCode = null;
          history.replaceState(null, '', '/');
          this.home();
        } else if (this.view === 'home' || (!this.code && this.deps.joinCode)) this.home();
        break;
      case 'room': {
        const first = !this.code;
        this.code = m.code;
        this.sock.rejoinCode = m.code;
        this.hostId = m.hostId;
        this.phase = m.phase;
        this.players = m.players;
        this.isPublic = m.isPublic;
        this.autoStartAt = m.autoStartAt;
        if (first) history.replaceState(null, '', `/?room=${m.code}`);
        if (this.view === 'home' || this.view === 'lobby') this.lobby();
        break;
      }
      case 'start':
        this.startRun(m.seed, m.t0);
        break;
      case 'over':
        this.run?.finish(m);
        break;
    }
  }

  /** Seconds until a public match starts, as text, or '' */
  private countdownText(): string {
    if (this.autoStartAt === null) return '';
    const s = Math.max(0, Math.ceil((this.autoStartAt - this.sock.serverNow()) / 1000));
    return s > 0 ? `Next match starts in ${s}s` : 'Starting…';
  }

  private startClock() {
    clearInterval(this.clock);
    this.clock = window.setInterval(() => {
      const el = document.getElementById('next-match');
      if (el) el.textContent = this.countdownText() || 'Waiting for players…';
    }, 250);
  }

  home() {
    this.view = 'home';
    const codeInput = h('input', { class: 'input code', id: 'room-code', maxlength: ARENA.codeLength, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'code', 'aria-label': 'Room code' }) as HTMLInputElement;
    const join = () => {
      const code = codeInput.value.trim().toLowerCase();
      if (code.length !== ARENA.codeLength) return toast(`Room codes have ${ARENA.codeLength} characters.`, 'pink');
      this.sock.send({ t: 'join', code });
    };
    codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    const quick = h('button', { type: 'button', class: 'btn primary', onclick: () => this.sock.send({ t: 'quick' }) }, icon('bolt'), 'Quick match');
    const create = h('button', { type: 'button', class: 'btn', onclick: () => this.sock.send({ t: 'create' }) }, icon('users'), 'Private room for friends');
    showOverlay(
      h('div', { class: 'panel' },
        h('div', { class: 'eyebrow' }, icon('users', 14), 'Arena · live'),
        h('h2', { class: 'title', style: { fontSize: 'clamp(26px, 5vw, 38px)', marginTop: '8px' } }, 'Six bells.'),
        h('p', { class: 'lede' }, `When a bell rings, be standing on a platform or you're out. Then everyone answers the same question in 10 seconds. After each round two platforms crumble.`),
        h('div', { class: 'stack', style: { marginTop: '18px' } },
          h('div', { class: 'row' }, quick, create),
          h('p', { class: 'muted', style: { margin: 0, fontSize: '13px' } }, 'Quick match puts you in a public room. If nobody else shows up, labeled bots fill the empty seats.'),
          h('div', { class: 'row' }, h('label', { for: 'room-code', class: 'muted' }, 'Or join with a code'), codeInput, h('button', { type: 'button', class: 'btn', onclick: join }, 'Join')),
        ),
        h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { type: 'button', class: 'btn ghost', onclick: () => this.leave(true) }, icon('back'), 'Back')),
      ),
    );
    quick.focus();
  }

  private lobby() {
    this.view = 'lobby';
    const isHost = this.myId === this.hostId && !this.isPublic;
    const link = `${location.origin}/a/${this.code}`;
    const running = this.phase === 'running';
    const start = this.isPublic
      ? h('span', { class: 'chip bell', id: 'next-match', 'aria-live': 'polite' }, this.countdownText() || 'Waiting for players…')
      : h('button', { type: 'button', class: 'btn primary', disabled: !isHost || running, onclick: () => this.sock.send({ t: 'start' }) }, icon('play'), 'Start');
    if (this.isPublic) this.startClock();
    showOverlay(
      h('div', { class: 'panel wide' },
        h('div', { class: 'eyebrow' }, icon('users', 14), this.isPublic ? 'Arena · public room' : 'Arena · private room'),
        h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '8px' } },
          h('div', null, h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Room code'), h('div', { class: 'room-code', 'aria-label': `Room code ${this.code.split('').join(' ')}` }, this.code)),
          h('button', { type: 'button', class: 'btn small', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Invite link copied.')).catch(() => toast(link)) }, icon('link', 16), 'Copy invite link'),
        ),
        h('ul', { class: 'lobby-list', 'aria-label': 'Players in the room' },
          this.players.map((p) =>
            h('li', { class: p.connected ? '' : 'out' },
              h('span', { class: 'num' }, padPlayerNumber(p.num)),
              h('span', { class: 'nm' }, p.name || `Player ${padPlayerNumber(p.num)}`, p.id === this.myId ? ' (you)' : ''),
              p.bot ? h('span', { class: 'host' }, 'BOT') : p.id === this.hostId && !this.isPublic ? h('span', { class: 'host' }, 'HOST') : null,
            )),
        ),
        h('p', { class: 'muted', style: { fontSize: '14px', margin: '14px 0 0' } },
          running
            ? 'A match is in progress. You can watch until it ends.'
            : this.isPublic
              ? 'Public room. The match starts on its own; bots fill empty seats if it is just you.'
              : isHost
                ? `${this.players.length} in the room. Start when everyone's in.`
                : 'Waiting for the host to start.'),
        h('div', { class: 'row', style: { marginTop: '14px' } }, start, h('button', { type: 'button', class: 'btn ghost', onclick: () => this.leave(true) }, 'Leave room')),
      ),
    );
    if (isHost && !running) start.focus();
  }

  private startRun(seed: number, t0: number) {
    this.deps.stopRun();
    this.run?.dispose();
    clearToasts();
    const spectator = this.players.find((p) => p.id === this.myId)?.state !== 'alive';
    this.run = new ArenaRun(this.deps.stage, this.sock, {
      seed, t0, myId: this.myId, myNum: this.myNum, code: this.code, spectator,
      players: () => this.players,
      onOver: (o) => this.results(o),
    });
    this.deps.stage.run(this.run);
    this.view = 'game';
    hideOverlay();
  }

  private results(o: ArenaOutcome) {
    this.view = 'results';
    const squares: Square[] = Array.from({ length: ARENA.bells }, (_, k) =>
      k < o.bellsSurvived ? 'cleared' : !o.standing && k === (o.outAtBell ?? o.bellsSurvived) ? 'died' : 'empty');
    const isHost = this.myId === this.hostId;
    setTimeout(() => {
      clearHud();
      showResults({
        summary: {
          mode: 'Arena', date: prettyDate(dateKey()), playerNum: this.myNum, name: me.name || undefined, score: o.score,
          statLine: `Survived ${o.bellsSurvived}/${ARENA.bells} bells`, squares, standing: o.standing,
          outLine: o.standing ? STANDING_LABEL : o.reason.replace(/\.$/, ''),
        },
        reason: o.reason,
        stats: [
          { label: 'Score', value: formatScore(o.score), cls: 'score' },
          { label: 'Bells survived', value: `${o.bellsSurvived}/${ARENA.bells}` },
          { label: 'Still standing', value: String(o.survivors) },
        ],
        url: `${location.origin}/a/${this.code}`,
        note: this.isPublic ? 'Stay here and the next public match pulls you in automatically.' : undefined,
        actions: this.isPublic
          ? [
              { label: 'Back to lobby', icon: 'users', primary: true, onClick: () => this.toLobby() },
              { label: 'Leave room', icon: 'back', onClick: () => this.leave(true) },
            ]
          : [
              isHost
                ? { label: 'Play again', icon: 'refresh', primary: true, onClick: () => this.sock.send({ t: 'start' }) }
                : { label: 'Back to lobby', icon: 'users', primary: true, onClick: () => this.toLobby() },
              { label: 'Leave room', icon: 'back', onClick: () => this.leave(true) },
            ],
      });
      if (this.isPublic) {
        document.querySelector('.results .reason')?.after(h('p', { class: 'chip bell', id: 'next-match', style: { marginTop: '10px' } }, this.countdownText() || 'Waiting for players…'));
        this.startClock();
      }
    }, 1000);
  }

  private toLobby() {
    this.run?.dispose();
    this.run = null;
    this.deps.stage.run(new Backdrop());
    this.lobby();
  }

  leave(exit: boolean) {
    clearInterval(this.clock);
    this.sock.send({ t: 'leave' });
    this.run?.dispose();
    this.run = null;
    this.sock.close();
    session = null;
    if (exit) this.deps.onExit();
  }
}
