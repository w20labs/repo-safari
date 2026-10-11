/** Pure helpers for the rising-repo refresh (kept separate so they're unit-testable). */

export interface GhRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  language: string | null;
  stargazers_count: number;
  topics?: string[];
  fork?: boolean;
  archived?: boolean;
  html_url?: string;
}

/** Categories we never put in the game. Matched against name, description and topics. */
const EXCLUDE: [string, RegExp][] = [
  ['exploit or proof of concept', /\bcve-\d{4}-\d+|\bexploit|\bpoc\b|proof[- ]of[- ]concept|\b0day|zero[- ]day|\brce\b|privilege escalation|\bpayloads?\b/i],
  ['detection evasion', /\bundetectable|bypass(es|ing)?\b|humani[sz]e[rd]?\b.*\b(ai|text)|ai[- ]?detect|detector evasion|anti[- ]?detect|evad(e|ing) (ai|detection)/i],
  ['watermark or provenance stripping', /watermark|provenance|c2pa|synthid|metadata strip|strip(s|ping)? metadata/i],
  ['account or credential abuse', /credential|password (crack|dump|steal)|stealer|token grabber|account (gen|creator|farm|checker)|\bcombo ?list|brute[- ]?force|phish|captcha (solver|bypass)|spam ?bot|mass (dm|report)|cookie (steal|grab)/i],
  ['adult content', /\bnsfw\b|\bporn|\bhentai|\badult\b|onlyfans|\bnude|\bxxx\b|\berotic/i],
  ['leaked prompts or free access to paid AI', /prompts?[_ -]?leaks?|leak(ed|s)? (system )?prompts?|cl4r1t4s|gpt4free|free (gpt|chatgpt|claude|ai) (api|access)|reverse[- ]engineered (api|chatgpt|openai)/i],
  ['piracy or licence bypass', /activation[- ]scripts?|\bkms\b|keygen|\bcrack(ed|s)?\b|piracy|warez|license bypass/i],
  ['tracking people', /\bosint\b|people[- ]tracker|track (people|anyone|someone)|doxx|stalk/i],
  ['offensive tooling', /post[- ]exploitation|offensive (security|powershell)|red[- ]team(ing)? (framework|toolkit)|\bc2 (framework|server)/i],
  ['cheats or malware', /\bcheat(s|ing)?\b|aimbot|\bmalware|\bransomware|\bkeylogger|\bbotnet|\brat\b/i],
];

export function exclusionReason(r: GhRepo): string | null {
  const desc = (r.description ?? '').trim();
  if (r.fork || r.archived) return 'fork or archived';
  // the game's copy is English; mixed descriptions with CJK/Cyrillic runs make poor clues
  if (/[\u3000-\u9fff\uac00-\ud7af\u0400-\u04ff\uff00-\uffef]{2,}/.test(desc)) return 'description not in English';
  if (desc.length < 20 || desc.split(/\s+/).length < 4) return 'no usable description';
  const hay = [r.full_name, desc, ...(r.topics ?? [])].join(' ');
  for (const [reason, re] of EXCLUDE) if (re.test(hay)) return reason;
  return null;
}

/** Keeps up to `max` repos, at most `perLang` per language, in star order. */
export function pickVariety(repos: GhRepo[], max = 12, perLang = 3): GhRepo[] {
  const counts = new Map<string, number>();
  const out: GhRepo[] = [];
  for (const r of [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count)) {
    const lang = r.language ?? '(none)';
    if ((counts.get(lang) ?? 0) >= perLang) continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name variants a clue must not contain: owner, repo, full name, and repo with separators as spaces. */
export function nameTokens(r: Pick<GhRepo, 'name' | 'owner'>): string[] {
  const words = r.name.split(/[-_.]+/).filter((w) => w.length >= 3);
  return [...new Set([`${r.owner.login}/${r.name}`, r.name, r.owner.login, r.name.replace(/[-_.]+/g, ' '), r.name.replace(/[-_.]+/g, ''), ...(words.length > 1 ? [] : words)])]
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
}

export function mentionsName(text: string, r: Pick<GhRepo, 'name' | 'owner'>): boolean {
  return nameTokens(r).some((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])`, 'i').test(text));
}

/** One sentence, at most ~160 characters, ending with a period. */
export function tidySentence(text: string): string {
  let s = text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`*\-–:|>]+/, '');
  // drop surrounding quotes only when they wrap the whole text
  if (/^["'`].*["'`]$/.test(s)) s = s.slice(1, -1).trim();
  s = s.replace(/\s+$/, '');
  const first = s.match(/^.+?[.!?](\s|$)/);
  if (first) s = first[0].trim();
  if (s.length > 150) s = `${s.slice(0, 147).replace(/[\s,;:]+\S*$/, '')}…`;
  if (!/[.!?…]$/.test(s)) s += '.';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Regex fallback: drop the owner/repo names. Only accepts the result when the name was a removable
 * prefix ("Foo: a fast thing", "Foo is a fast thing") or absent; anything that would leave a hole
 * mid-sentence returns null so a person (or Claude) can write the clue instead.
 */
export function stripName(desc: string, r: Pick<GhRepo, 'name' | 'owner'>): string | null {
  let s = tidySentence(desc);
  for (const t of nameTokens(r)) {
    const lead = new RegExp(`^(the\\s+)?${escapeRe(t)}(\\s*[:\\-–|,]\\s*|\\s+(is|are)\\s+)`, 'i');
    s = s.replace(lead, '');
  }
  s = tidySentence(s);
  if (s.replace(/[^a-z]/gi, '').length < 15 || mentionsName(s, r)) return null;
  return s;
}
