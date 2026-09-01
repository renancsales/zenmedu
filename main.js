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

    match.entries.slice(0, this.settings.maxEntries).forEach(([trad, simp, pinyin, defsRaw]) => {
      const block = panel.createDiv({ cls: 'zh-hover-entry' });

      const pinyinRow = block.createDiv({ cls: 'zh-hover-pinyin-row' });
      const pinyinEl = pinyinRow.createDiv({ cls: 'zh-hover-pinyin' });
      const tokens = pinyinToDisplay(pinyin);
      tokens.forEach((tok, ti) => {
        const span = pinyinEl.createSpan({ text: tok.text + (ti < tokens.length - 1 ? ' ' : '') });
        if (this.settings.toneColors && tok.tone) span.addClass(`zh-tone-${tok.tone}`);
      });
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
    data.s.forEach((d) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.addClass('zh-stroke-anim-path');
      anim.appendChild(p);
    });
    svg.appendChild(anim);

    return svg;
  }

  // Reveals each stroke in turn via a CSS opacity+scale transition (a
  // 'zh-stroke-revealed' class toggle) rather than a per-stroke JS timer -
  // the browser's own transition handles the easing, so strokes materialize
  // smoothly instead of popping in on a fixed tick. strokeSpeedMs still
  // controls the pacing between strokes; the transition duration is a
  // fraction of it so consecutive strokes blend into one continuous motion.
  //
  // Replaying (see replayStrokeAnimation) calls this again on an svg that
  // may already be mid-reveal or fully revealed. To make that an actual
  // restart rather than an interrupted, unpredictable transition, every
  // stroke is first switched to transition-property: none and snapped
  // straight back to hidden - so removing 'zh-stroke-revealed' can't itself
  // animate using stale duration/delay values left over from the run being
  // interrupted. Only after that reset is forced to commit (a layout read)
  // are transitions turned back on with this run's duration/delay, and only
  // then does 'zh-stroke-revealed' go back on to start the reveal - so
  // clicking the replay button always restarts every stroke from scratch,
  // no matter what state the animation was in when it was clicked.
  animateStrokes(svg) {
    const stepMs = this.settings.strokeSpeedMs || DEFAULT_SETTINGS.strokeSpeedMs;
    const duration = Math.max(200, Math.min(Math.round(stepMs * 0.9), 480));
    const paths = svg.querySelectorAll('.zh-stroke-anim-path');

    paths.forEach((p) => {
      p.style.transitionProperty = 'none';
      p.removeClass('zh-stroke-revealed');
    });

    // Force layout so the "hidden, no transition" reset above is committed
    // before anything below changes it - otherwise the browser can
    // coalesce all of these changes into one and either skip straight to
    // the end state or carry over the interrupted transition instead of
    // cleanly restarting it.
    void svg.getBoundingClientRect();

    paths.forEach((p, i) => {
      p.style.transitionProperty = 'opacity, transform';
      p.style.transitionDuration = `${duration}ms`;
      p.style.transitionDelay = `${stepMs * i}ms`;
    });

    // Force layout again so the "hidden, transitions back on" state above
    // is committed before the class goes back on below - same reasoning as
    // the first forced layout.
    void svg.getBoundingClientRect();

    paths.forEach((p) => p.addClass('zh-stroke-revealed'));
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
