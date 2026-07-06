// Task 4 skeleton: verify the panel loads and scripts run before wiring real logic.
const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

document.getElementById('sliceBtn').addEventListener('click', () => setStatus('切图按钮 OK（待接功能）'));
document.getElementById('renameBtn').addEventListener('click', () => setStatus('重命名按钮 OK（待接功能）'));

setStatus('插件已加载');
