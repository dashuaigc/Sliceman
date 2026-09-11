// PS API 封装：把当前文档按指定格式存成一个文件。
//
// 切图与批量改尺寸共用这一个保存出口 —— 各家格式的坑都收在这里：
//   · DOM 的 saveAs 不支持 WebP，只能走 batchPlay 的 save + sessionToken；
//     而且必须【先建好精确文件名的空文件再传 token】，否则 PS 会自己追加 " copy"；
//   · JPG 的真实粒度只有 0–12 档，面板上按 1–100 填是给人看的，落到 API 前要换算；
//   · asCopy=true：保存副本，不把当前文档的"已保存路径"改掉（批量处理时很关键，
//     否则后面关文档时 PS 可能认为有未保存改动）。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；描述符本身已在切图功能里真机验证过。

const { action } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

// 面板上的格式名 → 实际扩展名（不含点）
const EXT_OF = {
  png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp',
  psd: 'psd', psb: 'psb', tif: 'tif', tiff: 'tif', gif: 'gif', bmp: 'bmp',
};

/** 扩展名（不含点）；未知格式按 png */
export function extOf(format) {
  return EXT_OF[String(format || '').toLowerCase()] || 'png';
}

/** 面板的 1–100 → PS 的 1–12 档 */
export function jpgQuality12(pct) {
  const n = Math.round(((Number(pct) || 0) / 100) * 12);
  return Math.min(12, Math.max(1, n));
}

/**
 * 保存文档到 folder/fileName.ext。
 * @param {object} doc 当前要保存的文档
 * @param {object} folder UXP folder entry
 * @param {string} fileName 不含扩展名的最终文件名
 * @param {object} opts
 *   format       png|jpg|webp|psd|tif|gif|bmp（缺省 png）
 *   jpgQuality   1–100（面板口径），默认 100
 *   webpLossless 默认 true（无损，保留透明）
 *   webpQuality  有损时的质量 1–100，默认 90
 *   overwrite    同名文件是否直接覆盖，默认 true（调用方已经处理过同名策略）
 * @returns {Promise<{name:string, ext:string}>}
 */
export async function saveDocAs(doc, folder, fileName, opts = {}) {
  const ext = extOf(opts.format);
  const file = await folder.createFile(`${fileName}.${ext}`, { overwrite: opts.overwrite !== false });

  if (ext === 'jpg') {
    // JPG 无透明通道，PS 会以白底合并（选 JPG 视为可接受）
    const q = jpgQuality12(opts.jpgQuality == null ? 100 : opts.jpgQuality);
    await doc.saveAs.jpg(file, { quality: q }, true);
  } else if (ext === 'webp') {
    const lossless = opts.webpLossless !== false;
    const token = await uxpFs.createSessionToken(file);
    await action.batchPlay([{
      _obj: 'save',
      as: {
        _obj: 'WebPFormat',
        compression: {
          _enum: 'WebPCompression',
          _value: lossless ? 'compressionLossless' : 'compressionLossy',
        },
        ...(lossless ? {} : { quality: Math.min(100, Math.max(1, Math.round(opts.webpQuality || 90))) }),
        includeXMPData: false, includeEXIFData: false, includePsExtras: false,
      },
      in: { _path: token, _kind: 'local' },
      documentID: doc.id,
      copy: true,
      lowerCase: true,
      saveStage: { _enum: 'saveStageType', _value: 'saveBegin' },
      _options: { dialogOptions: 'dontDisplay' },
    }], {});
  } else if (ext === 'psd' || ext === 'psb' || ext === 'tif' || ext === 'gif' || ext === 'bmp') {
    const fn = doc.saveAs[ext];
    // 老版本 PS 的 DOM 可能没有某个格式的入口：给一句人看得懂的话，别抛 undefined is not a function
    if (typeof fn !== 'function') throw new Error(`当前 Photoshop 版本不支持从插件保存 ${ext.toUpperCase()}`);
    await fn.call(doc.saveAs, file, {}, true);
  } else {
    await doc.saveAs.png(file, {}, true);   // asCopy=true
  }
  return { name: `${fileName}.${ext}`, ext };
}
