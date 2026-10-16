// Run with Playwright browser_run_code_unsafe filename, after npm run build and
// python -m http.server 8765 --bind 127.0.0.1 from the repository root.
// Browser-only host fixtures; never included in plugin builds. No Photoshop IO.
async (page) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('update.autoCheck', '0');
    const layers = ['Button_Play', 'Button_Settings', 'Button_Close'].map((name, i) => ({
      id: i + 1, name, kind: 'pixel', visible: true, locked: false,
      bounds: { left: i * 160, top: 80, right: i * 160 + 120, bottom: 200 },
    }));
    const doc = { id: 1, name: 'Game_UI.psd', width: 1920, height: 1080, resolution: 72,
      layers, activeLayers: layers, guides: [] };
    const ps = {
      app: { activeDocument: doc, documents: [doc] },
      action: { addNotificationListener: async () => {}, batchPlay: async ds => ds.map(d => ({
        itemIndex: { _value: 10 - (d._target?.find(t => t._ref === 'layer')?._id || 0) },
      })) },
      core: { executeAsModal: async fn => fn() },
    };
    const files = ['Home.png', 'Shop.png', 'Settings.png'].map(name => ({ name, isFile: true, nativePath: 'D:/Examples/' + name }));
    const uxp = { storage: { localFileSystem: {
      getFileForOpening: async () => files,
      getFolder: async () => ({ name: 'Output', nativePath: 'D:/Examples/Output', isFolder: true }),
    } }, shell: { openExternal: async () => {}, openPath: async () => '' } };
    window.require = name => {
      if (name === 'photoshop') return ps;
      if (name === 'uxp') return uxp;
      throw Error('Unexpected host module: ' + name);
    };
  });
  await page.route('https://api.github.com/**', route => route.abort());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8765/dist/plugin/index.html');
  await page.waitForFunction(() => document.getElementById('version').textContent === 'v1.4.5');
  const shot = async name => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: 'D:/Sliceman/docs/screenshots/' + name + '.png', animations: 'disabled' });
  };
  const go = name => page.locator('.tile[data-page="' + name + '"]').click();
  await shot('01-rename');
  await page.locator('#renameModePills [data-mode="new"]').click();
  await page.locator('#counterSwitch').click();
  await page.locator('#templateTextHint').click();
  await page.locator('#templateText').fill('Icon_n');
  await page.locator('#digitsPills [data-digits="2"]').click();
  await shot('02-rename-counter');
  await page.locator('#slOpenBtn').click();
  await page.locator('#slFindText').fill('Button');
  await page.locator('#slSearchBtn').click();
  await page.waitForFunction(() => document.getElementById('slList').textContent.includes('Play'));
  await shot('03-search');
  await page.locator('#slAddBtn').click();
  await shot('04-search-list');
  await page.locator('#slCloseBtn').click();
  for (const [name, file] of [['split','05-split'], ['batch','06-batch'], ['move','07-move'], ['layout','08-layout'], ['table','09-table'], ['guide','10-guide'], ['slice','15-slice'], ['grid','16-grid']]) {
    await go(name);
    await shot(file);
  }
  await go('resize');
  await page.locator('#rzPickBtn').click();
  await shot('11-resize-source');
  await page.locator('#rzNextBtn').click();
  await shot('12-resize-size');
  await page.locator('#rzNextBtn').click();
  await shot('13-resize-output');
  // Completed view fixture: never invoke real export operations for screenshots.
  await page.evaluate(() => {
    document.getElementById('rzRunTitle').textContent = '处理完成';
    document.getElementById('rzSummary').textContent = document.getElementById('rzSummary').textContent.replace('3/0', '3/3');
    document.getElementById('rzBarFill').style.width = '100%';
    document.getElementById('rzOkN').textContent = '3';
    document.getElementById('rzLog').innerHTML = ['Home.png', 'Shop.png', 'Settings.png'].map(n => '<div class="rz-log-row"><span class="rz-log-n">' + n + '</span><span class="rz-log-s rz-ok">1 个文件</span></div>').join('');
    document.getElementById('rzDoneRow').style.display = '';
    document.querySelector('#rzRunBtn .btn-label').textContent = '返回';
  });
  await shot('14-resize-done');
  await page.locator('#settingsBtn').click();
  await shot('17-settings');
  return { screenshots: 17, errors };
}
