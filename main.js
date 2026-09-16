'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, normalizePath } = require('obsidian');

const DEFAULT_SETTINGS = {
  enabled: true,
  toneColors: true,
  maxDefinitions: 6,
  maxEntries: 4,
  // 'None' | 'Shift' | 'Control' | 'Alt' | 'Meta'
  activationKey: 'Shift',
  // Milliseconds between each stroke revealing in the Stroke Order tab.
  strokeSpeedMs: 550,
};

// ---------- stroke-order growth animation geometry ----------
//
// The Stroke Order tab's animation technique, ported (as an algorithm -
// see below for why not as code) from chill-chinese/stroke-order-animator
// (github.com/chill-chinese/stroke-order-animator): rather than clipping a
// thick center-line stroke to the glyph's outline - the Hanzi Writer-style
// technique tried in v1.5.0 and reverted in v1.5.1 because it looked
// correct in every automated check but didn't actually render right
// inside real Obsidian - each stroke's own OUTLINE is grown directly. The
// median's start and end points are projected onto the outline, splitting
// it into two contours that both run from "start" to "end" (one going
// each way around). At progress t, a t-length fragment of each contour
// (both measured from "start") is stitched into one filled shape, so the
// shape grows from nothing at t=0 into the complete, exact stroke outline
// at t=1 - through plain point math, with no CSS clip-path, dasharray, or
// transitions anywhere (all suspects in the earlier real-Obsidian
// failure). See animateStrokes below for how progress is actually driven
// frame to frame.
//
// stroke-order-animator itself is a Flutter/Dart package built around
// Flutter's own Canvas - it can't be installed into a build-tool-free,
// plain-JS Obsidian plugin, so what's ported here is its algorithm
// (lib/src/character_painter.dart), reimplemented from scratch in vanilla
// JS. It operates on stroke outline `d` strings that only ever use
// absolute M/L/Q/C/Z commands (confirmed against every character in Make
// Me a Hanzi's graphics.txt, the same data source this plugin already
// uses), so a small hand-rolled flattener below turns them into plain
// point polylines rather than depending on
// SVGGeometryElement.getPointAtLength - which keeps this both testable
// under plain Node (no real SVG DOM needed) and dependency-free.

function distance2D(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Turns an SVG path `d` string (absolute M/L/Q/C/Z only) into a flat
// polyline: an array of [x, y] points dense enough to treat as
// piecewise-linear for length/animation purposes.
function flattenPathToPolyline(d, curveSegments) {
  const segments = curveSegments || 16;
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/gi) || [];
  const points = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;

  const num = () => parseFloat(tokens[i++]);

  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'm') {
      cx = num();
      cy = num();
      sx = cx;
      sy = cy;
      points.push([cx, cy]);
    } else if (cmd === 'L' || cmd === 'l') {
      cx = num();
      cy = num();
      points.push([cx, cy]);
    } else if (cmd === 'Q' || cmd === 'q') {
      const p1x = num();
      const p1y = num();
      const p2x = num();
      const p2y = num();
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        const mt = 1 - t;
        points.push([
          mt * mt * cx + 2 * mt * t * p1x + t * t * p2x,
          mt * mt * cy + 2 * mt * t * p1y + t * t * p2y,
        ]);
      }
      cx = p2x;
      cy = p2y;
    } else if (cmd === 'C' || cmd === 'c') {
      const p1x = num();
      const p1y = num();
      const p2x = num();
      const p2y = num();
      const p3x = num();
      const p3y = num();
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        const mt = 1 - t;
        points.push([
          mt * mt * mt * cx + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * p3x,
          mt * mt * mt * cy + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * p3y,
        ]);
      }
      cx = p3x;
      cy = p3y;
    } else if (cmd === 'Z' || cmd === 'z') {
      if (cx !== sx || cy !== sy) points.push([sx, sy]);
      cx = sx;
      cy = sy;
    }
  }

  return points;
}

function cumulativeLengths(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + distance2D(points[i - 1], points[i]));
  }
  return cum;
}

function pointAtLength(points, cum, len) {
  const total = cum[cum.length - 1];
  const clamped = Math.max(0, Math.min(len, total));
  if (clamped <= 0) return points[0];
  if (clamped >= total) return points[points.length - 1];
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < clamped) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen === 0 ? 0 : (clamped - cum[i]) / segLen;
  return [
    points[i][0] + (points[i + 1][0] - points[i][0]) * t,
    points[i][1] + (points[i + 1][1] - points[i][1]) * t,
  ];
}

// The distance-along-the-polyline of the sample point closest to `target`.
function closestLength(points, cum, target) {
  let best = Infinity;
  let bestLen = 0;
  for (let i = 0; i < points.length; i++) {
    const d = distance2D(points[i], target);
    if (d < best) {
      best = d;
      bestLen = cum[i];
    }
  }
  return bestLen;
}

// The portion of a polyline between two lengths [from, to] (from <= to),
// with exact interpolated endpoints so growth looks smooth rather than
// snapping between sampled vertices.
function extractSubPolyline(points, cum, from, to) {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(from, total));
  const b = Math.max(0, Math.min(to, total));
  if (b <= a) return [pointAtLength(points, cum, a)];
  const out = [pointAtLength(points, cum, a)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i] > a && cum[i] < b) out.push(points[i]);
  }
  out.push(pointAtLength(points, cum, b));
  return out;
}

function polylineWithLengths(points) {
  return { points, cum: cumulativeLengths(points) };
}

// Splits a closed outline polyline into two contours that both run from
// the point at `startLen` to the point at `endLen` - one going forward
// along the outline, the other going the rest of the way around. Mirrors
// stroke_order_animator's `_extractContourPaths`.
function splitOutlineAtLengths(outline, startLen, endLen) {
  const points = outline.points;
  const cum = outline.cum;
  const total = cum[cum.length - 1];
  let path1;
  let path2;

  if (endLen > startLen) {
    path1 = extractSubPolyline(points, cum, startLen, endLen);
    const tail = extractSubPolyline(points, cum, endLen, total);
    const wrap = extractSubPolyline(points, cum, 0, startLen);
    path2 = tail.concat(wrap.slice(1));
  } else {
    const head = extractSubPolyline(points, cum, startLen, total);
    const wrap = extractSubPolyline(points, cum, 0, endLen);
    path1 = head.concat(wrap.slice(1));
    path2 = extractSubPolyline(points, cum, endLen, startLen);
  }

  return { path1: polylineWithLengths(path1), path2: polylineWithLengths(path2) };
}

// Precomputes everything growthPathD needs to grow one stroke's outline
// from nothing (t=0) to the complete shape (t=1). Returns null if the
// stroke has no usable median (missing data, or a degenerate single-point
// median, e.g. some dot strokes) - callers fall back to a plain fade-in
// for those instead.
function buildStrokeGrowth(outlineD, median) {
  if (!median || median.length < 2) return null;

  const outlinePoints = flattenPathToPolyline(outlineD);
  if (outlinePoints.length < 3) return null;

  const outline = polylineWithLengths(outlinePoints);
  const total = outline.cum[outline.cum.length - 1];
  if (total <= 0) return null;

  const startLen = closestLength(outlinePoints, outline.cum, median[0]);
  const endLen = closestLength(outlinePoints, outline.cum, median[median.length - 1]);
  if (startLen === endLen) return null;

  const split = splitOutlineAtLengths(outline, startLen, endLen);
  const len1 = split.path1.cum[split.path1.cum.length - 1];
  const len2 = split.path2.cum[split.path2.cum.length - 1];
  if (len1 <= 0 || len2 <= 0) return null;

  return { path1: split.path1, path2: split.path2, len1, len2 };
}

// Renders a stroke's growth at progress t (0..1) as an SVG path `d`
// string: empty at t=0, exactly the full stroke outline at t=1. Filling
// an open path implicitly closes it with a straight line back to the
// first point, which is exactly what's wanted here (see
// buildStrokeGrowth's doc comment above).
function growthPathD(growth, t) {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped <= 0) return '';

  const frag1 = extractSubPolyline(growth.path1.points, growth.path1.cum, 0, clamped * growth.len1);
  const frag2 = extractSubPolyline(
    growth.path2.points,
    growth.path2.cum,
    (1 - clamped) * growth.len2,
    growth.len2
  );
  const combined = frag1.concat(frag2);

  return 'M ' + combined.map((pt) => `${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join(' L ') + ' Z';
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// CJK Unified Ideographs + Extension A + Compatibility Ideographs.
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function isCJK(ch) {
  return !!ch && CJK_RE.test(ch);
}

const KEY_CHECKS = {
  None: () => true,
  Shift: (evt) => !!evt.shiftKey,
  Control: (evt) => !!evt.ctrlKey,
  Alt: (evt) => !!evt.altKey,
  Meta: (evt) => !!evt.metaKey,
};

// ---------- pinyin numbered -> tone-marked ----------

const TONE_MARKS = {
  a: ['a', 'ā', 'á', 'ǎ', 'à'],
  e: ['e', 'ē', 'é', 'ě', 'è'],
  i: ['i', 'ī', 'í', 'ǐ', 'ì'],
  o: ['o', 'ō', 'ó', 'ǒ', 'ò'],
  u: ['u', 'ū', 'ú', 'ǔ', 'ù'],
  ü: ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

function markVowel(letters, vowel, tone) {
  const lower = letters.toLowerCase();
  const idx = lower.indexOf(vowel);
  if (idx === -1) return letters;
  const original = letters[idx];
  const isUpper = original !== original.toLowerCase();
  let marked = TONE_MARKS[vowel][tone];
  if (isUpper) marked = marked.toUpperCase();
  return letters.slice(0, idx) + marked + letters.slice(idx + 1);
}

// Converts one numbered pinyin syllable ("zhong1", "nu:3", "ma5", "A") into
// { text, tone } where tone is 0 for neutral/unknown.
function convertSyllable(raw) {
  const m = raw.match(/^([a-zA-Z:]+)([0-5])?$/);
  if (!m) return { text: raw, tone: 0 };
  let [, letters, toneStr] = m;
  letters = letters.replace(/u:/gi, 'ü').replace(/v/gi, 'ü');
  const tone = toneStr ? parseInt(toneStr, 10) : 0;
  if (!tone || tone === 5) return { text: letters, tone: 0 };

  const lower = letters.toLowerCase();
  let vowel = null;
  if (lower.includes('a')) vowel = 'a';
  else if (lower.includes('e')) vowel = 'e';
  else if (lower.includes('ou')) vowel = 'o';
  else {
    let bestIdx = -1;
    for (const v of ['i', 'o', 'u', 'ü']) {
      const li = lower.lastIndexOf(v);
      if (li > bestIdx) {
        bestIdx = li;
        vowel = v;
      }
    }
  }
  if (!vowel) return { text: letters, tone };
  return { text: markVowel(letters, vowel, tone), tone };
}

function pinyinToDisplay(pinyinField) {
  return pinyinField
    .split(/\s+/)
    .filter(Boolean)
    .map(convertSyllable);
}

// ---------- plugin ----------

class ZhongwenHoverPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
    this.dict = null;
    this.strokeData = null;
    this.audioSet = null;
    this.popupEl = null;
    this.rafPending = false;
    this.lastPos = null;
    this.mouseOverPopup = false;
    this.currentMatch = null;
    this.activeTab = 'meaning';
    this.currentAudio = null;
    this.pinned = false;

    await this.loadDictionary();
    await this.loadStrokeData();
    await this.loadAudioManifest();

    this.addSettingTab(new ZhongwenSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('mod-clickable');
    this.statusBarItem.addEventListener('click', () => this.toggleEnabled());
    this.updateStatusBar();

    this.ribbonIconEl = this.addRibbonIcon('languages', 'Toggle Chinese dictionary hover', () => this.toggleEnabled());
    this.updateRibbon();

    this.addCommand({
      id: 'toggle-zhongwen-hover',
      name: 'Toggle Chinese dictionary hover lookup',
      callback: () => this.toggleEnabled(),
    });

    this.createPopupEl();

    this.registerDomEvent(document, 'mousemove', this.onMouseMove.bind(this));
    this.registerDomEvent(document, 'mouseleave', () => {
      if (!this.mouseOverPopup) this.hidePopup();
    });
    this.registerDomEvent(document, 'keydown', this.onKeyEvent.bind(this));
    this.registerDomEvent(document, 'keyup', this.onKeyEvent.bind(this));
  }

  onunload() {
    if (this.popupEl) this.popupEl.remove();
  }

  // cedict.json's entries are [traditional, simplified, pinyin, definitions,
  // partOfSpeech]. The part-of-speech field (a short label like "noun",
  // "verb", "measure word") is NOT part of CC-CEDICT itself - CC-CEDICT
  // doesn't tag grammar at all - it's merged in at build time from jieba's
  // (github.com/fxsjy/jieba, MIT) word-frequency dictionary, matched by
  // headword. That source only tags ~75% of CC-CEDICT's entries, and it
  // tags one label per WORD rather than per reading, so a rarer reading of
  // a highly polyphonic character can inherit its more common reading's
  // label. It's empty ('') wherever no match was found - see
  // renderMeaningPanel, which just omits the badge in that case.
  async loadDictionary() {
    try {
      const dir = this.manifest.dir;
      const path = normalizePath(`${dir}/cedict.json`);
      const raw = await this.app.vault.adapter.read(path);
      this.dict = JSON.parse(raw);
    } catch (e) {
      console.error('Zenme Du: failed to load cedict.json', e);
      new Notice('Zenme Du: could not load dictionary data (cedict.json missing from the plugin folder?).');
    }
  }

  async loadStrokeData() {
    try {
      const dir = this.manifest.dir;
      const [raw1, raw2] = await Promise.all([
        this.app.vault.adapter.read(normalizePath(`${dir}/strokes-1.json`)),
        this.app.vault.adapter.read(normalizePath(`${dir}/strokes-2.json`)),
      ]);
      this.strokeData = Object.assign({}, JSON.parse(raw1), JSON.parse(raw2));
    } catch (e) {
      console.error('Zenme Du: failed to load stroke-order data', e);
      this.strokeData = null;
    }
  }

  async loadAudioManifest() {
    try {
      const dir = this.manifest.dir;
      const raw = await this.app.vault.adapter.read(normalizePath(`${dir}/audio/manifest.json`));
      this.audioSet = new Set(JSON.parse(raw));
    } catch (e) {
      console.error('Zenme Du: failed to load pronunciation audio manifest', e);
      this.audioSet = null;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    this.saveSettings();
    this.updateStatusBar();
    this.updateRibbon();
    if (!this.settings.enabled) this.hidePopup();
    new Notice(`Chinese dictionary hover ${this.settings.enabled ? 'enabled' : 'disabled'}`);
  }

  updateStatusBar() {
    if (!this.statusBarItem) return;
    this.statusBarItem.setText(`中文 ${this.settings.enabled ? 'ON' : 'OFF'}`);
    this.statusBarItem.setAttribute('aria-label', 'Click to toggle Chinese dictionary hover lookup');
  }

  updateRibbon() {
    if (!this.ribbonIconEl) return;
    this.ribbonIconEl.toggleClass('zh-hover-active', this.settings.enabled);
  }

  isActivationKeyHeld(evt) {
    const check = KEY_CHECKS[this.settings.activationKey] || KEY_CHECKS.None;
    return check(evt);
  }

  createPopupEl() {
    this.popupEl = document.createElement('div');
    this.popupEl.addClass('zh-hover-popup');
    this.popupEl.style.display = 'none';
    this.popupEl.addEventListener('mouseenter', () => {
      this.mouseOverPopup = true;
    });
    this.popupEl.addEventListener('mouseleave', () => {
      this.mouseOverPopup = false;
      this.hidePopup();
    });
    this.popupEl.addEventListener('click', (evt) => this.onPopupClick(evt));
    document.body.appendChild(this.popupEl);
  }

  onPopupClick(evt) {
    const tabBtn = evt.target.closest && evt.target.closest('[data-zh-tab]');
    if (tabBtn) {
      const tab = tabBtn.getAttribute('data-zh-tab');
      if (tab && tab !== this.activeTab) {
        this.activeTab = tab;
        this.renderPopupContent();
      }
      return;
    }
    const playBtn = evt.target.closest && evt.target.closest('[data-zh-play]');
    if (playBtn) {
      this.playPinyin(playBtn.getAttribute('data-zh-play'));
      return;
    }
    const charBox = evt.target.closest && evt.target.closest('[data-zh-replay]');
    if (charBox) this.replayStrokeAnimation(charBox);
  }

  // ---- pronunciation audio ----

  // Maps one numbered pinyin syllable to an available audio filename, or
  // null if there's no clip for it (rare/irregular tokens like bare letters
  // in entries such as "AA制", or the odd missing syllable).
  audioFilenameFor(rawSyllable) {
    if (!this.audioSet) return null;
    // The bundled clip set (like CC-CEDICT's own "u:" notation) doesn't
    // distinguish nü/lü from nu/lu, so this falls back to the plain form -
    // a small, disclosed inaccuracy for that handful of syllables.
    const key = rawSyllable.toLowerCase().replace(/u:/g, 'u');
    if (!/^[a-z]+[0-5]$/.test(key)) return null;
    return this.audioSet.has(key) ? `${key}.mp3` : null;
  }

  playPinyin(pinyinField) {
    if (!this.audioSet) {
      new Notice('Zenme Du: pronunciation audio is not available.');
      return;
    }
    const syllables = pinyinField.split(/\s+/).filter(Boolean);
    const clips = syllables.map((s) => this.audioFilenameFor(s)).filter(Boolean);
    if (!clips.length) {
      new Notice('No pronunciation audio for this entry.');
      return;
    }
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.playSequence(clips, 0);
  }

  playSequence(filenames, i) {
    if (i >= filenames.length) {
      this.currentAudio = null;
      return;
    }
    const dir = this.manifest.dir;
    const path = normalizePath(`${dir}/audio/${filenames[i]}`);
    const url = this.app.vault.adapter.getResourcePath(path);
    const audio = new Audio(url);
    this.currentAudio = audio;
    audio.addEventListener('ended', () => this.playSequence(filenames, i + 1));
    audio.addEventListener('error', () => this.playSequence(filenames, i + 1));
    audio.play().catch((e) => {
      console.error('Zenme Du: audio playback failed', e);
    });
  }

  onMouseMove(evt) {
    if (this.popupEl && this.popupEl.contains(evt.target)) return;

    // Pinned: the window is frozen open (content and all) until the mouse
    // leaves it - ignore hover state entirely while that's true.
    if (this.pinned) return;

    if (!this.settings.enabled || !this.dict) {
      this.hidePopup();
      return;
    }

    const target = evt.target;
    if (
      !(target instanceof Element) ||
      !target.closest(
        '.markdown-source-view, .markdown-reading-view, .workspace-leaf-content[data-type="markdown"]'
      )
    ) {
      this.hidePopup();
      return;
    }

    if (!this.isActivationKeyHeld(evt)) {
      if (!this.mouseOverPopup) this.hidePopup();
      return;
    }

    this.lastPos = { x: evt.clientX, y: evt.clientY };
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.lastPos) this.tryLookup(this.lastPos.x, this.lastPos.y);
    });
  }

  onKeyEvent(evt) {
    // While the popup is open, Tab pins it in place: it stops closing when
    // the activation key is released or the mouse leaves the word, and only
    // closes once the mouse actually leaves the popup window itself. Tab
    // again un-pins it (back to normal hover behavior).
    if (evt.key === 'Tab' && evt.type === 'keydown' && this.currentMatch) {
      if (evt.preventDefault) evt.preventDefault();
      this.pinned = !this.pinned;
      return;
    }

    if (this.pinned) return;

    if (!this.settings.enabled || !this.dict) return;
    if (this.settings.activationKey === 'None') return;

    if (this.isActivationKeyHeld(evt)) {
      if (this.lastPos) this.tryLookup(this.lastPos.x, this.lastPos.y);
    } else if (!this.mouseOverPopup) {
      this.hidePopup();
    }
  }

  tryLookup(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range) {
      this.hidePopup();
      return;
    }

    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      this.hidePopup();
      return;
    }

    const text = node.textContent || '';
    let offset = range.startOffset;
    if (offset >= text.length) offset = text.length - 1;
    if (offset < 0 || !isCJK(text[offset])) {
      this.hidePopup();
      return;
    }

    let runLen = 0;
    while (offset + runLen < text.length && isCJK(text[offset + runLen])) runLen++;

    const maxLen = Math.min(this.dict.meta.maxWordLen, 16, runLen);
    let match = null;
    for (let len = maxLen; len >= 1; len--) {
      const candidate = text.substr(offset, len);
      const simpIdxs = this.dict.simpIndex[candidate];
      const tradIdxs = this.dict.tradIndex[candidate];
      if (simpIdxs || tradIdxs) {
        const idxs = Array.from(new Set([...(simpIdxs || []), ...(tradIdxs || [])]));
        match = { word: candidate, entries: idxs.map((i) => this.dict.entries[i]) };
        break;
      }
    }

    if (!match) {
      this.currentMatch = null;
      this.hidePopup();
      return;
    }

    if (this.currentMatch && this.currentMatch.word === match.word) {
      // Same word still under the cursor: leave the popup (and its active
      // tab / animations) alone instead of rebuilding on every pixel of
      // mouse movement.
      return;
    }

    this.currentMatch = match;
    this.activeTab = 'meaning';
    this.renderPopupContent();
    this.positionPopup(x, y);
  }

  // ---- rendering ----

  renderPopupContent() {
    const el = this.popupEl;
    el.empty();

    const match = this.currentMatch;
    if (!match) return;

    const tabs = el.createDiv({ cls: 'zh-hover-tabs' });
    tabs.createEl('button', {
      cls: 'zh-hover-tab' + (this.activeTab === 'meaning' ? ' zh-hover-tab-active' : ''),
      text: 'Meaning',
      attr: { 'data-zh-tab': 'meaning', type: 'button' },
    });
    tabs.createEl('button', {
      cls: 'zh-hover-tab' + (this.activeTab === 'stroke' ? ' zh-hover-tab-active' : ''),
      text: 'Stroke Order',
      attr: { 'data-zh-tab': 'stroke', type: 'button' },
    });

    el.createDiv({ cls: 'zh-hover-word', text: match.word });

    if (this.activeTab === 'stroke') {
      this.renderStrokePanel(el, match);
    } else {
      this.renderMeaningPanel(el, match);
    }

    el.style.display = 'block';
  }

  renderMeaningPanel(el, match) {
    const panel = el.createDiv({ cls: 'zh-hover-panel' });

    match.entries.slice(0, this.settings.maxEntries).forEach(([trad, simp, pinyin, defsRaw, pos]) => {
      const block = panel.createDiv({ cls: 'zh-hover-entry' });

      const pinyinRow = block.createDiv({ cls: 'zh-hover-pinyin-row' });
      const pinyinEl = pinyinRow.createDiv({ cls: 'zh-hover-pinyin' });
      const tokens = pinyinToDisplay(pinyin);
      tokens.forEach((tok, ti) => {
        const span = pinyinEl.createSpan({ text: tok.text + (ti < tokens.length - 1 ? ' ' : '') });
        if (this.settings.toneColors && tok.tone) span.addClass(`zh-tone-${tok.tone}`);
      });
      // Part-of-speech tag (noun/verb/adjective/measure word/etc.), when
      // available - see loadDictionary's comment on where these come from.
      // Not every entry has one (see settings tab / README for coverage).
      if (pos) {
        pinyinRow.createSpan({ cls: 'zh-hover-pos', text: pos });
      }
      if (this.audioSet) {
        pinyinRow.createEl('button', {
          cls: 'zh-hover-play',
          text: '🔊',
          attr: { 'data-zh-play': pinyin, type: 'button', 'aria-label': 'Play pronunciation' },
        });
      }

      if (trad !== simp) {
        block.createDiv({ cls: 'zh-hover-alt', text: `${simp} / ${trad}` });
      }

      const defsEl = block.createEl('ol', { cls: 'zh-hover-defs' });
      const defs = defsRaw.split('/').filter(Boolean).slice(0, this.settings.maxDefinitions);
      defs.forEach((d) => defsEl.createEl('li', { text: d }));
    });

    panel.createDiv({ cls: 'zh-hover-footer', text: 'CC-CEDICT' });
  }

  renderStrokePanel(el, match) {
    const chars = Array.from(match.word);
    // Two characters (or fewer) sit side by side; longer words stack in a
    // vertical, one-character-per-line list instead of wrapping awkwardly.
    const vertical = chars.length > 2;
    const panelCls = 'zh-hover-panel zh-hover-stroke-panel' + (vertical ? ' zh-hover-stroke-panel-vertical' : '');
    const panel = el.createDiv({ cls: panelCls });

    chars.forEach((ch) => {
      const data = this.strokeData && this.strokeData[ch];
      const box = panel.createDiv({ cls: 'zh-stroke-char', attr: { 'data-zh-replay': '1' } });

      if (!data) {
        box.createDiv({ cls: 'zh-stroke-missing', text: ch });
        box.createDiv({ cls: 'zh-stroke-caption', text: 'no stroke data' });
        return;
      }

      const svg = this.buildStrokeSVG(data);
      box.appendChild(svg);

      const info = box.createDiv({ cls: 'zh-stroke-info' });
      info.createDiv({
        cls: 'zh-stroke-caption',
        text: `${data.s.length} stroke${data.s.length === 1 ? '' : 's'}`,
      });
      // No data-zh-replay attribute here on purpose: the click handler looks
      // up the DOM for the nearest element carrying it, which should be the
      // char box (so it can find that box's own .zh-stroke-svg) - putting
      // the attribute on the button too would make it match itself instead
      // and the lookup for the svg would fail silently.
      info.createEl('button', {
        cls: 'zh-stroke-replay-btn',
        text: '↻',
        attr: { type: 'button', 'aria-label': 'Replay stroke animation' },
      });

      this.animateStrokes(svg);
    });

    panel.createDiv({ cls: 'zh-hover-footer', text: 'Stroke data: Make Me a Hanzi (Arphic Public License)' });
  }

  buildStrokeSVG(data) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1024 1024');
    svg.setAttribute('width', '100');
    svg.setAttribute('height', '100');
    svg.addClass('zh-stroke-svg');

    const ghost = document.createElementNS(NS, 'g');
    ghost.setAttribute('transform', 'scale(1,-1) translate(0,-900)');
    ghost.setAttribute('style', 'fill: var(--text-faint); opacity: 0.35;');
    data.s.forEach((d) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      ghost.appendChild(p);
    });
    svg.appendChild(ghost);

    const anim = document.createElementNS(NS, 'g');
    anim.setAttribute('transform', 'scale(1,-1) translate(0,-900)');
    anim.setAttribute('style', 'fill: var(--interactive-accent);');
    data.s.forEach((d, i) => {
      const p = document.createElementNS(NS, 'path');
      p.addClass('zh-stroke-anim-path');
      // Precomputed once per stroke (see the stroke-growth geometry
      // helpers up top); replaying just re-drives progress through this
      // same data. Strokes with no usable median - missing entirely, or a
      // degenerate single-point one, e.g. some dot strokes - fall back to
      // a plain fade-in of the full outline instead of growing.
      const median = data.m && data.m[i];
      p.zhGrowth = buildStrokeGrowth(d, median);
      if (!p.zhGrowth) {
        p.setAttribute('d', d);
      }
      anim.appendChild(p);
    });
    svg.appendChild(anim);

    return svg;
  }

  // Grows each stroke's true glyph-shaped outline into place via
  // requestAnimationFrame, updating its `d` attribute directly frame by
  // frame (see the stroke-growth geometry helpers up top for how the
  // shape itself is computed) - deliberately not a CSS transition and not
  // a clip-path, since a Hanzi Writer-style version of this animation
  // that used exactly those two things looked correct in every automated
  // check but didn't actually render right inside real Obsidian (v1.5.0,
  // reverted in v1.5.1). strokeSpeedMs still controls the pacing between
  // strokes; each stroke's own reveal takes a fraction of that so
  // consecutive strokes blend into one continuous motion, eased with
  // easeInOutCubic so it doesn't look mechanically linear.
  //
  // Replaying (see replayStrokeAnimation) calls this again on an svg that
  // may already be mid-reveal or fully revealed. Any in-flight animation
  // loop for this svg is cancelled first, then every stroke is snapped
  // back to its undrawn state (empty `d` for growth strokes, opacity 0
  // for fallback ones) before a fresh loop starts from a new start time -
  // there's no CSS transition state that can be interrupted or carried
  // over here, so a replay always restarts cleanly from scratch.
  animateStrokes(svg) {
    if (svg.zhAnimHandle != null) {
      cancelAnimationFrame(svg.zhAnimHandle);
      svg.zhAnimHandle = null;
    }

    const stepMs = this.settings.strokeSpeedMs || DEFAULT_SETTINGS.strokeSpeedMs;
    const duration = Math.max(200, Math.min(Math.round(stepMs * 0.9), 480));
    const paths = Array.from(svg.querySelectorAll('.zh-stroke-anim-path'));

    paths.forEach((p) => {
      p.removeClass('zh-stroke-revealed');
      if (p.zhGrowth) {
        p.setAttribute('d', '');
      } else {
        p.style.opacity = '0';
      }
    });

    const startTime = performance.now();

    const step = () => {
      const elapsed = performance.now() - startTime;
      let anyPending = false;

      paths.forEach((p, i) => {
        if (p.hasClass('zh-stroke-revealed')) return;

        const local = (elapsed - stepMs * i) / duration;
        if (local < 0) {
          anyPending = true;
          return;
        }

        const t = Math.max(0, Math.min(1, local));
        const eased = easeInOutCubic(t);

        if (p.zhGrowth) {
          p.setAttribute('d', growthPathD(p.zhGrowth, eased));
        } else {
          p.style.opacity = String(eased);
        }

        if (t >= 1) {
          p.addClass('zh-stroke-revealed');
        } else {
          anyPending = true;
        }
      });

      svg.zhAnimHandle = anyPending ? requestAnimationFrame(step) : null;
    };

    svg.zhAnimHandle = requestAnimationFrame(step);
  }

  replayStrokeAnimation(charBox) {
    const svg = charBox.querySelector ? charBox.querySelector('.zh-stroke-svg') : null;
    if (!svg) return;
    this.animateStrokes(svg);
  }

  positionPopup(x, y) {
    const el = this.popupEl;
    el.style.left = '0px';
    el.style.top = '0px';

    const pad = 14;
    const rect = el.getBoundingClientRect();
    let left = x + 16;
    let top = y + 20;
    if (left + rect.width + pad > window.innerWidth) left = x - rect.width - 16;
    if (top + rect.height + pad > window.innerHeight) top = y - rect.height - 20;
    if (left < pad) left = pad;
    if (top < pad) top = pad;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  hidePopup() {
    this.currentMatch = null;
    this.pinned = false;
    if (this.popupEl) this.popupEl.style.display = 'none';
  }
}

class ZhongwenSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Zenme Du' });

    new Setting(containerEl)
      .setName('Enable hover lookup')
      .setDesc('Master switch. When off, hovering never shows the dictionary popup.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
          this.plugin.updateRibbon();
          if (!v) this.plugin.hidePopup();
        })
      );

    new Setting(containerEl)
      .setName('Activation key')
      .setDesc(
        'Hold this key while hovering Chinese text to show the popup (like LingLook\'s hold-to-look-up mode). Choose "Always show" to bring back the old always-on hover. While the popup is open, press Tab to pin it in place (it then stays open even after you release the key or move away, until your mouse leaves the popup) — press Tab again to un-pin it.'
      )
      .addDropdown((d) =>
        d
          .addOption('Shift', 'Shift')
          .addOption('Control', 'Ctrl')
          .addOption('Alt', 'Alt')
          .addOption('Meta', 'Cmd / Win')
          .addOption('None', 'Always show (no key)')
          .setValue(this.plugin.settings.activationKey)
          .onChange(async (v) => {
            this.plugin.settings.activationKey = v;
            await this.plugin.saveSettings();
            this.plugin.hidePopup();
          })
      );

    new Setting(containerEl)
      .setName('Tone-colored pinyin')
      .setDesc('Color pinyin syllables by tone (1 red, 2 orange, 3 green, 4 blue, neutral uncolored).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.toneColors).onChange(async (v) => {
          this.plugin.settings.toneColors = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Maximum definitions per entry')
      .setDesc('How many definition lines to show for each dictionary entry.')
      .addSlider((s) =>
        s
          .setLimits(1, 12, 1)
          .setValue(this.plugin.settings.maxDefinitions)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxDefinitions = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Stroke animation speed')
      .setDesc('Milliseconds between each stroke appearing in the Stroke Order tab. Higher = slower.')
      .addSlider((s) =>
        s
          .setLimits(150, 1200, 50)
          .setValue(this.plugin.settings.strokeSpeedMs)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.strokeSpeedMs = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Maximum entries per word')
      .setDesc('Some words have multiple pronunciations/meanings in CC-CEDICT. How many to show at once.')
      .addSlider((s) =>
        s
          .setLimits(1, 8, 1)
          .setValue(this.plugin.settings.maxEntries)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxEntries = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('p', {
      text: this.plugin.dict
        ? `Dictionary: CC-CEDICT, ${this.plugin.dict.meta.entryCount.toLocaleString()} entries — the same dictionary LingLook uses. Licensed CC BY-SA 3.0 by MDBG.`
        : 'Dictionary failed to load — check the console for details.',
      cls: 'setting-item-description',
    });

    containerEl.createEl('p', {
      text: this.plugin.strokeData
        ? `Stroke order: ${Object.keys(this.plugin.strokeData).length.toLocaleString()} characters, from the Make Me a Hanzi project (Arphic Public License).`
        : 'Stroke order data failed to load — check the console for details.',
      cls: 'setting-item-description',
    });

    containerEl.createEl('p', {
      text: this.plugin.audioSet
        ? `Pronunciation: ${this.plugin.audioSet.size.toLocaleString()} syllable recordings (public domain). Click 🔊 next to a pinyin line to play it. Note: nü/lü syllables (e.g. 女, 绿) play as nu/lu — the recording set doesn't distinguish them.`
        : 'Pronunciation audio failed to load — check the console for details.',
      cls: 'setting-item-description',
    });
  }
}

module.exports = ZhongwenHoverPlugin;
