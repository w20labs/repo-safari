import type { Stage } from '../game/stage.ts';
import { toast } from '../ui/toast.ts';

export interface ArenaDeps {
  stage: Stage;
  onExit(): void;
  stopRun(): void;
}

export function showArenaHome(_deps: ArenaDeps) {
  toast('Arena arrives in milestone 4.', 'amber');
}
