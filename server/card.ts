import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { resolve } from 'node:path';
import { CARD_H, CARD_W, drawCard, type Ctx2D } from '../shared/card.ts';
import type { ResultSummary } from '../shared/share.ts';

const FONTS = resolve('assets/fonts');
GlobalFonts.registerFromPath(resolve(FONTS, 'Bungee-Regular.ttf'), 'Bungee');
GlobalFonts.registerFromPath(resolve(FONTS, 'BricolageGrotesque.ttf'), 'Bricolage Grotesque');
GlobalFonts.registerFromPath(resolve(FONTS, 'JetBrainsMono.ttf'), 'JetBrains Mono');

const cache = new Map<string, Buffer>();
const MAX_CACHED = 300;

/** Renders (and caches for 10 minutes; the rank on the card moves as more people finish) the PNG card. */
export function cardPng(id: string, summary: ResultSummary): Buffer {
  const key = `${id}:${Math.floor(Date.now() / 600_000)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = createCanvas(CARD_W, CARD_H);
  drawCard(canvas.getContext('2d') as unknown as Ctx2D, summary);
  const png = canvas.toBuffer('image/png');
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, png);
  return png;
}
