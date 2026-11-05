// ==UserScript==
// @name         Netflix 雙語字幕（英上中下）
// @description  Netflix 英文＋中文雙語字幕：英文在上、中文在下，純白無背景
// @version      1.5
// @match        https://www.netflix.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ===================== 可調整設定 =====================
  const CONFIG = {
    EN_SIZE: 0.03,         // 英文字號 = 畫面高度 × 0.03（想更大就調高，例如 0.034）
    ZH_SCALE: 0.85,        // 中文字號 = 英文字號 × 0.85（比英文再小一點）
    GAP_RATIO: 0.5,        // 英中間距 = 中文字號 × 0.5（半個漢字）
    BOTTOM: 0.125,         // 字幕固定距離畫面底部的高度（佔畫面高度的比例），預設在播放條上方
    WEIGHT: 600,           // 字重：400 一般、500 中等、600 半粗、700 粗
    SHADOW: true,          // 淡淡的文字陰影（同 Netflix 預設，不是背景）；不要就改成 false
    ZH_LANGS: ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-CN', 'zh'], // 繁中優先
    EN_LANGS: ['en', 'en-US', 'en-GB'],
    TOGGLE_KEY: 'b',       // 按 B 鍵開關雙語字幕
    SHOW_STATUS: false,    // 左上角顯示狀態提示（除錯時改 true）
  };
  // =====================================================

  const TAG = '[雙語字幕]';
  const WEBVTT = 'webvtt-lssdh-ios8';
  const TTML_FMTS = ['dfxp-ls-sdh', 'imsc1.1', 'simplesdh'];
  // 蘋果系統字體：英文 SF Pro，中文 蘋方-繁
  const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'PingFang TC', 'Helvetica Neue', sans-serif";

  const tracksByMovie = new Map(); // movieId -> 字幕軌清單（來自 manifest）
  let lastManifestId = null;
  const cueCache = new Map();
  let enCues = [], zhCues = [];
  let loadedId = null;
  // 備援：Netflix 自己下載字幕時順便攔下來
  let captured = { id: null, en: [], zh: [] };
  let enabled = true;
  let nativeRatio = null;

  console.log(TAG, '腳本已載入');

  // ---------- 1. 要求 Netflix 也提供 WebVTT 格式 ----------
  const origStringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    try {
      const p = value && value.params && value.params.profiles;
      if (Array.isArray(p) && !p.includes(WEBVTT)) p.push(WEBVTT);
    } catch (e) {}
    return origStringify.call(this, value, ...rest);
  };

  // ---------- 2. 攔截各種資料來源 ----------
  const origParse = JSON.parse;
  JSON.parse = function (...args) {
    const v = origParse.apply(this, args);
    try { inspect(v, 0); } catch (e) {}
    return v;
  };

  const origJson = Response.prototype.json;
  Response.prototype.json = function () {
    return origJson.call(this).then((v) => { try { inspect(v, 0); } catch (e) {} return v; });
  };

  const origText = Response.prototype.text;
  Response.prototype.text = function () {
    return origText.call(this).then((s) => { try { sniffText(s); } catch (e) {} return s; });
  };

  const origDecode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function (...args) {
    const s = origDecode.apply(this, args);
    try { if (s && s.length > 30) sniffText(s); } catch (e) {}
    return s;
  };

  const XHR = XMLHttpRequest.prototype;
  const origSend = XHR.send;
  XHR.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const rt = this.responseType;
        if (rt === '' || rt === 'text') sniffText(this.responseText);
        else if (rt === 'json') inspect(this.response, 0);
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  // 在 JSON 物件裡找 timedtexttracks（manifest）
  function inspect(v, depth) {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v.timedtexttracks)) { handleManifest(v); return; }
    if (Array.isArray(v.timedTextTracks)) { handleManifest(Object.assign({}, v, { timedtexttracks: v.timedTextTracks })); return; }
    if (Array.isArray(v)) { for (const x of v.slice(0, 20)) inspect(x, depth + 1); return; }
    for (const k of ['result', 'results', 'data', 'manifest', 'payload']) if (v[k]) inspect(v[k], depth + 1);
  }

  // 字串若是字幕檔（WebVTT / TTML）就解析存起來
  function sniffText(s) {
    if (typeof s !== 'string' || s.length < 30) return;
    const head = s.slice(0, 400);
    let cues = null, lang = '';
    if (/^﻿?WEBVTT/.test(head)) {
      cues = parseVTT(s);
    } else if (/<tt[\s>]/.test(head) && /ttml/i.test(head)) {
      cues = parseTTML(s);
      const m = head.match(/xml:lang="([^"]+)"/);
      if (m) lang = m[1].toLowerCase();
    } else if (head.includes('timedtexttracks') || head.includes('timedTextTracks')) {
      try { inspect(origParse(s), 0); } catch (e) {}
      return;
    }
    if (!cues || !cues.length) return;
    const isZh = lang ? lang.startsWith('zh') : looksChinese(cues);
    const id = currentMovieId();
    if (captured.id !== id) captured = { id, en: [], zh: [] };
    if (isZh) captured.zh = cues;
    else if (!lang || lang.startsWith('en')) captured.en = cues;
    console.log(TAG, '攔到字幕檔', isZh ? '中文' : '英文', cues.length, '句');
  }

  function looksChinese(cues) {
    const sample = cues.slice(0, 40).map((c) => c.text).join('');
    const cjk = (sample.match(/[一-鿿]/g) || []).length;
    return cjk > sample.length * 0.3;
  }

  function getUrl(d) {
    if (!d) return null;
    if (Array.isArray(d.urls) && d.urls.length) return d.urls[0].url || d.urls[0];
    if (d.downloadUrls) return Object.values(d.downloadUrls)[0];
    return null;
  }

  function pickSource(dl) {
    const v = getUrl(dl[WEBVTT]);
    if (v) return { type: 'vtt', url: v };
    for (const f of TTML_FMTS) {
      const u = getUrl(dl[f]);
      if (u) return { type: 'ttml', url: u };
    }
    return null;
  }

  function handleManifest(r) {
    const id = String(r.movieId != null ? r.movieId : (r.viewableId != null ? r.viewableId : 'unknown'));
    const list = r.timedtexttracks
      .filter((t) => t && !t.isNoneTrack && !t.isForcedNarrative && t.ttDownloadables)
      .map((t) => ({
        lang: t.language || t.bcp47 || '',
        cc: t.rawTrackType === 'closedcaptions',
        src: pickSource(t.ttDownloadables),
      }))
      .filter((t) => t.src);
    console.log(TAG, '攔到播放清單', id, list.map((t) => t.lang).join(','));
    if (!list.length) return;
    tracksByMovie.set(id, list);
    lastManifestId = id;
    if (id === currentMovieId()) loadedId = null;
  }

  function chooseTrack(list, langs) {
    const norm = (s) => s.toLowerCase();
    for (const l of langs) {
      const hit = list.filter((t) => norm(t.lang) === norm(l));
      if (hit.length) return hit.find((t) => !t.cc) || hit[0];
    }
    const base = langs[0].split('-')[0].toLowerCase();
    const hit = list.filter((t) => norm(t.lang).split('-')[0] === base);
    return hit.find((t) => !t.cc) || hit[0] || null;
  }

  // ---------- 3. 解析字幕檔 ----------
  function ts(t) {
    const p = t.trim().split(':').map(parseFloat);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0] || 0;
  }

  function decode(s) {
    return s
      .replace(/&lrm;|&rlm;|‎|‏/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function parseVTT(txt) {
    const cues = [];
    for (const block of txt.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const m = lines[i].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const text = decode(lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '')).trim();
      if (text) cues.push({ s: ts(m[1]), e: ts(m[2]), text });
    }
    return cues.sort((a, b) => a.s - b.s);
  }

  function textOf(node) {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1) s += c.localName === 'br' ? '\n' : textOf(c);
    }
    return s;
  }

  function parseTTML(txt) {
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const tt = doc.documentElement;
    const tickRate = parseFloat(
      tt.getAttribute('ttp:tickRate') ||
      tt.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate')
    ) || 10000000;
    const tv = (v) => (!v ? 0 : /t$/.test(v) ? parseFloat(v) / tickRate : ts(v));
    const cues = [];
    for (const p of doc.getElementsByTagNameNS('*', 'p')) {
      const text = decode(textOf(p)).replace(/[ \t]+\n/g, '\n').trim();
      if (text) cues.push({ s: tv(p.getAttribute('begin')), e: tv(p.getAttribute('end')), text });
    }
    return cues.sort((a, b) => a.s - b.s);
  }

  function loadCues(src) {
    if (!src) return Promise.resolve([]);
    if (!cueCache.has(src.url)) {
      cueCache.set(src.url, fetch(src.url)
        .then((r) => origText.call(r))
        .then((t) => (src.type === 'vtt' ? parseVTT(t) : parseTTML(t)))
        .catch((e) => { console.warn(TAG, '下載失敗', e); cueCache.delete(src.url); return []; }));
    }
    return cueCache.get(src.url);
  }

  // ---------- 4. 依目前影片載入字幕 ----------
  function currentMovieId() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  function refresh() {
    const id = currentMovieId();
    if (!id) { enCues = zhCues = []; loadedId = null; return; }
    if (captured.id && captured.id !== id) captured = { id, en: [], zh: [] };
    if (id === loadedId) return;
    const list = tracksByMovie.get(id) || (lastManifestId && tracksByMovie.get(lastManifestId));
    if (!list) return;
    loadedId = id;
    enCues = []; zhCues = [];
    const en = chooseTrack(list, CONFIG.EN_LANGS);
    const zh = chooseTrack(list, CONFIG.ZH_LANGS);
    Promise.all([loadCues(en && en.src), loadCues(zh && zh.src)]).then(([a, b]) => {
      if (loadedId !== id) return;
      enCues = a; zhCues = b;
      console.log(TAG, '字幕載入完成 英', a.length, '中', b.length);
    });
  }

  const getEn = () => (enCues.length ? enCues : captured.en);
  const getZh = () => (zhCues.length ? zhCues : captured.zh);

  // ---------- 5. 畫面顯示 ----------
  let overlay, enEl, zhEl, styleEl, statusEl, statusText = '', statusUntil = 0;

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.textContent = `
      html.nfbi-on .player-timedtext { opacity: 0 !important; }
      #nfbi-overlay { position: fixed; z-index: 2147483000; pointer-events: none;
        display: flex; flex-direction: column; align-items: center; text-align: center;
        font-family: ${FONT}; color: #fff; background: transparent; }
      #nfbi-overlay > div { white-space: nowrap; line-height: 1.2; font-weight: ${CONFIG.WEIGHT};
        background: transparent; color: #fff;
        ${CONFIG.SHADOW ? 'text-shadow: 0 0 4px rgba(0,0,0,.85), 0 1px 2px rgba(0,0,0,.85);' : ''} }
      #nfbi-status { position: fixed; top: 12px; left: 12px; z-index: 2147483001; pointer-events: none;
        font: 13px/1.5 -apple-system, 'PingFang TC', sans-serif; color: #fff;
        background: rgba(0,0,0,.65); padding: 6px 10px; border-radius: 6px; white-space: pre-line; }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function setStatus(text, host) {
    if (!CONFIG.SHOW_STATUS) return;
    if (text !== statusText) { statusText = text; statusUntil = Date.now() + 8000; }
    if (!statusEl) { statusEl = document.createElement('div'); statusEl.id = 'nfbi-status'; }
    if (host && statusEl.parentNode !== host) host.appendChild(statusEl);
    statusEl.textContent = statusText;
    statusEl.style.display = Date.now() < statusUntil ? '' : 'none';
  }

  function ensureOverlay(host) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'nfbi-overlay';
      enEl = document.createElement('div');
      zhEl = document.createElement('div');
      overlay.append(enEl, zhEl);
    }
    if (overlay.parentNode !== host) host.appendChild(overlay);
  }

  function activeText(cues, t) {
    const out = [];
    for (const c of cues) {
      if (c.s > t) break;
      if (t < c.e) out.push(c.text);
    }
    // 強制一行：把換行和多句合併成一行
    return out.join(' ').replace(/\s*\n\s*/g, ' ').trim();
  }

  let lastKey = '';
  function render() {
    requestAnimationFrame(render);
    const video = document.querySelector('video');
    if (!video || !currentMovieId()) {
      document.documentElement.classList.remove('nfbi-on');
      if (overlay) overlay.style.display = 'none';
      if (statusEl) statusEl.style.display = 'none';
      return;
    }
    ensureStyle();
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const host = fs && fs !== video && fs.contains(video) ? fs : (video.closest('.watch-video') || video.parentElement);

    const E = getEn(), Z = getZh();
    const hasManifest = tracksByMovie.has(currentMovieId()) || !!lastManifestId;
    setStatus(
      !enabled ? '雙語字幕：已關閉（按 B 開啟）'
      : E.length && Z.length ? '雙語字幕：英文 ✓　中文 ✓'
      : E.length || Z.length ? `雙語字幕：英文 ${E.length ? '✓' : '✗'}　中文 ${Z.length ? '✓' : '✗'}\n請在 Netflix 字幕選單切換到缺少的語言一次`
      : hasManifest ? '雙語字幕：找到字幕清單，正在下載…'
      : '雙語字幕：腳本運作中，還沒抓到字幕\n請在 Netflix 字幕選單切換一次 English 和 中文',
      host
    );

    const active = enabled && (E.length || Z.length);
    document.documentElement.classList.toggle('nfbi-on', !!active);
    if (!active) { if (overlay) overlay.style.display = 'none'; return; }
    ensureOverlay(host);

    const r = video.getBoundingClientRect();
    // 用畫面上實際看得到的範圍（避免影片元素超出視窗）
    const vTop = Math.max(0, r.top), vBottom = Math.min(window.innerHeight, r.bottom);
    const h = (vBottom - vTop) || window.innerHeight;
    const enSize = h * CONFIG.EN_SIZE;
    const zhSize = enSize * CONFIG.ZH_SCALE;
    const gap = Math.max(0, zhSize * CONFIG.GAP_RATIO - 0.1 * enSize - 0.1 * zhSize);

    const t = video.currentTime;
    const en = activeText(E, t);
    const zh = activeText(Z, t);

    // 固定高度，不隨滑鼠／控制列移動
    const bottom = window.innerHeight - vBottom + h * CONFIG.BOTTOM;

    const key = [en, zh, r.left, r.width, bottom, h, enSize].join('|');
    if (key === lastKey && overlay.style.display !== 'none') return;
    lastKey = key;

    overlay.style.display = en || zh ? 'flex' : 'none';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.bottom = bottom + 'px';
    enEl.textContent = en;
    zhEl.textContent = zh;
    enEl.style.fontSize = enSize + 'px';
    zhEl.style.fontSize = zhSize + 'px';
    enEl.style.display = en ? '' : 'none';
    zhEl.style.display = zh ? '' : 'none';
    zhEl.style.marginTop = en && zh ? gap + 'px' : '0';

    // 句子太長超出畫面時，自動把那一行字縮小到剛好放得下（仍保持一行）
    const maxW = r.width * 0.95;
    for (const [el, size] of [[enEl, enSize], [zhEl, zhSize]]) {
      if (el.style.display === 'none') continue;
      const w = el.scrollWidth;
      if (w > maxW) el.style.fontSize = (size * maxW / w) + 'px';
    }
  }

  // ---------- 6. 啟動 ----------
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(input|textarea)$/i.test((e.target && e.target.tagName) || '')) return;
    if (e.key && e.key.toLowerCase() === CONFIG.TOGGLE_KEY) { enabled = !enabled; lastKey = ''; }
  }, true);

  setInterval(refresh, 500);
  requestAnimationFrame(render);
})();
