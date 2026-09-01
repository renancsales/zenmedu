# Changelog

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
