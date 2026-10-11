import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanName } from '../server/names.ts';

// the store opens the database on import, so point it at a throwaway file first
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'lcs-auth-')), 'test.db');
let store: typeof import('../server/store.ts');
let auth: typeof import('../server/auth.ts');
beforeAll(async () => {
  store = await import('../server/store.ts');
  auth = await import('../server/auth.ts');
});

describe('GitHub accounts', () => {
  it('links an anonymous player, then reuses it from another browser', () => {
    const anon = store.createPlayer();
    expect(store.linkGithub(anon.id, 101, 'octo')).toEqual({ playerId: anon.id, switched: false });
    expect(store.getPlayer(anon.id)).toMatchObject({ github_id: 101, github_login: 'octo' });
    const otherBrowser = store.createPlayer();
    expect(store.linkGithub(otherBrowser.id, 101, 'octo-renamed')).toEqual({ playerId: anon.id, switched: true });
    expect(store.getPlayer(anon.id)?.github_login).toBe('octo-renamed');
  });

  it('never moves one account onto a player linked to another', () => {
    const p = store.createPlayer();
    store.linkGithub(p.id, 201, 'alice');
    const r = store.linkGithub(p.id, 202, 'bob');
    expect(r.switched).toBe(true);
    expect(r.playerId).not.toBe(p.id);
    expect(store.getPlayer(r.playerId)?.github_login).toBe('bob');
    expect(store.getPlayer(p.id)?.github_login).toBe('alice');
  });

  it('shows verified players as @login', () => {
    expect(store.displayNameOf({ name: 'whatever', github_login: 'octo' })).toBe('@octo');
    expect(store.displayNameOf({ name: 'Sam', github_login: null })).toBe('Sam');
  });

  it('reserves the @ prefix and only allows same-site return paths', () => {
    expect(cleanName('@torvalds')).toBe('torvalds');
    expect(auth.safeReturn('/?play=daily')).toBe('/?play=daily');
    expect(auth.safeReturn('//evil.example')).toBe('/');
    expect(auth.safeReturn('https://evil.example')).toBe('/');
    expect(auth.safeReturn(null)).toBe('/');
  });
});
