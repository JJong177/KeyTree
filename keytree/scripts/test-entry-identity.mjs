import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const output = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-entry-identity-"));
try {
  const outfile = join(output, "entry-identity.mjs");
  await build({
    entryPoints: [join(project, "src/lib/entry-identity.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const identity = await import(pathToFileURL(outfile).href);

  await test("URL parsing accepts valid web URLs and schemeless hosts with numeric ports", () => {
    for (const [input, expected] of [
      [" example.com/path?q=1 ", "https://example.com/path?q=1"],
      ["localhost:5173/login", "https://localhost:5173/login"],
      ["192.168.1.12:8080", "https://192.168.1.12:8080/"],
      ["https://Example.com:443/path", "https://example.com/path"],
      ["http://example.com:80/", "http://example.com/"],
    ]) {
      assert.equal(identity.parseWebUrl(input)?.href, expected, input);
    }
    assert.equal(identity.parseWebUrl("  Example.com  ")?.hostname, "example.com");
  });

  await test("URL parsing rejects non-web schemes and malformed/invalid hosts", () => {
    for (const input of [
      "javascript:alert(1)", "mailto:user@example.com", "ftp://example.com",
      "file:///tmp/a", "https://", "https://bad_host.example", "https://-bad.example",
      "https://example..com", "https://example.com:abc", "example.com:abc/path",
      "https://example.com:70000", "https://999.999.999.999", "   ", "not a host",
    ]) assert.equal(identity.parseWebUrl(input), null, input);
  });

  await test("username groups use exact trimmed case, count sites and omit trashed entries", () => {
    const entries = [
      { uuid: "1", title: "A", username: " Alice ", url: "https://Example.com/a", inTrash: false, password: "PRIVATE" },
      { uuid: "2", title: "B", username: "Alice", url: "http://example.com/b?x=1", inTrash: false, totp: "PRIVATE" },
      { uuid: "3", title: "C", username: "Alice", url: "https://example.com:8443/", inTrash: false },
      { uuid: "4", title: "D", username: "alice", url: "https://other.example/", inTrash: false },
      { uuid: "5", title: "E", username: " ", url: "bad url", inTrash: false },
      { uuid: "6", title: "F", username: "Alice", url: "https://hidden.example/", inTrash: true },
    ];
    assert.equal(identity.usernameKey("  Alice \n"), "Alice");
    assert.deepEqual(identity.buildUsernameGroups(entries), [
      { username: "Alice", entryCount: 3, siteCount: 2 },
      { username: "alice", entryCount: 1, siteCount: 1 },
      { username: "", entryCount: 1, siteCount: 0 }
    ]);
  });

  await test("credential candidates contain only public metadata, normalized sites, and safe timestamps", () => {
    const candidates = identity.buildCredentialCandidates([
      { uuid: "visible", title: "Example", username: " alice ", url: "https://Example.com/path", inTrash: false, lastUsedAt: new Date("2025-01-02T03:04:05.000Z"), password: "PRIVATE", totp: "PRIVATE" },
      { uuid: "unused", title: "Unused", username: "alice", url: "example.test", inTrash: false, lastUsedAt: null, password: "PRIVATE" },
      { uuid: "unsafe-time", title: "Bad time", username: "bad", url: "bad.example", lastUsedAt: Number.NaN },
      { uuid: "legacy", title: "Legacy", username: "legacy", url: "legacy.example" },
      { uuid: "trash", title: "Trash", username: "hidden", url: "https://trash.example", inTrash: true, password: "PRIVATE" },
    ]);
    assert.deepEqual(candidates, [
      { uuid: "visible", title: "Example", username: " alice ", url: "https://Example.com/path", site: "example.com", lastUsedAt: Date.parse("2025-01-02T03:04:05.000Z") },
      { uuid: "unused", title: "Unused", username: "alice", url: "example.test", site: "example.test", lastUsedAt: null },
      { uuid: "unsafe-time", title: "Bad time", username: "bad", url: "bad.example", site: "bad.example", lastUsedAt: null },
      { uuid: "legacy", title: "Legacy", username: "legacy", url: "legacy.example", site: "legacy.example" },
    ]);
    assert.deepEqual(Object.keys(candidates[0]).sort(), ["lastUsedAt", "site", "title", "url", "username", "uuid"]);
    assert.equal(JSON.stringify(candidates).includes("PRIVATE"), false);
  });

  await test("similar entries match only exact trimmed accounts and valid host-port sites", () => {
    const entries = [
      { uuid: "match", title: "Same site", username: " Alice ", url: "https://Example.test:8443/old", groupUuid: "g1", inTrash: false, password: "SECRET", totp: "SECRET" },
      { uuid: "case", title: "Case differs", username: "alice", url: "http://example.test:8443/new", inTrash: false },
      { uuid: "port", title: "Port differs", username: "Alice", url: "https://example.test/", inTrash: false },
      { uuid: "subdomain", title: "Subdomain differs", username: "Alice", url: "https://www.example.test:8443/", inTrash: false },
      { uuid: "trash", title: "Trash", username: "Alice", url: "https://example.test:8443/", inTrash: true },
      { uuid: "invalid", title: "Invalid", username: "Alice", url: "javascript:alert(1)", inTrash: false },
    ];
    const matches = identity.findSimilarEntries(entries, "Alice ", "http://example.test:8443/new?x=1#part");
    assert.deepEqual(matches, [{ uuid: "match", title: "Same site", username: " Alice ", url: "https://Example.test:8443/old", site: "example.test:8443", groupUuid: "g1" }]);
    assert.deepEqual(Object.keys(matches[0]).sort(), ["groupUuid", "site", "title", "url", "username", "uuid"]);
    assert.deepEqual(identity.findSimilarEntries(entries, "  ", "https://example.test:8443"), []);
    assert.deepEqual(identity.findSimilarEntries(entries, "Alice", "not a valid URL"), []);
    assert.equal(JSON.stringify(matches).includes("SECRET"), false);
  });

  await test("credential candidates sort by exact preferred account, recency, title, then UUID without mutation", () => {
    const candidates = [
      { uuid: "z", title: "Beta", username: "other", url: "", site: null, lastUsedAt: 300 },
      { uuid: "unused-b", title: "Beta", username: " Alice ", url: "", site: null, lastUsedAt: null },
      { uuid: "tie-b", title: "Alpha", username: "Alice", url: "", site: null, lastUsedAt: 200 },
      { uuid: "preferred-recent", title: "Zulu", username: "Alice", url: "", site: null, lastUsedAt: 500 },
      { uuid: "tie-a", title: "Alpha", username: "Alice", url: "", site: null, lastUsedAt: 200 },
      { uuid: "unused-a", title: "Alpha", username: "Alice", url: "", site: null },
    ];
    const original = candidates.slice();
    assert.deepEqual(identity.sortCredentialCandidates(candidates, " Alice ").map(candidate => candidate.uuid), [
      "preferred-recent", "tie-a", "tie-b", "unused-a", "unused-b", "z",
    ]);
    assert.deepEqual(identity.sortCredentialCandidates(candidates).map(candidate => candidate.uuid), [
      "preferred-recent", "z", "tie-a", "tie-b", "unused-a", "unused-b",
    ]);
    assert.deepEqual(candidates, original);
  });
} finally {
  await rm(output, { recursive: true, force: true });
}
