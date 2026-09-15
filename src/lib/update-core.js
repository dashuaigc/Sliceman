// 检查更新的纯逻辑：版本号比较、GitHub Release 报文解析、更新说明转成可直接渲染的行。
// 这里不碰 DOM，也不碰 photoshop/uxp —— 网络请求由调用方把 fetch 传进来
//（见 fetchLatestRelease 的第一个参数），Node 里就能用假 fetch 把「超时 / 限流 /
// 报文缺字段 / 没有 .ccx 附件」这些分支全测一遍，不用开 PS。
//
// 更新源用 GitHub 的 releases/latest 接口：它只返回【最新的正式发布】，草稿与
// pre-release 会被它自己过滤掉，插件这边不用再判断一次。

export const REPO_OWNER = 'dashuaigc';
export const REPO_NAME = 'Sliceman';

/** 最新正式版的 JSON 接口（要在 manifest 的 requiredPermissions.network.domains 里放行） */
export const LATEST_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
/** 最新正式版的网页（拿不到 .ccx 直链时退回这个，让浏览器去打开发布页） */
export const LATEST_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

/** 一次检查最多等多久（UXP 里 fetch 卡住不会自己醒，必须外面计时） */
export const CHECK_TIMEOUT_MS = 12000;
/** 「启动时自动检查」的最小间隔：一天一次，开十次面板不会打十次接口 */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 拆版本号：'v1.2.0' / '1.2' / '1.3.0-beta.2' 都收。
 * @returns {{ok:boolean, nums:number[], pre:string[]}} ok=false 表示这串根本不是版本号
 */
export function parseVersion(input) {
  // '+build.7' 这类构建元数据按 semver 不参与比较，进门就砍掉
  const s = String(input ?? '').trim().replace(/^[vV]/, '').split('+')[0];
  const m = /^(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(s);
  if (!m) return { ok: false, nums: [], pre: [] };
  const nums = m[1].split('.').map((n) => Number(n));
  // '1.3.0-beta.2' 的 'beta.2' 拆成 ['beta','2']，逐段比
  const pre = m[2] ? String(m[2]).split('.').filter(Boolean) : [];
  return { ok: true, nums, pre };
}

/** 数字段逐位比（位数不齐时短的那边补 0：1.2 == 1.2.0） */
function compareNums(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 预发布标识逐段比：数字段按数值比，其余按字典序；数字段小于非数字段（semver 规则） */
function comparePre(a, b) {
  // 【没有】预发布标识的那个更新：1.3.0 > 1.3.0-beta.1
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;                     // 段数少的在前：beta < beta.1
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个版本号。
 * @returns {number} a>b 为 1，a<b 为 -1，相等为 0；任一边不是版本号时返回 0（当作「没法比」）
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va.ok || !vb.ok) return 0;
  const byNum = compareNums(va.nums, vb.nums);
  if (byNum !== 0) return byNum;
  return comparePre(va.pre, vb.pre);
}

/** 远端版本是否比本地新（比不动时一律当作「不是新版」，免得天天弹更新） */
export function isNewer(remote, local) {
  return compareVersions(remote, local) > 0;
}

/**
 * 从 Release 的附件里挑一个能下载的包：优先 .ccx（双击就能装），退而求其次 .zip。
 * @returns {{name:string, url:string, size:number}|null}
 */
export function pickAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const usable = list.filter((a) => a && a.browser_download_url && a.name);
  const hit = usable.find((a) => /\.ccx$/i.test(a.name)) || usable.find((a) => /\.zip$/i.test(a.name));
  if (!hit) return null;
  return {
    name: String(hit.name),
    url: String(hit.browser_download_url),
    size: Number(hit.size) || 0,
  };
}

/** 字节数写成人看的大小（附件大概几百 KB，到 MB 就够用了） */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Release 说明是 Markdown，面板里没有 Markdown 渲染器，这里降级成两种行：
 *   { kind:'head', text } —— 原来的 ## 标题
 *   { kind:'text', text } —— 正文/列表项（列表项前面补一个「·」）
 * 同时把粗体、行内代码、链接这些标记去掉，只留文字。
 * @param {string} body Release 的 body
 * @param {number} maxLines 最多保留多少行（弹窗高度有限，超出的截掉并在末尾留一条省略提示）
 */
export function summarizeNotes(body, maxLines = 60) {
  const raw = String(body ?? '').replace(/\r\n/g, '\n');
  const out = [];
  let inCode = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (/^```/.test(t)) { inCode = !inCode; continue; }   // 代码块整段跳过
    if (inCode) continue;
    if (!t) continue;
    if (/^([-*_])\1{2,}$/.test(t)) continue;              // 分隔线
    if (/^<!--/.test(t)) continue;                        // HTML 注释
    const head = /^#{1,6}\s+(.*)$/.exec(t);
    if (head) {
      out.push({ kind: 'head', text: cleanInline(head[1]) });
      continue;
    }
    const bullet = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(t);
    const text = cleanInline(bullet ? bullet[1] : t.replace(/^>\s*/, ''));
    if (text) out.push({ kind: 'text', text: bullet ? `· ${text}` : text });
  }
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept.push({ kind: 'text', text: `…… 还有 ${out.length - maxLines} 行，完整说明见发布页` });
    return kept;
  }
  return out;
}

/** 去掉行内的 Markdown 标记，只留文字 */
function cleanInline(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // 图片整个去掉
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // 链接只留文字
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')         // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1')             // 粗体
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')       // 斜体（别把 ** 拆一半）
    .replace(/~~([^~]+)~~/g, '$1')                 // 删除线
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把 Release 报文整理成面板要用的形状。
 * @param {object} json releases/latest 的返回
 * @param {string} current 本地版本（manifest.version）
 * @returns {{ok:boolean, reason?:string, version:string, tag:string, title:string,
 *            publishedAt:string, pageUrl:string, asset:object|null,
 *            notes:Array, hasUpdate:boolean}}
 */
export function parseRelease(json, current) {
  const j = json && typeof json === 'object' ? json : {};
  const tag = String(j.tag_name ?? '').trim();
  const version = tag.replace(/^[vV]/, '');
  if (!parseVersion(version).ok) {
    return { ok: false, reason: 'GitHub 返回的内容里没有版本号', hasUpdate: false, notes: [] };
  }
  const asset = pickAsset(j.assets);
  return {
    ok: true,
    version,
    tag,
    title: String(j.name ?? '').trim() || `${REPO_NAME} ${tag}`,
    publishedAt: String(j.published_at ?? j.created_at ?? ''),
    pageUrl: String(j.html_url ?? '').trim() || LATEST_PAGE,
    asset,
    notes: summarizeNotes(j.body),
    hasUpdate: isNewer(version, current),
  };
}

/** 点「下载新版本」时该打开哪个网址：有 .ccx 直链就直接下，没有就打开发布页 */
export function downloadUrlOf(info) {
  if (info && info.asset && info.asset.url) return info.asset.url;
  if (info && info.pageUrl) return info.pageUrl;
  return LATEST_PAGE;
}

/** 到点了没：上次检查过去满一天才允许自动再查一次 */
export function shouldAutoCheck(lastCheckedMs, now = Date.now(), interval = AUTO_CHECK_INTERVAL_MS) {
  const last = Number(lastCheckedMs);
  if (!Number.isFinite(last) || last <= 0) return true;      // 从没查过
  if (last > now) return true;                               // 系统时间被改过，别卡死
  return now - last >= interval;
}

/** 时间戳写成 'YYYY-MM-DD HH:mm'（本地时区），拿不到就返回空串 */
export function formatTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 发布日期只显示到天 */
export function formatDate(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (Number.isNaN(t)) return '';
  return formatTime(t).slice(0, 10);
}

/** HTTP 状态码翻成一句用户看得懂的话 */
export function describeStatus(status) {
  const s = Number(status);
  if (s === 404) return '仓库还没有发布版本（404）';
  if (s === 403 || s === 429) return 'GitHub 接口访问太频繁，过一会儿再试（403）';
  if (s >= 500) return `GitHub 服务器出错（${s}），稍后再试`;
  return `GitHub 返回了 ${s}`;
}

/** 异常翻成一句话：网络不通、被权限拦下、超时，分别给不同的提示 */
export function describeError(err) {
  const msg = String((err && (err.message || err)) ?? '').trim();
  if (/timeout|超时/i.test(msg)) return '检查更新超时，请确认网络能访问 github.com';
  if (/permission|not allowed|denied|CORS|origin/i.test(msg)) {
    return '插件没有访问网络的权限：更新插件后需要在 UDT 里 Remove → Add 重装一次';
  }
  if (/network|failed to fetch|ENOTFOUND|getaddrinfo|ECONN/i.test(msg)) {
    return '连不上 GitHub，请检查网络后重试';
  }
  return msg ? `检查更新失败：${msg}` : '检查更新失败';
}

/**
 * 拉一次 releases/latest。
 *
 * ⚠️ fetch 由外面传进来（UXP 里是全局的 fetch），并且**必须自己计时**：
 *    UXP 的 fetch 没有可靠的 AbortController，网络不通时会一直挂着不 reject，
 *    面板就永远停在「检查中…」。这里用 Promise.race 兜一个超时。
 *
 * @param {Function} fetchImpl fetch 实现
 * @param {{url?:string, timeout?:number}} [opts]
 * @returns {Promise<object>} 解析好的 JSON；失败时抛出已经翻译成中文的 Error
 */
export async function fetchLatestRelease(fetchImpl, opts = {}) {
  const url = opts.url || LATEST_API;
  const timeout = Number(opts.timeout) || CHECK_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持联网检查更新');

  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeout);
  });
  try {
    const res = await Promise.race([
      fetchImpl(url, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } }),
      guard,
    ]);
    if (!res) throw new Error('GitHub 没有返回内容');
    if (res.ok === false || (res.status && (res.status < 200 || res.status >= 300))) {
      throw new Error(describeStatus(res.status));
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
