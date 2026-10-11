import { describe, expect, it } from 'vitest';
import { exclusionReason, mentionsName, pickVariety, stripName, type GhRepo } from '../server/rising-filter.ts';

const repo = (full: string, description: string | null, extra: Partial<GhRepo> = {}): GhRepo => {
  const [owner, name] = full.split('/');
  return { full_name: full, name, owner: { login: owner }, description, language: 'Rust', stargazers_count: 1000, ...extra };
};

describe('rising filters', () => {
  it('excludes unsafe or unusable repos', () => {
    expect(exclusionReason(repo('a/x', 'PoC for CVE-2026-12345 in some router firmware'))).toMatch(/exploit/);
    expect(exclusionReason(repo('a/x', 'Make AI text undetectable by any AI detector tool'))).toMatch(/evasion/);
    expect(exclusionReason(repo('a/x', 'Remove the watermark from generated images in one click'))).toMatch(/watermark/);
    expect(exclusionReason(repo('a/x', 'Bulk account generator for popular social networks today'))).toMatch(/credential/);
    expect(exclusionReason(repo('a/x', 'A curated collection of NSFW image prompts for models'))).toMatch(/adult/);
    expect(exclusionReason(repo('a/x', null))).toMatch(/description/);
    expect(exclusionReason(repo('a/x', '为插件生态打造的现代化桌面端解决方案 DeepSeek'))).toMatch(/English/);
    expect(exclusionReason(repo('a/x', 'A fast terminal file manager with image previews'))).toBeNull();
  });

  it('keeps variety across languages', () => {
    const many = Array.from({ length: 20 }, (_, i) => repo(`o/r${i}`, 'desc', { language: i < 10 ? 'Python' : `L${i}`, stargazers_count: 1000 - i }));
    const picked = pickVariety(many, 12, 3);
    expect(picked).toHaveLength(12);
    expect(picked.filter((r) => r.language === 'Python')).toHaveLength(3);
  });

  it('strips a leading name and rejects clues that would leave a hole', () => {
    const r = repo('acme/rocket-cli', 'rocket-cli: a tiny launcher for shell scripts');
    expect(stripName(r.description!, r)).toBe('A tiny launcher for shell scripts.');
    expect(stripName('rocket-cli: a tiny launcher for scripts, by acme', r)).toBeNull();
    expect(stripName('The fast rocket-cli launcher for scripts', r)).toBeNull();
    expect(mentionsName('A tool for rockets', r)).toBe(false);
    expect(mentionsName('Rocket CLI makes launching easy', r)).toBe(true);
  });

  it('catches free-access-to-paid-AI wording and tracking/spoofing tools', () => {
    expect(exclusionReason(repo('a/x', 'Wrap Gemini CLI and Claude Code as an OpenAI-compatible API service so you can enjoy the free Claude model through API'))).toMatch(/paid AI/);
    expect(exclusionReason(repo('a/x', 'Use ChatGPT on the web without using Codex quota at all'))).toMatch(/paid AI/);
    expect(exclusionReason(repo('a/x', 'The most advanced browser fingerprinting library for identifying visitors'))).toMatch(/tracking/);
    expect(exclusionReason(repo('a/x', 'Module that helps pass Play Integrity checks on rooted phones'))).toMatch(/tracking/);
  });

  it('does not block ordinary tools that share a word with a blocked category', () => {
    expect(exclusionReason(repo('a/x', 'Cheat sheets for every language you use at work'))).toBeNull();
    expect(exclusionReason(repo('a/x', 'Envelope encryption helpers for AWS KMS keys'))).toBeNull();
  });
});

