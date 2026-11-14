export interface EntryIdentityEntry {
  uuid: string;
  title: string;
  username: string;
  url: string;
  inTrash?: boolean;
  groupUuid?: string;
  lastUsedAt?: Date | number | null;
}

export interface UsernameGroup {
  username: string;
  entryCount: number;
  siteCount: number;
}

export interface CredentialCandidate {
  uuid: string;
  title: string;
  username: string;
  url: string;
  site: string | null;
  lastUsedAt?: number | null;
}

const HOST_PORT_PREFIX = /^(?:[a-z\d.-]+|\[[\da-f:.]+\]):\d+(?:[/?#]|$)/i;
const IPV4_HOST = /^\d+(?:\.\d+){3}$/;

function validHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host) return false;
  // URL validates IPv6 syntax while parsing and includes brackets in hostname.
  if (/^\[[\da-f:.]+\]$/i.test(host)) return true;
  if (IPV4_HOST.test(host)) {
    const octets = host.split(".").map(Number);
    return octets.length === 4 && octets.every((part) => part >= 0 && part <= 255);
  }
  if (/^[\d.]+$/.test(host)) return false;
  const dnsName = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!dnsName || dnsName.length > 253) return false;
  return dnsName.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)
  );
}

/** Parse an HTTP(S) address without changing the caller's stored input. */
export function parseWebUrl(input: string): URL | null {
  const value = input.trim();
  if (!value) return null;

  const hasHostPort = HOST_PORT_PREFIX.test(value);
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  let candidate: string;
  if (hasHostPort && explicitScheme) {
    candidate = `https://${value}`;
  } else if (explicitScheme) {
    const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null;
    candidate = value;
  } else {
    candidate = `https://${value}`;
  }

  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !validHostname(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function usernameKey(input: string): string {
  return input.trim();
}

/** Lowercase hostname and port only; invalid or non-web addresses have no site key. */
export function siteKey(input: string): string | null {
  const parsed = parseWebUrl(input);
  return parsed ? parsed.host.toLowerCase() : null;
}

const usernameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareUsernames(a: string, b: string): number {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return usernameCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function buildUsernameGroups(entries: readonly EntryIdentityEntry[]): UsernameGroup[] {
  const groups = new Map<string, { entryCount: number; sites: Set<string> }>();
  for (const entry of entries) {
    if (entry.inTrash) continue;
    const username = usernameKey(entry.username);
    let group = groups.get(username);
    if (!group) {
      group = { entryCount: 0, sites: new Set<string>() };
      groups.set(username, group);
    }
    group.entryCount++;
    const site = siteKey(entry.url);
    if (site) group.sites.add(site);
  }
  return [...groups.entries()]
    .map(([username, counts]) => ({ username, entryCount: counts.entryCount, siteCount: counts.sites.size }))
    .sort((a, b) => compareUsernames(a.username, b.username));
}

function safeTimestamp(value: Date | number | null): number | null {
  const timestamp = value instanceof Date ? value.getTime() : value;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

export function buildCredentialCandidates(entries: readonly EntryIdentityEntry[]): CredentialCandidate[] {
  return entries
    .filter((entry) => !entry.inTrash)
    .map((entry) => ({
      uuid: entry.uuid,
      title: entry.title,
      username: entry.username,
      url: entry.url,
      site: siteKey(entry.url),
      ...(entry.lastUsedAt !== undefined ? { lastUsedAt: safeTimestamp(entry.lastUsedAt) } : {}),
    }));
}

export interface SimilarEntry {
  uuid: string;
  title: string;
  username: string;
  url: string;
  site: string;
  groupUuid?: string;
}

export function findSimilarEntries(
  entries: readonly EntryIdentityEntry[],
  username: string,
  url: string,
): SimilarEntry[] {
  const account = usernameKey(username);
  const site = siteKey(url);
  if (!account || !site) return [];

  const matches: SimilarEntry[] = [];
  for (const entry of entries) {
    if (entry.inTrash || usernameKey(entry.username) !== account || siteKey(entry.url) !== site) continue;
    matches.push({
      uuid: entry.uuid,
      title: entry.title,
      username: entry.username,
      url: entry.url,
      site,
      ...(entry.groupUuid !== undefined ? { groupUuid: entry.groupUuid } : {}),
    });
  }
  return matches;
}

const candidateTitleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareStableText(a: string, b: string, collator: Intl.Collator): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function sortCredentialCandidates(
  candidates: readonly CredentialCandidate[],
  preferredUsername = "",
): CredentialCandidate[] {
  const preferred = usernameKey(preferredUsername);
  return [...candidates].sort((a, b) => {
    if (preferred) {
      const aPreferred = usernameKey(a.username) === preferred;
      const bPreferred = usernameKey(b.username) === preferred;
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    }

    const aTime = typeof a.lastUsedAt === "number" && Number.isFinite(a.lastUsedAt) ? a.lastUsedAt : null;
    const bTime = typeof b.lastUsedAt === "number" && Number.isFinite(b.lastUsedAt) ? b.lastUsedAt : null;
    if (aTime !== bTime) {
      if (aTime === null) return 1;
      if (bTime === null) return -1;
      return bTime - aTime;
    }
    return compareStableText(a.title, b.title, candidateTitleCollator)
      || compareStableText(a.uuid, b.uuid, candidateTitleCollator);
  });
}
