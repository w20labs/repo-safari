import { PHYS, TOTAL_PLAYERS } from '../../shared/constants.ts';
import { practiceCourse } from '../../shared/course.ts';
import { randomRng } from '../../shared/rng.ts';
import { Bots } from '../game/bots.ts';
import type { Mode } from '../game/stage.ts';
import { World } from '../game/world.ts';
import { prefs } from '../prefs.ts';

/** Slow pan across a course full of wandering players, shown behind menus. */
export class Backdrop implements Mode {
  private world = new World(practiceCourse(randomRng(), null));
  private bots = new Bots(Array.from({ length: 8 }, () => 1 + Math.floor(Math.random() * TOTAL_PLAYERS)), this.world);
  private x = 500;

  tick(dt: number) {
    this.world.advance(dt);
    this.bots.update(dt);
    if (!prefs.reducedMotion) this.x += dt * 45;
    if (this.x > this.world.W - 900) this.x = 500;
  }

  focus() {
    return { x: this.x, y: PHYS.floorY - 260 };
  }

  scene() {
    return { world: this.world, actors: this.bots.actors(), revealCleared: false, unlockLeft: 0 };
  }
}
