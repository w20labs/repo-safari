import { DAILY_UNLOCK, dailyCourse, practiceCourse } from '../shared/course.ts';
import { dailyQuestion, defaultContext, makeQuestion } from '../shared/questions.ts';
import { poolRepos } from '../shared/rising.ts';
import { dateKey, prettyDate, randomRng } from '../shared/rng.ts';
import { formatScore } from '../shared/scoring.ts';
import type { Repo, RisingPool } from '../shared/types.ts';
import { Stage } from './game/stage.ts';
import { me, renderWho, setMe } from './identity.ts';
import { Backdrop } from './modes/backdrop.ts';
import { SoloRun, fastestLabel, type SoloOutcome } from './modes/solo.ts';
import { api, type PlayerStats } from './net/api.ts';
import { $, h } from './ui/dom.ts';
import { clearHud } from './ui/hud.ts';
import { icon } from './ui/icons.ts';
import { boardTable, leaderboardCard, teamInviteLink } from './ui/leaderboard.ts';
import { howToCard, menuPanel } from './ui/menu.ts';
import { statsCard } from './ui/stats.ts';
import { hideOverlay, showOverlay } from './ui/overlay.ts';
import { showResults } from './ui/results.ts';
import { clearToasts, toast } from './ui/toast.ts';
import { initTouchpad } from './ui/touchpad.ts';

const stage = new Stage($('#world') as HTMLCanvasElement);
let run: SoloRun | null = null;
let risingPool: RisingPool | null = null;
let playedToday = false;
let online = false;
let stats: PlayerStats | null = null;

function stopRun() {
  run?.dispose();
  run = null;
  clearHud();
  clearToasts();
}

function backToMenu() {
  history.replaceState(null, '', '/');
  showMenu();
}

function showMenu() {
  stopRun();
  stage.run(new Backdrop());
  showOverlay(
    menuPanel({
      playerNum: String(me.num).padStart(3, '0'),
      name: me.name,
      team: me.team,
      dailyTag: !online
        ? ''
        : [stats && stats.currentStreak >= 1 ? `Streak ${stats.currentStreak}` : '', playedToday ? 'Played today · replays only' : 'Official run ready'].filter(Boolean).join(' · '),
      onName: (name) => {
        setMe({ name });
        api.updateMe({ name }).then((r) => setMe({ name: r.name })).catch(() => undefined);
      },
      onTeam: (team) => void joinTeam(team),
      onDaily: showDailyIntro,
      onPractice: startPractice,
      onArena: () => openArena(),
    }),
  );
  void refreshBoard();
}

async function joinTeam(raw: string) {
  try {
    const r = await api.updateMe({ team: raw });
    setMe({ team: r.team });
    if (r.team) toast(`You're on team ${r.team}. Share ${teamInviteLink(r.team)} with your team.`, 'teal', { ms: 4500 });
    else if (raw) toast('Team names need 2–24 letters, digits or dashes.', 'pink');
    void refreshBoard(r.team ? 'team' : 'all');
  } catch {
    toast('Teams need the server. Try again in a moment.', 'pink');
  }
}

async function refreshBoard(tab: 'all' | 'team' | 'teams' = 'all') {
  const below = $('#below');
  const board = await leaderboardCard(dateKey(), tab);
  below.replaceChildren(board, statsCard(stats), howToCard());
}

// ---------- Arena ----------

function openArena(joinCode?: string) {
  import('./modes/arena-ui.ts')
    .then((m) => m.showArenaHome({ stage, onExit: backToMenu, stopRun, joinCode }))
    .catch(() => toast('The Arena could not load.', 'pink'));
}

// ---------- Practice ----------

function startPractice() {
  stopRun();
  const course = practiceCourse(randomRng(), risingPool);
  const ctx = defaultContext(poolRepos(risingPool));
  const rng = randomRng();
  run = new SoloRun(stage, {
    kind: 'practice',
    modeLabel: 'Practice',
    date: dateKey(),
    course,
    questionFor: (i) => makeQuestion(course.platforms[i].repo, rng, ctx),
    playerNum: me.num,
    name: me.name || undefined,
    bots: true,
    onEnd: (o) =>
      setTimeout(() => showResults({
        summary: o.summary,
        reason: o.reason,
        stats: [
          { label: 'Score', value: formatScore(o.score), cls: 'score' },
          { label: 'Cleared', value: o.summary.statLine.replace(' cleared', '') },
          { label: 'Players left', value: String(o.playersLeft ?? '–') },
        ],
        url: location.origin,
        actions: [
          { label: 'Play again', icon: 'refresh', primary: true, onClick: startPractice },
          { label: 'Menu', icon: 'back', onClick: backToMenu },
        ],
      }), o.won ? 900 : 350),
  });
  stage.run(run);
  hideOverlay();
}

// ---------- Daily ----------

function showDailyIntro() {
  const date = dateKey();
  const official = online && !playedToday;
  const start = h('button', { type: 'button', class: 'btn primary', onclick: () => startDaily() }, icon('play'), official ? 'Start official run' : 'Play replay');
  showOverlay(
    h('div', { class: 'panel' },
      h('div', { class: 'eyebrow' }, icon('calendar', 14), `Daily · ${prettyDate(date)}`),
      h('h2', { class: 'title', style: { fontSize: 'clamp(26px, 5vw, 38px)', marginTop: '8px' } }, official ? 'One shot.' : playedToday ? 'Replay' : 'Offline'),
      h('p', { class: 'lede' },
        official
          ? `Everyone gets the same 12 platforms today. This first run is your official one and goes on the leaderboard. No restarts.`
          : playedToday
            ? `You've already played your official run today. Replays are just for fun and don't count.`
            : `The server can't be reached, so this run won't count. Same course as everyone else, though.`),
      h('ul', { class: 'howto', style: { marginTop: '12px' } },
        h('li', null, `The exit gate opens after `, h('b', null, `${DAILY_UNLOCK} cleared platforms`), '. Walking through it is worth +500.'),
        h('li', null, h('b', null, 'Gold'), ' platforms move, pay double and give you only 8 seconds.'),
        h('li', null, 'Higher platforms multiply your points, up to about ', h('b', null, '×2.0'), '.'),
      ),
      h('div', { class: 'row', style: { marginTop: '18px' } }, start, h('button', { type: 'button', class: 'btn ghost', onclick: backToMenu }, 'Back')),
    ),
  );
  start.focus();
}

async function startDaily() {
  stopRun();
  const date = dateKey();
  let runId: string | null = null;
  let official = false;
  let pool: RisingPool | null = null;
  let repos: Repo[] | null = null;
  try {
    const r = await api.dailyStart();
    runId = r.runId;
    official = r.official;
    pool = r.pool;
    repos = r.repos;
    playedToday = true;
  } catch {
    try {
      ({ pool, repos } = await api.dailyCourse(date));
    } catch {
      /* offline: computed locally from the date seed */
    }
  }
  const course = dailyCourse(date, pool, repos);
  const ctx = defaultContext(poolRepos(pool));
  run = new SoloRun(stage, {
    kind: 'daily',
    modeLabel: official ? 'Daily' : 'Daily replay',
    date,
    course,
    questionFor: (i) => dailyQuestion(date, i, course.platforms[i].repo, ctx),
    playerNum: me.num,
    name: me.name || undefined,
    official,
    onEnd: (o) => void dailyResults(o, official ? runId : null),
  });
  stage.run(run);
  hideOverlay();
}

async function dailyResults(o: SoloOutcome, runId: string | null) {
  let rank: number | null = null;
  let permalink: string | undefined;
  let note: string | undefined;
  if (runId) {
    try {
      const r = await api.dailyFinish({ runId, results: o.results, score: o.score, won: o.won, outLabel: o.summary.outLine });
      rank = r.rank;
      stats = r.stats;
      o.summary.rankLine = [r.rankLine, fastestLabel(o.fastestMs)].filter(Boolean).join(' · ');
      permalink = `${location.origin}/r/${runId}`;
    } catch (e) {
      note = `This run couldn't be saved: ${(e as Error).message}.`;
    }
  } else note = online ? `Replays don't count toward the leaderboard.` : `Offline run. It isn't on the leaderboard.`;

  let extra: HTMLElement | null = null;
  try {
    const b = await api.leaderboard(dateKey());
    extra = h('div', { class: 'card', style: { marginTop: '16px', textAlign: 'left' } }, h('h2', null, icon('trophy'), `Today's top 10`), boardTable(b));
  } catch {
    /* no board offline */
  }
  setTimeout(() => {
    showResults({
      summary: o.summary,
      reason: o.reason,
      note,
      stats: [
        { label: 'Score', value: formatScore(o.score), cls: 'score' },
        { label: 'Cleared', value: o.summary.statLine.replace(' cleared', '') },
        { label: runId ? 'Rank today' : 'Run', value: rank ? `#${rank}` : runId ? '–' : 'Replay' },
        ...(runId && stats ? [{ label: 'Streak', value: String(stats.currentStreak), cls: 'hot' }] : []),
      ],
      url: permalink ?? location.origin,
      permalink,
      extra,
      actions: [
        { label: 'Replay course', icon: 'refresh', primary: true, onClick: startDaily },
        { label: 'Practice', icon: 'target', onClick: startPractice },
        { label: 'Menu', icon: 'back', onClick: backToMenu },
      ],
    });
    void refreshBoard();
  }, o.won ? 900 : 350);
}

// ---------- boot ----------

async function init() {
  renderWho();
  initTouchpad();
  $('#below').replaceChildren(howToCard());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && run && !run.official && !document.querySelector('.question')) backToMenu();
  });
  const params = new URLSearchParams(location.search);
  try {
    const m = await api.me();
    setMe({ id: m.id, num: m.num, name: m.name || me.name, team: m.team });
    if (!m.name && me.name) void api.updateMe({ name: me.name });
    playedToday = m.playedToday;
    stats = m.stats;
    online = true;
  } catch {
    online = false;
  }
  const teamParam = params.get('team');
  if (teamParam && online && teamParam.toLowerCase() !== me.team) await joinTeam(teamParam);
  api.rising().then((p) => (risingPool = p.repos?.length >= 2 && p.asOf ? p : null)).catch(() => undefined);
  const room = params.get('room');
  if (room && /^[a-z0-9]{4}$/i.test(room)) {
    showMenu();
    openArena(room.toLowerCase());
  } else if (params.get('play') === 'daily') {
    showMenu();
    showDailyIntro();
  } else showMenu();
}

void init();
