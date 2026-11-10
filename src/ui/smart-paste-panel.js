// Batch-page UI. The Photoshop service owns the selection and document lifecycle.
import { pasteIntoSmartObjects } from '../ps/smart-paste.js';
import { bindCustomButton, setButtonDisabled } from '../lib/custom-button.js';

const STORAGE_KEY = 'smartPaste.settings';
const OPTIONS = [
  ['position', [['spPositionTop', 'top'], ['spPositionBottom', 'bottom']]],
  ['placement', [['spPlacementOriginal', 'original'], ['spPlacementCenter', 'center']]],
];

export function initSmartPastePanel({ setStatus = () => {}, setBusy = () => {}, bindButtons = true } = {}) {
  const el = id => document.getElementById(id);
  const cfg = { position: 'top', placement: 'original' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const [key, choices] of OPTIONS) {
      if (choices.some(([, value]) => value === saved[key])) cfg[key] = saved[key];
    }
  } catch { /* Storage is optional. */ }

  let busy = false, externalBusy = false, stopRequested = false, detailsOpen = false, hasDetails = false;
  const locked = () => busy || externalBusy;
  const optionIds = OPTIONS.flatMap(([, choices]) => choices.map(([id]) => id));
  const buttonIds = [...optionIds, 'spApply', 'spDetails'];
  if (bindButtons) buttonIds.forEach(id => bindCustomButton(el(id)));

  function render() {
    for (const [key, choices] of OPTIONS) for (const [id, value] of choices) {
      el(id).classList.toggle('active', cfg[key] === value);
      el(id).setAttribute('aria-pressed', String(cfg[key] === value));
    }
    for (const id of [...optionIds, 'spDetails']) setButtonDisabled(el(id), locked());
    // The shared busy lock must not disable our own stop action during a run.
    setButtonDisabled(el('spApply'), busy ? stopRequested : externalBusy);
    el('spApply').textContent = busy ? '停止' : '粘贴到智能对象内部';
    el('spApply').classList.toggle('sp-stopping', busy);
    el('spDetails').style.display = hasDetails ? '' : 'none';
    el('spDetails').textContent = detailsOpen ? '收起详情' : '查看详情';
    el('spDetails').setAttribute('aria-expanded', String(detailsOpen));
    el('spResults').style.display = hasDetails && detailsOpen ? '' : 'none';
  }

  for (const [key, choices] of OPTIONS) for (const [id, value] of choices) {
    el(id).addEventListener('click', () => {
      if (locked()) return;
      cfg[key] = value;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* Still usable without storage. */ }
      render();
    });
  }

  el('spApply').addEventListener('click', async () => {
    if (busy) {
      if (stopRequested) return;
      stopRequested = true;
      setStatus('正在完成当前对象，随后停止…');
      render();
      return;
    }
    if (externalBusy) return;
    busy = true; stopRequested = false; detailsOpen = false; hasDetails = false;
    el('spResults').textContent = '';
    setStatus('正在粘贴…');
    setBusy(true); render();
    try {
      const result = await pasteIntoSmartObjects({ ...cfg }, {
        shouldStop: () => stopRequested,
        onProgress: (done, total, name) => {
          setStatus(stopRequested ? '正在完成当前对象，随后停止…'
            : `处理中 ${done} / ${total}${name ? ' · ' + name : ''}`);
        },
      });
      const summary = `${result.stopped ? '已停止，' : ''}成功 ${result.applied} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个`
        + (result.shared ? `；${result.shared} 个共享实例仅添加一次` : '');
      const details = (result.results || []).filter(r => r.status !== 'applied' || r.warning);
      hasDetails = details.length > 0;
      const labels = { skipped: '跳过', failed: '失败', applied: '提示' };
      el('spResults').textContent = details.slice(0, 50)
        .map(r => `${labels[r.status] || '提示'} · ${r.name}：${r.message || ''}`).join('\n')
        + (details.length > 50 ? `\n另有 ${details.length - 50} 条详情。` : '');
      setStatus(summary);
    } catch (error) {
      const message = '粘贴失败：' + String(error?.message || error);
      setStatus(message);
    } finally {
      busy = false;
      setBusy(false); render();
    }
  });
  el('spDetails').addEventListener('click', () => {
    if (locked() || !hasDetails) return;
    detailsOpen = !detailsOpen; render();
  });
  render();
  return { setExternalBusy(on) { externalBusy = !!on; render(); } };
}
