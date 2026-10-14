import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// tagline() lives in the page template (plain JS); load it from there so the test checks the real thing
const src = readFileSync('prototypes/repo-safari.template.html', 'utf8');
const start = src.indexOf('const EMOJI = '), code = src.slice(start, src.indexOf('\n};\n', start) + 3);
const tagline = new Function(`${code}; return tagline;`)() as (d: string | null) => string;

describe('sticker descriptions', () => {
  it('removes whole emoji, including skin tones, keycaps, flags and joined sequences', () => {
    expect(tagline('👍🏽 Build things')).toBe('Build things');
    expect(tagline('Press 1️⃣ to continue')).toBe('Press to continue');
    expect(tagline('🇺🇸 Flags')).toBe('Flags');
    expect(tagline('👩‍💻 Dev tools 🚀')).toBe('Dev tools');
    expect(tagline('📝A simple editor')).toBe('A simple editor');
  });
  it('keeps ordinary symbols', () => {
    expect(tagline('Copyright © 2026 Acme® Tool™')).toBe('Copyright © 2026 Acme® Tool™');
  });
  it('removes :shortcodes: next to punctuation, but not times or colon-separated words', () => {
    expect(tagline('Tools: :rocket:, :sparkles:.')).toBe('Tools.');
    expect(tagline(':rocket: Fast (and :sparkles:) tool')).toBe('Fast (and) tool');
    expect(tagline('Meet at 12:00:30 ok')).toBe('Meet at 12:00:30 ok');
    expect(tagline('see foo:bar:baz')).toBe('see foo:bar:baz');
  });
  it('is never empty', () => {
    expect(tagline('🚀 :rocket:')).toBe('No text description provided.');
    expect(tagline('')).toBe('No description on GitHub.');
    expect(tagline(null)).toBe('No description on GitHub.');
  });
  it('leaves every real description readable', () => {
    const rooms = JSON.parse(readFileSync('shared/data/rooms.json', 'utf8')).rooms as { repos: { desc: string | null }[] }[];
    for (const r of rooms.flatMap((x) => x.repos)) {
      const t = tagline(r.desc);
      expect(t.length).toBeGreaterThan(3);
      expect(t).not.toMatch(/[\u{1F3FB}-\u{1F3FF}️⃣‍]/u);
    }
  });
});
