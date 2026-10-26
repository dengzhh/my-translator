/* 语言表：content script / options / popup 共用 */
(function (global) {
  const LANGS = [
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁体中文'],
    ['en', '英语'],
    ['ja', '日语'],
    ['ko', '韩语'],
    ['fr', '法语'],
    ['de', '德语'],
    ['es', '西班牙语'],
    ['ru', '俄语'],
    ['pt', '葡萄牙语'],
    ['it', '意大利语'],
    ['ar', '阿拉伯语'],
    ['th', '泰语'],
    ['vi', '越南语'],
    ['id', '印尼语'],
    ['hi', '印地语'],
    ['tr', '土耳其语']
  ];

  const LANG_MAP = Object.fromEntries(LANGS);

  function langName(code) {
    if (!code || code === 'auto') return '自动检测';
    return LANG_MAP[code] || code;
  }

  /* DeepL 的语言代码与通用代码不同 */
  function toDeepLCode(code) {
    const map = {
      'zh-CN': 'ZH-HANS',
      'zh-TW': 'ZH-HANT',
      'en': 'EN-US',
      'ja': 'JA',
      'ko': 'KO',
      'fr': 'FR',
      'de': 'DE',
      'es': 'ES',
      'ru': 'RU',
      'pt': 'PT-BR',
      'it': 'IT',
      'ar': 'AR',
      'th': 'TH',
      'vi': 'VI',
      'id': 'ID',
      'hi': 'HI',
      'tr': 'TR'
    };
    return map[code] || String(code || '').toUpperCase();
  }

  global.QT_LANGS = LANGS;
  global.QT_LANG_MAP = LANG_MAP;
  global.QT_langName = langName;
  global.QT_toDeepLCode = toDeepLCode;
})(typeof window !== 'undefined' ? window : self);
