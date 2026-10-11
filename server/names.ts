/** Input cleaning for player-chosen text. Pure, so tests don't need the database. */

export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // "@name" is reserved for verified GitHub accounts
    .replace(/^@+\s*/, '')
    .slice(0, 24);
}

/** Team slugs: lowercase letters, digits and dashes, 2–24 long. Anything else becomes ''. */
export function cleanTeam(raw: unknown): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return s.length >= 2 ? s : '';
}

