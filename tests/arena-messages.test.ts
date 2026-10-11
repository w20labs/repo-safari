import { describe, expect, it } from 'vitest';
import { parseClientMsg } from '../server/arena/messages.ts';

describe('arena message validation', () => {
  it('rejects anything that is not a well-formed message', () => {
    for (const raw of ['null', '42', '"pos"', '[]', '{}', '{"t":"nope"}', 'not json', '{"t":"pos","x":"1","y":0,"vx":0,"vy":0,"g":0,"f":1}',
      '{"t":"pos","x":1,"y":0,"vx":0,"vy":0,"g":0.5,"f":1}', '{"t":"pos","x":1e999,"y":0,"vx":0,"vy":0,"g":0,"f":1}', '{"t":"answer","bell":"0","choice":1}',
      '{"t":"join","code":{}}', '{"t":"ping"}', `{"t":"hello","pid":"${'x'.repeat(41)}"}`]) {
      expect(parseClientMsg(raw), raw).toBeNull();
    }
  });

  it('accepts valid messages', () => {
    expect(parseClientMsg('{"t":"pos","x":1,"y":2,"vx":0,"vy":0,"g":-1,"f":-1}')).toEqual({ t: 'pos', x: 1, y: 2, vx: 0, vy: 0, g: -1, f: -1 });
    expect(parseClientMsg('{"t":"answer","bell":2,"choice":3}')).toEqual({ t: 'answer', bell: 2, choice: 3 });
    expect(parseClientMsg('{"t":"hello","name":"Sam"}')).toEqual({ t: 'hello', pid: '', name: 'Sam' });
    expect(parseClientMsg('{"t":"quick"}')).toEqual({ t: 'quick' });
  });
});
