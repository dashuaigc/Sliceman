import { describe, it, expect } from 'vitest';
import { hasCounter, expandCounter, buildRenameRows } from '../src/lib/rename-core.js';

describe('hasCounter —— 独立 n 的识别（用于界面提示；生效与否由开关决定）', () => {
  it('单词里的字母 n 不是变量（Button / Icon 里的 n 必须保持字面）', () => {
    expect(hasCounter('Button')).toBe(false);       // 尾部 n 前是字母 o
    expect(hasCounter('Icon')).toBe(false);
    expect(hasCounter('nn')).toBe(false);           // n 相邻 n，仍是字母组合
    expect(hasCounter('N')).toBe(false);            // 仅小写 n 是变量
    expect(hasCounter('btn2n')).toBe(false);       // 数字相邻也不算
    expect(hasCounter('')).toBe(false);
  });
  it('前后是边界/符号的 n 是变量', () => {
    expect(hasCounter('Button_n')).toBe(true);
    expect(hasCounter('n_icon')).toBe(true);
    expect(hasCounter('icon_n_btn')).toBe(true);
    expect(hasCounter('UI_Button_n_Normal')).toBe(true);
    expect(hasCounter('n')).toBe(true);
    expect(hasCounter('图n')).toBe(true);           // 中文相邻不算字母
    expect(hasCounter('图标_ｎ')).toBe(true);       // 全角 ｎ（中文输入法）也认
  });
});

describe('expandCounter —— 编号展开', () => {
  it('默认不补零', () => {
    expect(expandCounter('icon_n', 5)).toBe('icon_5');
  });
  it('固定位数补零，超宽不截断', () => {
    expect(expandCounter('icon_n', 1, 2)).toBe('icon_01');
    expect(expandCounter('icon_n', 9, 3)).toBe('icon_009');
    expect(expandCounter('icon_n', 100, 2)).toBe('icon_100');   // 2 位下 100 不截断
  });
  it('多个 n 同层取同一编号', () => {
    expect(expandCounter('n_n', 7)).toBe('7_7');
  });
  it('模板里没有独立 n 时原样返回', () => {
    expect(expandCounter('Button', 3)).toBe('Button');
  });
});

describe('buildRenameRows —— 编号开关', () => {
  it('开关关闭：n 是普通字母，原样保留', () => {
    const rows = buildRenameRows(['a', 'b'], { mode: 'new', template: 'Button_n' });   // 无 counter
    expect(rows.map((r) => r.to)).toEqual(['Button_n', 'Button_n']);
  });
  it('开关开启：起始 3 递增 2 → 3,5,7,9,11（用户示例）', () => {
    const rows = buildRenameRows(['a', 'b', 'c', 'd', 'e'],
      { mode: 'new', template: 'Item_n', counter: true, start: 3, step: 2 });
    expect(rows.map((r) => r.to)).toEqual(['Item_3', 'Item_5', 'Item_7', 'Item_9', 'Item_11']);
  });
  it('递增数字缺省为 1', () => {
    const rows = buildRenameRows(['a', 'b', 'c'],
      { mode: 'new', template: 'x_n', counter: true, start: 8 });
    expect(rows.map((r) => r.to)).toEqual(['x_8', 'x_9', 'x_10']);
  });
  it('全角 ｎ 同样展开', () => {
    const rows = buildRenameRows(['a', 'b'], { mode: 'new', template: 'btn_ｎ', counter: true, start: 1 });
    expect(rows.map((r) => r.to)).toEqual(['btn_1', 'btn_2']);
  });
});

describe('buildRenameRows —— 替换模式', () => {
  it('Button → Icon：保留原名结构', () => {
    const rows = buildRenameRows(
      ['Button_red', 'Button_blue', 'Button_green'],
      { mode: 'replace', find: 'Button', template: 'Icon' },
    );
    expect(rows.map((r) => r.to)).toEqual(['Icon_red', 'Icon_blue', 'Icon_green']);
    expect(rows.every((r) => !r.unmatched && !r.dup)).toBe(true);
  });
  it('替换为 Icon_n：连续编号 + 原名其余部分保留', () => {
    const rows = buildRenameRows(
      ['Layer_A', 'Layer_B', 'Layer_C', 'Layer_D'],
      { mode: 'replace', find: 'Layer', template: 'Icon_n', counter: true, start: 1 },
    );
    expect(rows.map((r) => r.to)).toEqual(['Icon_1_A', 'Icon_2_B', 'Icon_3_C', 'Icon_4_D']);
  });
  it('未找到查找内容：保持原名、标记 unmatched、不占用编号', () => {
    const rows = buildRenameRows(
      ['Layer_A', 'xxx', 'Layer_B'],
      { mode: 'replace', find: 'Layer', template: 'Icon_n', counter: true, start: 1 },
    );
    expect(rows[0].to).toBe('Icon_1_A');
    expect(rows[1]).toMatchObject({ from: 'xxx', to: 'xxx', unmatched: true });
    expect(rows[2].to).toBe('Icon_2_B');            // 跳过的层不消耗编号，无跳号
  });
  it('名称中多处出现：全部替换且同层同编号', () => {
    const rows = buildRenameRows(
      ['Layer_a_Layer'],
      { mode: 'replace', find: 'Layer', template: 'Icon_n', counter: true },
    );
    expect(rows[0].to).toBe('Icon_1_a_Icon_1');
  });
  it('替换为空串 = 删除匹配内容', () => {
    const rows = buildRenameRows(
      ['Button_red'],
      { mode: 'replace', find: '_red', template: '' },
    );
    expect(rows[0].to).toBe('Button');
  });
});

describe('buildRenameRows —— 重新命名模式', () => {
  it('不开编号：统一命名（同名行标 dup，仅提示不阻止）', () => {
    const rows = buildRenameRows(
      ['图层 123', 'Rectangle 56', '副本 8', 'abc'],
      { mode: 'new', template: 'Button' },
    );
    expect(rows.map((r) => r.to)).toEqual(['Button', 'Button', 'Button', 'Button']);
    expect(rows.every((r) => r.dup)).toBe(true);
  });
  it('Button_n 起始 1：连续编号', () => {
    const rows = buildRenameRows(
      ['图层 123', 'Rectangle 56', '副本 8', 'abc'],
      { mode: 'new', template: 'Button_n', counter: true, start: 1 },
    );
    expect(rows.map((r) => r.to)).toEqual(['Button_1', 'Button_2', 'Button_3', 'Button_4']);
    expect(rows.every((r) => !r.dup)).toBe(true);
  });
});

describe('buildRenameRows —— 前缀 / 后缀模式', () => {
  it('加前缀保留原名', () => {
    const rows = buildRenameRows(
      ['Button', 'Icon', 'BG'],
      { mode: 'prefix', template: 'UI_' },
    );
    expect(rows.map((r) => r.to)).toEqual(['UI_Button', 'UI_Icon', 'UI_BG']);
  });
  it('加后缀', () => {
    const rows = buildRenameRows(['Button'], { mode: 'suffix', template: '_Normal' });
    expect(rows[0].to).toBe('Button_Normal');
  });
  it('后缀 _n 起始 1：连续编号', () => {
    const rows = buildRenameRows(
      ['Button', 'Icon', 'Background'],
      { mode: 'suffix', template: '_n', counter: true, start: 1 },
    );
    expect(rows.map((r) => r.to)).toEqual(['Button_1', 'Icon_2', 'Background_3']);
  });
});

describe('buildRenameRows —— 编号高级规则', () => {
  it('自定义起始数字：icon_n 起始 5', () => {
    const rows = buildRenameRows(['a', 'b', 'c', 'd'],
      { mode: 'new', template: 'icon_n', counter: true, start: 5 });
    expect(rows.map((r) => r.to)).toEqual(['icon_5', 'icon_6', 'icon_7', 'icon_8']);
  });
  it('n 位置不限', () => {
    expect(buildRenameRows(['a', 'b', 'c', 'd'], { mode: 'new', template: 'n_icon', counter: true, start: 1 })
      .map((r) => r.to)).toEqual(['1_icon', '2_icon', '3_icon', '4_icon']);
    expect(buildRenameRows(['a', 'b', 'c', 'd'], { mode: 'new', template: 'icon_n_btn', counter: true, start: 10 })
      .map((r) => r.to)).toEqual(['icon_10_btn', 'icon_11_btn', 'icon_12_btn', 'icon_13_btn']);
    expect(buildRenameRows(['a', 'b', 'c'], { mode: 'new', template: 'UI_Button_n_Normal', counter: true, start: 20 })
      .map((r) => r.to)).toEqual(['UI_Button_20_Normal', 'UI_Button_21_Normal', 'UI_Button_22_Normal']);
  });
  it('数字位数：自动 / 2 位 / 3 位', () => {
    expect(buildRenameRows(['a', 'b', 'c'], { mode: 'new', template: 'icon_n', counter: true, start: 1 })
      .map((r) => r.to)).toEqual(['icon_1', 'icon_2', 'icon_3']);
    expect(buildRenameRows(['a', 'b', 'c'], { mode: 'new', template: 'icon_n', counter: true, start: 1, digits: 2 })
      .map((r) => r.to)).toEqual(['icon_01', 'icon_02', 'icon_03']);
    expect(buildRenameRows(['a', 'b', 'c'], { mode: 'new', template: 'icon_n', counter: true, start: 1, digits: 3 })
      .map((r) => r.to)).toEqual(['icon_001', 'icon_002', 'icon_003']);
  });
  it('start/step 非法值兜底为 1', () => {
    expect(buildRenameRows(['a', 'b'], { mode: 'new', template: 'x_n', counter: true })[1].to).toBe('x_2');
    expect(buildRenameRows(['a', 'b'], { mode: 'new', template: 'x_n', counter: true, start: NaN })[1].to).toBe('x_2');
    expect(buildRenameRows(['a', 'b'], { mode: 'new', template: 'x_n', counter: true, step: NaN })[1].to).toBe('x_2');
  });
});
