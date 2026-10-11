/**
 * Dev helper: a scripted Arena player. Joins a room, stands on a platform that never crumbles,
 * and answers each question (randomly, or always choice `--answer N`).
 *
 *   npx tsx scripts/dev/arena-bot.ts <code> [--name Bot] [--url ws://localhost:8787/arena]
 */
import WebSocket from 'ws';
import { crumblePlan } from '../../shared/arena.ts';
import { arenaCourse } from '../../shared/course.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

const args = process.argv.slice(2);
const code = args[0];
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
if (!code) throw new Error('usage: arena-bot <code>');
const ws = new WebSocket(opt('--url', 'ws://localhost:8787/arena'));
let timer: NodeJS.Timeout | null = null;

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', pid: `bot-${Math.random()}`, name: opt('--name', 'Bot') }));
  ws.send(JSON.stringify({ t: 'join', code }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw)) as ServerMsg;
  if (m.t === 'snap' || m.t === 'room') return;
  console.log(new Date().toISOString().slice(11, 23), m.t, JSON.stringify(m).slice(0, 160));
  if (m.t === 'start') {
    const course = arenaCourse(m.seed);
    const crumbled = new Set(crumblePlan(m.seed).flat());
    const p = course.platforms.find((x) => !crumbled.has(x.i))!;
    if (timer) clearInterval(timer);
    timer = setInterval(() => ws.send(JSON.stringify({ t: 'pos', x: p.cx, y: p.baseY, vx: 0, vy: 0, g: p.i, f: 1 })), 66);
  }
  if (m.t === 'bell' && m.question) {
    const choice = args.includes('--answer') ? Number(opt('--answer', '0')) : Math.floor(Math.random() * 4);
    setTimeout(() => ws.send(JSON.stringify({ t: 'answer', bell: m.bell, choice })), 1500);
  }
  if (m.t === 'over') process.exit(0);
});
ws.on('close', () => process.exit(0));
