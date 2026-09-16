# Changelog

## 1.2.0
- Reworked the Stroke Order tab's animation technique, this time porting
  the approach used by
  [stroke-order-animator](https://github.com/chill-chinese/stroke-order-animator):
  each stroke's median endpoints are projected onto its own outline, which
  splits that outline into two contours running from one endpoint to the
  other. Growing both together stitches the *true, exact stroke shape*
  into place stroke by stroke — instead of the previous simple
  grow-and-fade, characters now look genuinely hand-written, in the
  correct stroke order. That source library is a Flutter/Dart package, so
  it couldn't be used directly; what's ported is its algorithm,
  reimplemented from scratch in plain JS.
- The animation itself is now driven by `requestAnimationFrame` updating
  plain SVG path data directly, rather than CSS transitions.
- The bundled stroke data now also carries each stroke's median (not just
  its outline), needed for the new technique — grew from ~23 MB to ~29 MB
  combined.

## 1.1.0
- Meaning tab entries now show a small part-of-speech badge next to the
  pinyin (noun, verb, adjective, adverb, measure word, place name, and so
  on) when it's known. CC-CEDICT itself doesn't tag grammar, so these are
  merged in at build time from jieba's (MIT-licensed) word-frequency
  dictionary, matched by headword — covers roughly 3 in 4 entries. Because
  it's tagged per word rather than per reading, a rarer reading of a
  highly polyphonic character can inherit its more common reading's label;
  entries with no match simply show no badge.

## 1.0.0
Initial release of **Zenme Du** (怎么读, "how do you read this") — a
hover-to-lookup Chinese dictionary for Obsidian, modeled on the LingLook
browser extension.

- **Hover lookup, hold-to-activate.** Hold a configurable key (Shift by
  default — Ctrl, Alt, Cmd/Win, or always-on are also selectable) and hover
  Chinese text to look it up, in both Reading view and Live Preview.
- **Longest-match word segmentation**, so hovering the first character of a
  multi-character word shows the whole word, not just that one character.
- **CC-CEDICT definitions** — 100,000+ entries, tone-colored pinyin, and
  both simplified and traditional forms.
- **Audio pronunciation** — a 🔊 button plays each entry's reading aloud,
  syllable by syllable.
- **Stroke Order tab** — an animated stroke-order diagram for every
  character in the hovered word, each stroke easing in with a smooth
  grow-and-fade. Tap the ↻ button (or the character itself) to replay it;
  its speed is adjustable in settings. Words of three or more characters
  stack vertically instead of wrapping.
- **Scrolls when it needs to** — a word with many dictionary entries, or a
  long word in the Stroke Order tab, scrolls inside the popup instead of
  growing off-screen.
- **Pin the popup** with <kbd>Tab</kbd> so it stays open after releasing the
  activation key or moving the mouse away — handy for reading, clicking the
  stroke tab, or replaying an animation at your own pace.
- **Toggle anywhere** — a ribbon icon, a status-bar indicator, and a command
  palette entry all turn the whole feature on/off.
