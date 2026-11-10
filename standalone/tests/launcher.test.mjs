import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('launcher state and real WinForms confirmation controls', () => {
  assert.ok(existsSync('standalone/Launcher.cs'), 'launcher implementation must exist');
  const output = resolve('standalone/release/verification');
  mkdirSync(output, { recursive: true });
  const compile = spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', [
    '/nologo', '/target:exe', '/main:LauncherTests', `/out:${output}/LauncherTests.exe`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    resolve('standalone/Launcher.cs'), resolve('standalone/tests/LauncherTests.cs'),
  ], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const result = spawnSync(`${output}/LauncherTests.exe`, [output], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
