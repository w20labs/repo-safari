import { practiceCourse } from '../shared/course.ts';
import { defaultContext, makeQuestion } from '../shared/questions.ts';
import { dateKey, randomRng } from '../shared/rng.ts';
import { formatScore } from '../shared/scoring.ts';
import { Stage } from './game/stage.ts';
import { me, renderWho, setMe } from './identity.ts';
import { Backdrop } from './modes/backdrop.ts';
import { SoloRun, type SoloOutcome } from './modes/solo.ts';
import { $ } from './ui/dom.ts';
import { clearHud } from './ui/hud.ts';
import { howToCard, menuPanel } from './ui/menu.ts';
import { showOverlay } from './ui/overlay.ts';
import { showResults } from './ui/results.ts';
import { clearToasts, toast } from './ui/toast.ts';
import { initTouchpad } from './ui/touchpad.ts';

const stage = new Stage($('#world') as HTMLCanvasElement);
let run: SoloRun | null = null;

function stopRun() {
  run?.dispose();
  run = null;
  clearHud();
  clearToasts();
}

function showMenu() {
  stopRun();
  stage.run(new Backdrop());
  showOverlay(
    menuPanel({
      playerNum: String(me.num).padStart(3, '0'),
      name: me.name,
      dailyTag: '',
      onName: (name) => setMe({ name }),
      onDaily: () => toast('Daily mode arrives in milestone 2.', 'amber'),
      onPractice: startPractice,
      onArena: () => toast('Arena arrives in milestone 4.', 'amber'),
    }),
  );
}

function startPractice() {
  stopRun();
  const course = practiceCourse(randomRng(), null);
  const ctx = defaultContext();
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
    onEnd: practiceResults,
  });
  stage.run(run);
  $('#overlay').hidden = true;
}

function practiceResults(o: SoloOutcome) {
  setTimeout(() => {
    showResults({
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
        { label: 'Menu', icon: 'back', onClick: showMenu },
      ],
    });
  }, o.won ? 900 : 350);
}

function init() {
  renderWho();
  initTouchpad();
  $('#below').replaceChildren(howToCard());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && run) showMenu();
  });
  showMenu();
}

init();
