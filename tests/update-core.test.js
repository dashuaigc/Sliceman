import { describe, it, expect, vi } from 'vitest';
import {
  parseVersion, compareVersions, isNewer, pickAsset, formatSize,
  summarizeNotes, parseRelease, downloadUrlOf, shouldAutoCheck,
  formatTime, formatDate, describeStatus, describeError,
  fetchLatestRelease, LATEST_API, LATEST_PAGE, AUTO_CHECK_INTERVAL_MS,
} from '../src/lib/update-core.js';

describe('版本号', () => {
  it('前缀 v 与位数不齐都能收', () => {
    expect(parseVersion('v1.2.0').nums).toEqual([1, 2, 0]);
    expect(parseVersion('1.2').nums).toEqual([1, 2]);
    expect(parseVersion('1.3.0-beta.2').pre).toEqual(['beta', '2']);
    expect(parseVersion('').ok).toBe(false);
    expect(parseVersion('latest').ok).toBe(false);
  });

  it('逐位比大小，位数不齐时短的补 0', () => {
    expect(compareVersions('1.3.0', '1.2.0')).toBe(1);
    expect(compareVersions('1.2.0', '1.3.0')).toBe(-1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.10.0', '1.9.0')).toBe(1);      // 不能按字符串比
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });

  it('预发布版小于同号正式版', () => {
    expect(compareVersions('1.3.0', '1.3.0-beta.1')).toBe(1);
    expect(compareVersions('1.3.0-beta.1', '1.3.0-beta.2')).toBe(-1);
    expect(compareVersions('1.3.0-beta', '1.3.0-beta.1')).toBe(-1);
    expect(compareVersions('1.3.0-rc.1', '1.3.0-beta.9')).toBe(1);
    expect(compareVersions('1.3.0+build.7', '1.3.0')).toBe(0);   // 构建元数据不参与比较
  });

  it('比不动的一律当作「不是新版」，不会天天弹更新', () => {
    expect(compareVersions('latest', '1.2.0')).toBe(0);
    expect(isNewer('', '1.2.0')).toBe(false);
    expect(isNewer(undefined, '1.2.0')).toBe(false);
    expect(isNewer('1.2.0', '1.2.0')).toBe(false);
    expect(isNewer('1.2.1', '1.2.0')).toBe(true);
  });
});

describe('附件挑选', () => {
  const ccx = { name: 'Sliceman_v1.3.0.ccx', browser_download_url: 'https://x/a.ccx', size: 207360 };
  const zip = { name: 'Sliceman_v1.3.0.zip', browser_download_url: 'https://x/a.zip', size: 207360 };

  it('优先 .ccx（双击即装），没有才退 .zip', () => {
    expect(pickAsset([zip, ccx]).name).toBe('Sliceman_v1.3.0.ccx');
    expect(pickAsset([zip]).name).toBe('Sliceman_v1.3.0.zip');
  });

  it('没有可下载的附件时返回 null，不炸', () => {
    expect(pickAsset([])).toBe(null);
    expect(pickAsset(undefined)).toBe(null);
    expect(pickAsset([{ name: 'notes.md', browser_download_url: 'https://x/n.md' }])).toBe(null);
    expect(pickAsset([{ name: 'a.ccx' }])).toBe(null);             // 缺直链
  });

  it('大小写成人看的', () => {
    expect(formatSize(207360)).toBe('203 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatSize(0)).toBe('');
  });
});

describe('更新说明降级成纯文本行', () => {
  const body = [
    '## 新增功能',
    '',
    '### 批量修改图片尺寸',
    '- **图片来源**：多选图片 / 整个文件夹',
    '- 支持 `1,2,3` 这样填',
    '1. 第一步',
    '',
    '---',
    '> 引用一句',
    '见 [发布页](https://github.com/x/y)',
    '```',
    'npm run pack',
    '```',
    '![截图](https://x/y.png)',
  ].join('\n');

  it('标题、列表、行内标记各自处理', () => {
    const out = summarizeNotes(body);
    expect(out[0]).toEqual({ kind: 'head', text: '新增功能' });
    expect(out[1]).toEqual({ kind: 'head', text: '批量修改图片尺寸' });
    expect(out[2]).toEqual({ kind: 'text', text: '· 图片来源：多选图片 / 整个文件夹' });
    expect(out[3]).toEqual({ kind: 'text', text: '· 支持 1,2,3 这样填' });
    expect(out[4]).toEqual({ kind: 'text', text: '· 第一步' });
    expect(out[5]).toEqual({ kind: 'text', text: '引用一句' });
    expect(out[6]).toEqual({ kind: 'text', text: '见 发布页' });
    // 代码块整段跳过、分隔线与图片都不留行
    expect(out.map((r) => r.text).join('\n')).not.toContain('npm run pack');
    expect(out).toHaveLength(7);
  });

  it('超长说明截断并留一条提示', () => {
    const long = Array.from({ length: 20 }, (_, i) => `- 第 ${i} 条`).join('\n');
    const out = summarizeNotes(long, 5);
    expect(out).toHaveLength(6);
    expect(out[5].text).toContain('还有 15 行');
  });

  it('空 body 不产生行', () => {
    expect(summarizeNotes('')).toEqual([]);
    expect(summarizeNotes(null)).toEqual([]);
  });
});

describe('Release 报文解析', () => {
  const json = {
    tag_name: 'v1.3.0',
    name: 'Sliceman v1.3.0',
    html_url: 'https://github.com/dashuaigc/Sliceman/releases/tag/v1.3.0',
    published_at: '2026-09-12T14:42:07Z',
    body: '## 新增功能\n- 检查更新',
    assets: [
      { name: 'Sliceman_v1.3.0.ccx', browser_download_url: 'https://x/a.ccx', size: 207360 },
    ],
  };

  it('挑出版本、直链、说明，并算出有没有更新', () => {
    const info = parseRelease(json, '1.2.0');
    expect(info.ok).toBe(true);
    expect(info.version).toBe('1.3.0');
    expect(info.tag).toBe('v1.3.0');
    expect(info.asset.url).toBe('https://x/a.ccx');
    expect(info.hasUpdate).toBe(true);
    expect(info.notes[0]).toEqual({ kind: 'head', text: '新增功能' });
  });

  it('本地已经是最新（或更新）时 hasUpdate 为 false', () => {
    expect(parseRelease(json, '1.3.0').hasUpdate).toBe(false);
    expect(parseRelease(json, '1.4.0').hasUpdate).toBe(false);
  });

  it('报文没有版本号时给出原因而不是抛异常', () => {
    expect(parseRelease({}, '1.2.0').ok).toBe(false);
    expect(parseRelease(null, '1.2.0').ok).toBe(false);
    expect(parseRelease({ tag_name: 'nightly' }, '1.2.0').reason).toContain('没有版本号');
  });

  it('缺字段时退回默认值：标题、发布页都不会是 undefined', () => {
    const info = parseRelease({ tag_name: '1.3.0' }, '1.2.0');
    expect(info.title).toBe('Sliceman 1.3.0');
    expect(info.pageUrl).toBe(LATEST_PAGE);
    expect(info.asset).toBe(null);
  });

  it('下载地址：有 .ccx 直链就直接下，没有就打开发布页', () => {
    expect(downloadUrlOf(parseRelease(json, '1.2.0'))).toBe('https://x/a.ccx');
    expect(downloadUrlOf(parseRelease({ ...json, assets: [] }, '1.2.0'))).toBe(json.html_url);
    expect(downloadUrlOf(null)).toBe(LATEST_PAGE);
  });
});

describe('自动检查的节流', () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);

  it('从没查过就查', () => {
    expect(shouldAutoCheck(0, now)).toBe(true);
    expect(shouldAutoCheck(NaN, now)).toBe(true);
    expect(shouldAutoCheck(undefined, now)).toBe(true);
  });

  it('一天之内不再查，满一天才查', () => {
    expect(shouldAutoCheck(now - 1000, now)).toBe(false);
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
  });

  it('系统时间被往回调过（上次检查在「未来」）也不会卡死', () => {
    expect(shouldAutoCheck(now + 99999, now)).toBe(true);
  });
});

describe('时间与错误的文案', () => {
  it('时间戳写成本地时间，拿不到就空串', () => {
    const t = new Date(2026, 8, 14, 9, 5).getTime();
    expect(formatTime(t)).toBe('2026-09-14 09:05');
    expect(formatTime(0)).toBe('');
    expect(formatTime('x')).toBe('');
    expect(formatDate('2026-09-12T14:42:07Z')).toMatch(/^2026-09-1[23]$/);   // 时区差一天也算过
    expect(formatDate('')).toBe('');
  });

  it('状态码与异常都翻成一句人话', () => {
    expect(describeStatus(404)).toContain('还没有发布版本');
    expect(describeStatus(403)).toContain('太频繁');
    expect(describeStatus(500)).toContain('服务器出错');
    expect(describeError(new Error('timeout'))).toContain('超时');
    expect(describeError(new Error('Failed to fetch'))).toContain('连不上 GitHub');
    // 没重装插件导致权限没生效，是升级用户最容易踩的那个坑，单独一句提示
    expect(describeError(new Error('permission denied'))).toContain('Remove → Add');
  });
});

describe('拉取接口', () => {
  const okRes = { ok: true, status: 200, json: async () => ({ tag_name: 'v1.3.0' }) };

  it('走默认地址，带上 GitHub 的 Accept 头', async () => {
    const fetchImpl = vi.fn(async () => okRes);
    const json = await fetchLatestRelease(fetchImpl);
    expect(json.tag_name).toBe('v1.3.0');
    expect(fetchImpl.mock.calls[0][0]).toBe(LATEST_API);
    expect(fetchImpl.mock.calls[0][1].headers.Accept).toContain('github');
  });

  it('HTTP 错误码抛成中文原因', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await expect(fetchLatestRelease(fetchImpl)).rejects.toThrow('太频繁');
  });

  it('超时自己醒：UXP 的 fetch 挂住时不会 reject，靠外面计时', async () => {
    const fetchImpl = () => new Promise(() => {});      // 永远不结束
    await expect(fetchLatestRelease(fetchImpl, { timeout: 20 })).rejects.toThrow('timeout');
  });

  it('环境里压根没有 fetch 时给一句话，不抛 TypeError', async () => {
    await expect(fetchLatestRelease(null)).rejects.toThrow('不支持联网');
  });
});
