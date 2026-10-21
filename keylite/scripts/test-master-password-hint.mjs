import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const k = require(join(project, 'vendor/kdbxweb/dist/kdbxweb.js'));
const { build } = require('esbuild');
const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'keytree-hint-test-'));
try {
  const output = join(dir, 'hint.mjs');
  await build({ entryPoints:[join(project,'src/lib/master-password-hint.ts')], outfile:output, bundle:true, format:'esm', platform:'node', logLevel:'silent' });
  const m = await import(pathToFileURL(output).href);
  const credentials = () => new k.Credentials(k.ProtectedValue.fromString('SYNTHETIC_ONLY'));
  const create = () => { const db = k.Kdbx.create(credentials(), 'Synthetic'); db.setKdf(k.Consts.KdfId.Aes); return db; };
  await test('public hint travels inside encrypted KDBX and is readable without credentials', async () => {
    const db = create();
    m.writeMasterHint(k, db.header, '合成记忆线索');
    const bytes = await db.save();
    assert.deepEqual(m.parseMasterHint(k, new Uint8Array(bytes)), { kind:'hint', text:'合成记忆线索' });
    const reopened = await k.Kdbx.load(bytes, credentials());
    assert.equal(m.readMasterHint(reopened.header).text, '合成记忆线索');
  });
  await test('editing/deleting/another save preserves unrelated public data and authenticates normally', async () => {
    const db = create();
    db.header.publicCustomData = new k.VarDictionary();
    db.header.publicCustomData.set('foreign.example', k.VarDictionary.ValueType.Bytes, new Uint8Array([1,2,3]).buffer);
    m.writeMasterHint(k, db.header, 'first'); m.writeMasterHint(k, db.header, 'second');
    const saved = await db.save();
    const loaded = await k.Kdbx.load(saved, credentials());
    assert.equal(m.readMasterHint(loaded.header).text, 'second');
    assert.deepEqual([...new Uint8Array(loaded.header.publicCustomData.get('foreign.example'))], [1,2,3]);
    m.writeMasterHint(k, loaded.header, '');
    const removed = await loaded.save();
    assert.equal(m.parseMasterHint(k, new Uint8Array(removed)).kind, 'none');
    const copy = await k.Kdbx.load(removed, credentials());
    assert.deepEqual([...new Uint8Array(copy.header.publicCustomData.get('foreign.example'))], [1,2,3]);
  });
  await test('hint supports 200 Unicode code points and rejects longer or NUL without mutation', () => {
    const db = create();
    m.writeMasterHint(k, db.header, '🌿'.repeat(200));
    assert.equal([...m.readMasterHint(db.header).text].length, 200);
    const before = m.publicDataSnapshot(k, db.header);
    assert.throws(() => m.writeMasterHint(k, db.header, '🌿'.repeat(201)));
    assert.throws(() => m.writeMasterHint(k, db.header, 'a\0b'));
    assert.equal(m.publicDataSnapshot(k, db.header), before);
  });
  await test('old KDBX is not silently upgraded and hints of invalid types are never displayed', () => {
    const db = create(); db.setVersion(3);
    assert.equal(m.readMasterHint(db.header).kind, 'unsupported');
    assert.throws(() => m.writeMasterHint(k, db.header, 'no upgrade'));
    assert.equal(db.versionMajor, 3);
    const current = create();
    current.header.publicCustomData = new k.VarDictionary();
    current.header.publicCustomData.set(m.MASTER_HINT_KEY, k.VarDictionary.ValueType.UInt32, 42);
    assert.equal(m.readMasterHint(current.header).kind, 'invalid');
    current.header.publicCustomData.set(m.MASTER_HINT_KEY, k.VarDictionary.ValueType.String, 'x'.repeat(201));
    assert.equal(m.readMasterHint(current.header).kind, 'invalid');
  });
  await test('parser safely rejects truncated or oversized outer fields and malformed dictionaries', async () => {
    const bytes = new Uint8Array(await create().save());
    for (const n of [0,4,11,16,bytes.length > 100 ? 100 : 20]) assert.equal(m.parseMasterHint(k, bytes.slice(0,n)).kind, 'invalid');
    const huge = bytes.slice(); new DataView(huge.buffer).setUint32(13, 0xffffffff, true);
    assert.equal(m.parseMasterHint(k, huge).kind, 'too-large');
    const bad = bytes.slice(); bad[0]=0;
    assert.equal(m.parseMasterHint(k, bad).kind, 'invalid');
    const version = bytes.slice(); new DataView(version.buffer).setUint32(8, 0x00030001, true);
    assert.equal(m.parseMasterHint(k, version).kind, 'unsupported');
    const db=create();m.writeMasterHint(k,db.header,'normal');
    const dict = new Uint8Array(await db.save()); const view=new DataView(dict.buffer);let at=12;
    while(at<dict.length){const id=dict[at],size=view.getUint32(at+1,true);if(id===12){view.setInt32(at+8,0x7fffffff,true);break;}at+=5+size;}
    assert.equal(m.parseMasterHint(k,dict).kind,'invalid');
  });
  await test('both standard and vendored terminal markers work without reading trailing body', async () => {
    const db=create();m.writeMasterHint(k,db.header,'public');
    const bytes=new Uint8Array(await db.save());const view=new DataView(bytes.buffer);let at=12;
    while(bytes[at]!==0)at+=5+view.getUint32(at+1,true);
    const header=bytes.slice(0,at+9);header.set([13,10,13,10],at+5);
    assert.equal(m.parseMasterHint(k,header).text,'public');
    header[at+5]=99;assert.equal(m.parseMasterHint(k,header).kind,'invalid');
  });
  await test('HTML-looking hint remains literal text, with no URL or markup processing', async () => {
    const db=create();m.writeMasterHint(k,db.header,'<script>synthetic</script> https://example.com');
    assert.equal(m.parseMasterHint(k,new Uint8Array(await db.save())).text,'<script>synthetic</script> https://example.com');
  });
} finally { await rm(dir, {recursive:true,force:true}); }
