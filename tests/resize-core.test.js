import { describe, it, expect } from 'vitest';
import {
  planResize, normalizeResizeCfg, fieldsOfMode, anchorEnums,
  buildOutName, formatScale, sanitizeFileName, ellipsizeName,
  splitName, isSupportedImage, shouldCollect, parseScaleList, buildRevealJsx,
  dirOfPath, fileUrlsOf, sizeCfg, sizeLabel, normalizeSizeList,
  MODES, FITS, SMALL, MAX_PX,
} from '../src/lib/resize-core.js';

/** 只写关心的字段，其余取默认（默认 = 固定宽高 + 等比适应 + 不放大） */
const plan = (w, h, cfg) => planResize({ width: w, height: h }, cfg);
/** 断言用的简写：[图像宽, 图像高, 画布宽, 画布高] */
const wh = (p) => [p.image.width, p.image.height, p.canvas.width, p.canvas.height];

describe('八种调整模式', () => {
  it('固定宽高 + 等比适应：图缩进框内，画布是框（补边）', () => {
    const p = plan(1920, 1080, { mode: 'wh', width: 1000, height: 1000, fit: 'contain' });
    expect(wh(p)).toEqual([1000, 563, 1000, 1000]);
    expect(p.op).toBe('pad');
  });

  it('固定宽高 + 等比填充：图覆盖满框，画布是框（裁切）', () => {
    const p = plan(1920, 1080, { mode: 'wh', width: 1000, height: 1000, fit: 'cover' });
    expect(wh(p)).toEqual([1778, 1000, 1000, 1000]);
    expect(p.op).toBe('crop');
  });

  it('固定宽高 + 拉伸：直接变成目标框，不保比例', () => {
    const p = plan(1920, 1080, { mode: 'wh', width: 1000, height: 1000, fit: 'stretch' });
    expect(wh(p)).toEqual([1000, 1000, 1000, 1000]);
    expect(p.op).toBe('none');
  });

  it('固定宽高 + 仅缩放：图缩进框内，画布跟着图（不补边）', () => {
    const p = plan(1920, 1080, { mode: 'wh', width: 1000, height: 1000, fit: 'scale' });
    expect(wh(p)).toEqual([1000, 563, 1000, 563]);
    expect(p.op).toBe('none');
  });

  it('固定宽度 / 固定高度：另一边按比例算，画布跟着图', () => {
    expect(wh(plan(1920, 1080, { mode: 'w', width: 1000 }))).toEqual([1000, 563, 1000, 563]);
    expect(wh(plan(1920, 1080, { mode: 'h', height: 540 }))).toEqual([960, 540, 960, 540]);
  });

  it('最长边：自动认横竖，横图缩宽、竖图缩高', () => {
    expect(wh(plan(4000, 3000, { mode: 'long', edge: 2048 }))).toEqual([2048, 1536, 2048, 1536]);
    expect(wh(plan(3000, 4000, { mode: 'long', edge: 2048 }))).toEqual([1536, 2048, 1536, 2048]);
  });

  it('最短边：短的那一边达到目标值', () => {
    expect(wh(plan(4000, 3000, { mode: 'short', edge: 1080 }))).toEqual([1440, 1080, 1440, 1080]);
    expect(wh(plan(3000, 4000, { mode: 'short', edge: 1080 }))).toEqual([1080, 1440, 1080, 1440]);
  });

  it('百分比 / 倍数：直接按因子缩放', () => {
    expect(wh(plan(1920, 1080, { mode: 'percent', percent: 50 }))).toEqual([960, 540, 960, 540]);
    expect(wh(plan(512, 512, { mode: 'times', times: 2 }))).toEqual([1024, 1024, 1024, 1024]);
    expect(wh(plan(512, 512, { mode: 'times', times: 0.5 }))).toEqual([256, 256, 256, 256]);
  });

  it('最大尺寸限制：没超限原样保留，超了才等比缩进框内', () => {
    const inside = plan(1200, 800, { mode: 'max', maxW: 2048, maxH: 2048 });
    expect(wh(inside)).toEqual([1200, 800, 1200, 800]);
    expect(inside.changed).toBe(false);
    expect(wh(plan(4000, 3000, { mode: 'max', maxW: 2048, maxH: 2048 })))
      .toEqual([2048, 1536, 2048, 1536]);
    // 只超一边也要整体缩下来
    expect(wh(plan(4000, 1000, { mode: 'max', maxW: 2048, maxH: 2048 })))
      .toEqual([2048, 512, 2048, 512]);
  });
});

describe('等比缩放的取整口径', () => {
  it('先定统一因子再一起取整（1920×1080 长边 1000 → 563，不是 562）', () => {
    // 两边各自 round 会得到 562（1080 * (1000/1920) = 562.5 → 563 才是同一因子下的结果）
    const p = plan(1920, 1080, { mode: 'long', edge: 1000 });
    expect(wh(p)).toEqual([1000, 563, 1000, 563]);
  });

  it('极端比例也不会算出 0 边（最小夹到 1px）', () => {
    const p = plan(4000, 3, { mode: 'long', edge: 100 });
    expect(p.image.height).toBe(1);
    expect(p.image.width).toBe(100);
  });

  it('结果夹在单边上限内', () => {
    const p = plan(20000, 20000, { mode: 'percent', percent: 1000 });
    expect(p.image.width).toBe(MAX_PX);
  });
});

describe('小图处理（需要放大时）', () => {
  const CFG = { mode: 'wh', width: 1024, height: 1024, fit: 'contain' };

  it('不放大（默认）：512×512 配 1024×1024 等比适应 → 输出 512×512', () => {
    const p = plan(512, 512, { ...CFG, small: 'keep' });
    expect(wh(p)).toEqual([512, 512, 512, 512]);
    expect(p.changed).toBe(false);
    expect(p.skip).toBe(false);          // 不是跳过，只是没变化（仍可用于格式转换）
  });

  it('不放大：非正方形的图，画布按目标比例一起缩（800×400 → 图 800×400 / 画布 800×800）', () => {
    const p = plan(800, 400, { ...CFG, small: 'keep' });
    expect(wh(p)).toEqual([800, 400, 800, 800]);
    expect(p.op).toBe('pad');
  });

  it('不放大 + 小图仍补边到目标画布：画布撑满 1024×1024，图不放大', () => {
    const p = plan(512, 512, { ...CFG, small: 'keep', padSmall: true });
    expect(wh(p)).toEqual([512, 512, 1024, 1024]);
    expect(p.op).toBe('pad');
  });

  it('放大到目标：照算', () => {
    expect(wh(plan(512, 512, { ...CFG, small: 'up' }))).toEqual([1024, 1024, 1024, 1024]);
  });

  it('跳过：小图直接不输出', () => {
    const p = plan(512, 512, { ...CFG, small: 'skip' });
    expect(p.skip).toBe('small');
  });

  it('缩小的图不受小图策略影响（三种策略结果一致）', () => {
    for (const small of SMALL) {
      expect(wh(plan(2048, 2048, { ...CFG, small }))).toEqual([1024, 1024, 1024, 1024]);
    }
  });

  it('百分比 / 倍数不受小图策略拦截 —— 用户填 200% 就是要放大', () => {
    expect(wh(plan(512, 512, { mode: 'percent', percent: 200, small: 'keep' })))
      .toEqual([1024, 1024, 1024, 1024]);
    expect(plan(512, 512, { mode: 'times', times: 3, small: 'skip' }).skip).toBe(false);
  });

  it('等比填充遇到不放大：按目标比例裁切但不放大（2000×500 配 1024²）', () => {
    // 覆盖因子 = max(0.512, 2.048) = 2.048 > 1 → 夹紧 → 图不动，框缩到 500×500
    const p = plan(2000, 500, { mode: 'wh', width: 1024, height: 1024, fit: 'cover', small: 'keep' });
    expect(wh(p)).toEqual([2000, 500, 500, 500]);
    expect(p.op).toBe('crop');
  });

  it('拉伸遇到不放大：按目标比例压，但没有一边被放大（512² 配 1024×512）', () => {
    const p = plan(512, 512, { mode: 'wh', width: 1024, height: 512, fit: 'stretch', small: 'keep' });
    expect(wh(p)).toEqual([512, 256, 512, 256]);
  });
});

describe('尺寸没变化时的处理', () => {
  it('默认仍然输出（可用于纯格式转换）', () => {
    const p = plan(1000, 1000, { mode: 'wh', width: 1000, height: 1000, fit: 'contain' });
    expect(p.changed).toBe(false);
    expect(p.skip).toBe(false);
  });

  it('开了 skipSame 才跳过', () => {
    const p = plan(1000, 1000, { mode: 'wh', width: 1000, height: 1000, fit: 'contain', skipSame: true });
    expect(p.skip).toBe('same');
  });
});

describe('参数归一与校验', () => {
  it('非法 / 缺失参数都回落到默认值，不产生 NaN', () => {
    const c = normalizeResizeCfg({ mode: '不存在', fit: 'xx', small: 'yy', width: 'abc', height: -5, percent: 0 });
    expect([c.mode, c.fit, c.small, c.anchor]).toEqual(['wh', 'contain', 'keep', 'cm']);
    expect([c.width, c.height, c.percent]).toEqual([1920, 1080, 100]);
  });

  it('原图尺寸读不出来 → skip:invalid，不返回 NaN 尺寸', () => {
    const p = planResize({ width: 0, height: 0 }, { mode: 'wh' });
    expect(p.skip).toBe('invalid');
    expect(Number.isFinite(p.image.width)).toBe(true);
  });

  it('每种模式都声明了自己要用的参数字段', () => {
    for (const m of MODES) expect(fieldsOfMode(m).length).toBeGreaterThan(0);
    expect(fieldsOfMode('wh')).toEqual(['width', 'height']);
    expect(fieldsOfMode('max')).toEqual(['maxW', 'maxH']);
  });

  it('四种适应方式都能算出结果（没有漏分支）', () => {
    for (const fit of FITS) {
      const p = plan(1600, 900, { mode: 'wh', width: 800, height: 800, fit });
      expect(p.image.width).toBeGreaterThan(0);
      expect(p.canvas.width).toBeGreaterThan(0);
    }
  });
});

describe('锚点映射到 PS 枚举', () => {
  it('九个位置各自对应一对枚举值', () => {
    expect(anchorEnums('lt')).toEqual({ horizontal: 'left', vertical: 'top' });
    expect(anchorEnums('cm')).toEqual({ horizontal: 'center', vertical: 'center' });
    expect(anchorEnums('rb')).toEqual({ horizontal: 'right', vertical: 'bottom' });
  });

  it('乱传回落到居中', () => {
    expect(anchorEnums('zz')).toEqual({ horizontal: 'center', vertical: 'center' });
  });
});

describe('命名', () => {
  it('变量替换', () => {
    expect(buildOutName('{name}_{width}x{height}', { name: 'button', width: 1024, height: 1024 }))
      .toBe('button_1024x1024');
    expect(buildOutName('{name}@{scale}', { name: 'icon', scale: '2x' })).toBe('icon@2x');
  });

  it('空模板等于保持原名；不认识的变量原样留着', () => {
    expect(buildOutName('', { name: 'a' })).toBe('a');
    expect(buildOutName('{name}_{nope}', { name: 'a' })).toBe('a_{nope}');
  });

  it('倍数写成人看的形式', () => {
    expect([formatScale(2), formatScale(0.5), formatScale(1 / 3)]).toEqual(['2x', '0.5x', '0.33x']);
  });

  it('文件名合法化：非法字符、结尾的点与空格、保留名、超长', () => {
    expect(sanitizeFileName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizeFileName('  name.  ')).toBe('name');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('')).toBe('image');
    expect(sanitizeFileName('x'.repeat(200)).length).toBe(120);
    // 中文与空格照常保留，别被合法化顺手清掉
    expect(sanitizeFileName('游戏 图标_01')).toBe('游戏 图标_01');
  });

  it('长文件名压成「头…尾」：长度守住上限，头尾都留（同前缀的名字才分得清）', () => {
    expect(ellipsizeName('short.png')).toBe('short.png');
    const long = 'Modify_gaming_table_image_edges_20260903145012.png';
    const cut = ellipsizeName(long);
    expect(cut.length).toBe(26);
    expect(cut.startsWith('Modify_gaming')).toBe(true);
    expect(cut.endsWith('145012.png')).toBe(true);       // 区分度全在尾巴上，不能掐掉
    expect(cut).toContain('…');
    expect(ellipsizeName(long, 10).length).toBe(10);
    expect(ellipsizeName(null)).toBe('');
  });
});

describe('文件收集', () => {
  it('拆主名与扩展名', () => {
    expect(splitName('icon.PNG')).toEqual({ base: 'icon', ext: 'png' });
    expect(splitName('a.b.psd')).toEqual({ base: 'a.b', ext: 'psd' });
    expect(splitName('README')).toEqual({ base: 'README', ext: '' });
  });

  it('扩展名白名单', () => {
    for (const n of ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.psd', 'a.tif', 'a.bmp']) {
      expect(isSupportedImage(n)).toBe(true);
    }
    for (const n of ['a.txt', 'a.mp4', 'a.ai', 'a', 'a.png.txt']) {
      expect(isSupportedImage(n)).toBe(false);
    }
  });

  it('不递归时只收根目录', () => {
    expect(shouldCollect('', 'a.png', { recursive: false })).toBe(true);
    expect(shouldCollect('Icon', 'a.png', { recursive: false })).toBe(false);
    expect(shouldCollect('Icon', 'a.png', { recursive: true })).toBe(true);
  });

  it('排除输出目录 —— 否则第二次运行会把上次的产物再处理一遍', () => {
    const opts = { recursive: true, excludeDirs: ['Resized'] };
    expect(shouldCollect('Resized', 'a.png', opts)).toBe(false);
    expect(shouldCollect('Icon/Resized', 'a.png', opts)).toBe(false);      // 嵌在中间也算
    expect(shouldCollect('Resized/Icon', 'a.png', opts)).toBe(false);
    expect(shouldCollect('resized', 'a.png', opts)).toBe(false);           // 不分大小写
    expect(shouldCollect('Icon', 'a.png', opts)).toBe(true);
  });

  it('隐藏文件与 macOS 残留不收', () => {
    expect(shouldCollect('', '.DS_Store', { recursive: true })).toBe(false);
    expect(shouldCollect('', '._icon.png', { recursive: true })).toBe(false);
  });
});

describe('多尺寸输出的倍率清单', () => {
  it('中英文逗号 / 分号 / 空格都当分隔符', () => {
    expect(parseScaleList('1,2,3')).toEqual([1, 2, 3]);
    expect(parseScaleList('1，2；3')).toEqual([1, 2, 3]);
    expect(parseScaleList('1 2\t3')).toEqual([1, 2, 3]);
    expect(parseScaleList('1、2,,3')).toEqual([1, 2, 3]);        // 连着的分隔符不产生空档
  });

  it('小数与带单位的写法都认，从小到大排并去重', () => {
    expect(parseScaleList('2x,0.5,1')).toEqual([0.5, 1, 2]);
    expect(parseScaleList('2,2,2.0')).toEqual([2]);
  });

  it('非数字、≤0、超过 20 倍的一律丢掉', () => {
    expect(parseScaleList('abc,-1,0,1')).toEqual([1]);
    expect(parseScaleList('20,20.5,100')).toEqual([20]);
    expect(parseScaleList('')).toEqual([]);
    expect(parseScaleList(null)).toEqual([]);
  });

  it('最多 8 档 —— 每档都要重新缩放 + 存一次盘，档数一多就是把一批拖成半小时', () => {
    expect(parseScaleList('1,2,3,4,5,6,7,8,9,10')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('多尺寸列表的一档 → cfg', () => {
  const base = normalizeResizeCfg({ mode: 'wh', fit: 'contain', width: 1000, height: 1000, small: 'up' });

  it('固定宽高档：覆盖主尺寸，仍走固定宽高那套', () => {
    const cfg = sizeCfg(base, { width: 320, height: 240 });
    expect(cfg.mode).toBe('wh');
    expect([cfg.width, cfg.height]).toEqual([320, 240]);
  });

  // 这是这次要钉住的那件事：倍率的基准是**每张原图自己的尺寸**，不是面板上填的宽高。
  // 折成绝对像素的话，横图竖图会被钉死在同一个尺寸上 —— @2x 就不成其为 @2x 了。
  it('倍率档：按原图算，同一档对不同尺寸的原图各出各的', () => {
    const cfg = sizeCfg(base, { times: 2 });
    expect(cfg.mode).toBe('times');
    expect(cfg.times).toBe(2);
    expect(planResize({ width: 100, height: 50 }, cfg).image).toEqual({ width: 200, height: 100 });
    expect(planResize({ width: 375, height: 812 }, cfg).image).toEqual({ width: 750, height: 1624 });
  });

  it('倍率档不产生固定画布 —— 等比缩放，没有补边也就谈不上锚点', () => {
    const p = planResize({ width: 100, height: 50 }, sizeCfg(base, { times: 3 }));
    expect(p.canvas).toEqual(p.image);
    expect(p.op).toBe('none');
  });

  it('0.5 倍是缩小；「小图不放大」拦不住倍率档（用户明写了要放大）', () => {
    expect(planResize({ width: 800, height: 600 }, sizeCfg(base, { times: 0.5 })).image)
      .toEqual({ width: 400, height: 300 });
    const keep = normalizeResizeCfg({ ...base, small: 'keep' });
    expect(planResize({ width: 100, height: 100 }, sizeCfg(keep, { times: 4 })).image)
      .toEqual({ width: 400, height: 400 });
  });

  it('null / 认不出的档 = 单尺寸，原样用主尺寸参数', () => {
    expect(sizeCfg(base, null)).toBe(base);
    expect(sizeCfg(base, {})).toBe(base);
  });

  it('列表里怎么写给人看', () => {
    expect(sizeLabel({ width: 1920, height: 1080 })).toBe('1920 × 1080');
    expect(sizeLabel({ times: 2 })).toBe('原图 × 2');
    expect(sizeLabel({ times: 0.5 })).toBe('原图 × 0.5');
    expect(sizeLabel(null)).toBe('');
  });
});

describe('多尺寸列表归一（也用来读上个版本存下来的列表）', () => {
  it('旧版本只有固定宽高档，形状一样，原样收下', () => {
    expect(normalizeSizeList([{ width: 1024, height: 1024 }, { width: 512, height: 512 }]))
      .toEqual([{ width: 1024, height: 1024 }, { width: 512, height: 512 }]);
  });

  it('两种档混着放，各自去重，顺序保持用户添加的顺序', () => {
    expect(normalizeSizeList([{ times: 2 }, { width: 100, height: 100 }, { times: 2 }, { width: 100, height: 100 }]))
      .toEqual([{ times: 2 }, { width: 100, height: 100 }]);
  });

  it('坏档一律丢掉：不是对象、尺寸 ≤0、倍率超过 20 倍', () => {
    expect(normalizeSizeList([null, 'x', { width: 0, height: 5 }, { times: -1 }, { times: 100 }, { times: 3 }]))
      .toEqual([{ times: 3 }]);
    expect(normalizeSizeList(null)).toEqual([]);
    expect(normalizeSizeList('[]')).toEqual([]);
  });

  it('像素夹到上限，倍率留三位小数', () => {
    expect(normalizeSizeList([{ width: 99999, height: 10 }])).toEqual([{ width: MAX_PX, height: 10 }]);
    expect(normalizeSizeList([{ times: 1.23456 }])).toEqual([{ times: 1.235 }]);
  });
});

describe('打开输出文件夹用的 ExtendScript（UXP 自己打不开文件夹，借 PS 的脚本引擎）', () => {
  it('路径按 JS 字面量嵌进去：反斜杠成对、引号被转义，拼不出坏语法', () => {
    const src = buildRevealJsx('C:\\Users\\admin\\Desktop\\00\\22');
    expect(src).toContain('var p = "C:\\\\Users\\\\admin\\\\Desktop\\\\00\\\\22";');
    // 生成的源码本身必须是合法 JS（ExtendScript 是 ES3，这里只验语法过得去）
    expect(() => new Function(`var app={},$={os:''},Folder=function(){};${src}`)).not.toThrow();
  });

  it('名字里带引号也不破字符串（PS 里真有人这么起文件夹名）', () => {
    const src = buildRevealJsx('D:\\a"b\\out');
    expect(src).toContain('var p = "D:\\\\a\\"b\\\\out";');
  });

  it('主路是 Folder.execute()，Windows 上失败再兜一层 explorer', () => {
    const src = buildRevealJsx('D:\\img\\Resized');
    expect(src).toContain('new Folder(p).execute()');
    expect(src).toContain('explorer');
    expect(src).toContain('$.os');
  });

  it('空值给空串（调用方据此直接报「没有可打开的路径」，不写临时脚本）', () => {
    expect(buildRevealJsx('')).toBe('');
    expect(buildRevealJsx(null)).toBe('');
  });
});

describe('反查原文件所在目录（getEntryWithUrl 的 file: 写法）', () => {
  it('父目录：两种分隔符都认', () => {
    expect(dirOfPath('D:\\img\\a.jpg')).toBe('D:\\img');
    expect(dirOfPath('/Users/me/pics/a.jpg')).toBe('/Users/me/pics');
    expect(dirOfPath('D:\\img\\sub\\')).toBe('D:\\img');   // 结尾的分隔符先剥掉
  });

  it('再往上没有了就给空串（调用方据此报「拿不到本机路径」，别去拼一个 file:/ 出来）', () => {
    expect(dirOfPath('a.jpg')).toBe('');
    expect(dirOfPath('/a.jpg')).toBe('');
    expect(dirOfPath('')).toBe('');
    expect(dirOfPath(null)).toBe('');
  });

  it('几种写法都要给出来 —— 这个接口挑写法，只试一种就是真机上那个「定位不到」', () => {
    const urls = fileUrlsOf('D:\\img');
    expect(urls).toContain('file:/D:/img');      // 官方示例的单斜杠
    expect(urls).toContain('file:D:/img');       // 一个斜杠都不加
    expect(urls).toContain('file:/D:\\img');     // 分隔符原样（Windows 上有报告说这个才行）
    expect(urls).toContain('file:///D:/img');
  });

  it('双斜杠的 file://D:/img 不许出现：// 后那段会被当成主机名，这是最常见的错法', () => {
    for (const u of fileUrlsOf('D:\\img')) expect(u.startsWith('file://D')).toBe(false);
  });

  it('带空格 / 中文时补一份 encodeURI 的，但不编码「分隔符原样」那一种（%5C 会把它废掉）', () => {
    const urls = fileUrlsOf('D:\\我的 图片');
    expect(urls).toContain('file:/D:/%E6%88%91%E7%9A%84%20%E5%9B%BE%E7%89%87');
    expect(urls).toContain('file:/D:/我的 图片');       // 原样那份也留着，两手都试
    for (const u of urls) expect(u).not.toContain('%5C');
  });

  it('mac 那种以 / 开头的路径不拼成双斜杠', () => {
    const urls = fileUrlsOf('/Users/me/pics');
    expect(urls).toContain('file:/Users/me/pics');
    expect(urls).toContain('file:Users/me/pics');
  });

  it('候选不重复（正反斜杠都没有时几种写法会撞在一起）', () => {
    const urls = fileUrlsOf('D:/img');
    expect(urls.length).toBe(new Set(urls).size);
  });

  it('空路径给空清单（一个都不去试）', () => {
    expect(fileUrlsOf('')).toEqual([]);
    expect(fileUrlsOf(null)).toEqual([]);
  });
});
