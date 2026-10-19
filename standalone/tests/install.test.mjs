import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const id = 'com.sliceman.plugin.local';
const installer = resolve('standalone/install.ps1');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sliceman-standalone-test-'));
  const pkg = join(root, '中文 安装包');
  mkdirSync(join(pkg, 'plugin'), { recursive: true });
  assert.ok(existsSync(installer), 'standalone installer must exist');
  cpSync(installer, join(pkg, 'install.ps1'));
  const manifest = { id, version: '1.4.5', name: 'Sliceman 本地版', main: 'index.html', host: { minVersion: '23.3.0' } };
  writeFileSync(join(pkg, 'plugin/manifest.json'), JSON.stringify(manifest));
  for (const f of ['index.html', 'panel.js', 'styles.css']) writeFileSync(join(pkg, 'plugin', f), 'fixture');
  const data = join(root, 'data');
  const info = join(data, 'Adobe/UXP/PluginsInfo/v1/PS.json');
  mkdirSync(join(data, 'Adobe/UXP/PluginsInfo/v1'), { recursive: true });
  const original = { pluginId: 'com.sliceman.plugin', versionString: '1.4.5', extra: { keep: true } };
  const originalPayload = join(data, 'Adobe/UXP/Plugins/External/com.sliceman.plugin_1.4.5');
  mkdirSync(originalPayload, { recursive: true });
  writeFileSync(join(originalPayload, 'panel.js'), 'original CC edition must remain byte-identical');
  writeFileSync(info, JSON.stringify({ plugins: [original], other: { preserve: true } }));
  const run = (...args) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(pkg, 'install.ps1'), '-SandboxRoot', root, ...args], { encoding: 'utf8' });
  return { root, pkg, data, info, original, run, manifest };
}
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }
function json(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }

test('install/reinstall/upgrade/uninstall preserve original edition and unknown metadata', () => {
  const f = fixture();
  for (const version of ['1.4.5', '1.4.5', '1.4.6']) {
    writeFileSync(join(f.pkg, 'plugin/manifest.json'), JSON.stringify({ ...f.manifest, version }));
    ok(f.run());
    const state = json(f.info);
    assert.deepEqual(state.plugins.find(p => p.pluginId === f.original.pluginId), f.original);
    assert.deepEqual(state.other, { preserve: true });
    assert.equal(state.plugins.filter(p => p.pluginId === id).length, 1);
    assert.equal(state.plugins.find(p => p.pluginId === id).versionString, version);
    assert.ok(existsSync(join(f.data, `Adobe/UXP/Plugins/External/${id}_${version}/panel.js`)));
  }
  ok(f.run('-Uninstall'));
  ok(f.run('-Uninstall'));
  assert.deepEqual(json(f.info).plugins, [f.original]);
  assert.equal(readFileSync(join(f.data, 'Adobe/UXP/Plugins/External/com.sliceman.plugin_1.4.5/panel.js'), 'utf8'), 'original CC edition must remain byte-identical');
  assert.equal(readdirSync(join(f.data, 'Adobe/UXP/Plugins/External')).filter(n => n.startsWith(id + '_')).length, 0);
  assert.ok(readdirSync(join(f.data, 'Adobe/UXP/SlicemanLocalBackups')).length >= 4);
});

test('invalid metadata is rejected without touching it', () => {
  for (const content of ['{bad', '{"plugins":{}}', '{"plugins":null}']) {
    const f = fixture();
    writeFileSync(f.info, content);
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(f.info, 'utf8'), content);
    assert.deepEqual(readdirSync(join(f.data, 'Adobe/UXP/Plugins/External')), ['com.sliceman.plugin_1.4.5']);
  }
});

test('reject original identity before mutation', () => {
  const f = fixture();
  const before = readFileSync(f.info, 'utf8');
  writeFileSync(join(f.pkg, 'plugin/manifest.json'), JSON.stringify({ ...f.manifest, id: 'com.sliceman.plugin' }));
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.info, 'utf8'), before);
});

test('incomplete payload leaves registration unchanged', () => {
  const f = fixture();
  const before = readFileSync(f.info, 'utf8');
  renameSync(join(f.pkg, 'plugin/panel.js'), join(f.pkg, 'plugin/panel.missing'));
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.info, 'utf8'), before);
});

test('redirected plugin directory is refused without modifying its target', () => {
  const f = fixture();
  const other = join(f.root, 'unrelated');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'preserve');
  const external = join(f.data, 'Adobe/UXP/Plugins/External');
  mkdirSync(external, { recursive: true });
  symlinkSync(other, join(external, id + '_1.4.5'), 'junction');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'preserve');
  assert.deepEqual(json(f.info).plugins, [f.original]);
});

test('failed metadata commit rolls back the previous local payload', () => {
  const f = fixture();
  ok(f.run());
  const target = join(f.data, `Adobe/UXP/Plugins/External/${id}_1.4.5`);
  writeFileSync(join(target, 'panel.js'), 'previous payload');
  const before = readFileSync(f.info, 'utf8');
  ok(spawnSync('attrib.exe', ['+R', f.info], { encoding: 'utf8' }));
  try {
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(f.info, 'utf8'), before);
    assert.equal(readFileSync(join(target, 'panel.js'), 'utf8'), 'previous payload');
  } finally {
    ok(spawnSync('attrib.exe', ['-R', f.info], { encoding: 'utf8' }));
  }
});

test('first install without existing metadata works', () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'sliceman-standalone-test-'));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(f.pkg, 'install.ps1'), '-SandboxRoot', root], { encoding: 'utf8' });
  ok(r);
  assert.equal(json(join(root, 'data/Adobe/UXP/PluginsInfo/v1/PS.json')).plugins[0].pluginId, id);
});

test('backend uninstalls without numeric input after GUI confirmation', () => {
  const f = fixture();
  ok(f.run());
  const noInput = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(f.pkg, 'install.ps1'), '-SandboxRoot', f.root, '-Uninstall'], { encoding: 'utf8', input: '\n', timeout: 10000 });
  ok(noInput);
  assert.deepEqual(json(f.info).plugins, [f.original]);
});

test('incomplete package reports Chinese instructions', () => {
  const f = fixture();
  renameSync(join(f.pkg, 'plugin/manifest.json'), join(f.pkg, 'plugin/manifest.missing'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /安装包不完整/);
  assert.match(result.stdout, /完整解压/);
});

test('English framework errors containing Chinese text are kept out of user messages', () => {
  const f = fixture();
  // The JSON parser emits an English message containing the supplied Chinese text.
  writeFileSync(f.info, '{"中文":');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /操作失败/);
  assert.doesNotMatch(result.stdout, /Invalid JSON|Exception|Unexpected|Cannot|ConvertFrom-Json|Invalid object/);
});
