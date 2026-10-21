export interface SearchEntry {
  title: string; username: string; url: string; tags: string[];
  lastUsedAt?: number | Date | null; updatedAt?: number | Date | null; favorite?: boolean;
  uuid?: string; id?: string;
}
export function queryTokens(query: string): string[] {
  return [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
}
export function matchScore(entry: SearchEntry, query: string): number {
  const tokens = queryTokens(query);
  const fields = [entry.title, entry.username, entry.url, ...entry.tags].map(s => s.toLocaleLowerCase());
  let score = 0;
  for (const token of tokens) {
    const scores = fields.map((s, i) => s === token ? 100 - i : s.startsWith(token) ? 60 - i : s.includes(token) ? 20 - i : -1);
    const best = Math.max(...scores);
    if (best < 0) return -1;
    score += best;
  }
  return score;
}
export function timestamp(value?: number | Date | null): number {
  const n = value instanceof Date ? value.getTime() : value ?? 0;
  return Number.isFinite(n) ? n : 0;
}
export function searchEntries<T extends SearchEntry>(entries: T[], query: string, mode: "recent" | "title" | "used" = "used"): T[] {
  const scored = entries.map(entry => ({ entry, score: matchScore(entry, query) })).filter(item => item.score >= 0);
  scored.sort((a, b) => {
    const x = a.entry, y = b.entry;
    const primary = mode === "title" ? x.title.localeCompare(y.title, "zh-Hans-CN")
      : mode === "recent" ? timestamp(y.updatedAt) - timestamp(x.updatedAt)
      : timestamp(y.lastUsedAt) - timestamp(x.lastUsedAt) || Number(!!y.favorite) - Number(!!x.favorite) || b.score - a.score;
    return primary || b.score - a.score || x.title.localeCompare(y.title, "zh-Hans-CN") || (x.uuid ?? x.id ?? "").localeCompare(y.uuid ?? y.id ?? "");
  });
  return scored.map(item => item.entry);
}
export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const tokens = queryTokens(query), lower = text.toLocaleLowerCase();
  const hits = Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    let start = 0, at: number;
    while ((at = lower.indexOf(token, start)) >= 0) {
      for (let i = at; i < at + token.length; i++) hits[i] = true;
      start = at + Math.max(1, token.length);
    }
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === hits[i]) last.text += text[i];
    else parts.push({ text: text[i], hit: hits[i] });
  }
  return parts;
}
