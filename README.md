# Zenme Du

Hold a key and hover any Chinese text in your notes to see pinyin, English
definitions, audio pronunciation, and an animated stroke-order diagram —
right inside Obsidian. No alt-tabbing to a dictionary site or browser
extension.

It's a from-scratch recreation, inside Obsidian, of the core experience of
[LingLook](https://github.com/ph0ngp/linglook) (a hover-to-look-up Chinese
browser extension, itself a fork of [10ten Japanese
Reader](https://github.com/birtles/10ten-ja-reader)) — built for anyone
studying Chinese who takes notes in Obsidian.

Made with the help of Claude.

![Preview of the Meaning and Stroke Order tabs](docs/demo.gif)
Preview of the meaning and stroke order tabs

## Features

- **Hover lookup, hold-to-activate.** Hold a configurable key (Shift by
  default — Ctrl, Alt, and Cmd/Win are also selectable, or turn the key
  requirement off entirely) and hover Chinese text to look it up. Works in
  both **Reading view** and **Live Preview**.
- **Longest-match word segmentation.** Chinese text has no spaces between
  words, so hovering the first character of 学习 shows the whole word, not
  just 学 — the same rikai/10ten-style technique LingLook itself uses.
- **CC-CEDICT definitions**, the same open dictionary LingLook uses —
  100,000+ entries, tone-colored pinyin, and both simplified and
  traditional forms.
- **Audio pronunciation.** A 🔊 button next to each entry plays the word
  aloud, syllable by syllable.
- **Stroke order tab, fluid animation.** Every character in the hovered
  word gets an animated stroke-order diagram: each stroke eases in with a
  smooth grow-and-fade instead of an instant flip, no numbered badges
  cluttering the glyph. Words of three or more characters stack vertically,
  one per row, instead of wrapping. Tap the ↻ button (or the character
  itself) to replay the animation; its speed is adjustable in settings.
- **Scrolls when it needs to.** A word with many dictionary entries, or a
  long word in the Stroke Order tab, scrolls inside the popup instead of
  growing off-screen.
- **Pin the popup.** Press <kbd>Tab</kbd> while the popup is open to pin it
  in place — it stays open even after you release the activation key or
  move the mouse away, so you can read it, click the stroke tab, or hit
  play at your own pace. It closes once your mouse leaves the popup (or
  press <kbd>Tab</kbd> again to un-pin).
- **Toggle anywhere.** A ribbon icon, a status-bar indicator, and a command
  palette entry all turn the whole feature on/off.

## How to use it

1. Open a note with Chinese text, in Reading view or Live Preview.
2. Hold **Shift** and hover a word. A popup appears with pinyin and
   definitions.
3. Click **🔊** to hear it, or click the **Stroke Order** tab to watch it
   get written, stroke by stroke.
4. Press **Tab** to pin the popup so you can move your mouse onto it
   without it disappearing — handy for clicking around or replaying a
   stroke animation.
5. Toggle the whole feature from the ribbon icon, the `中文 ON/OFF`
   status-bar item, or the command palette (**Toggle Chinese dictionary
   hover lookup**).

## Settings

| Setting | What it does |
|---|---|
| Enable hover lookup | Master on/off switch |
| Activation key | Shift / Ctrl / Alt / Cmd·Win / always-on |
| Tone-colored pinyin | Color each syllable by tone (1 red, 2 orange, 3 green, 4 blue) |
| Maximum definitions per entry | How many definition lines to show |
| Maximum entries per word | How many readings to show for polyphonic words |
| Stroke animation speed | Milliseconds between each stroke appearing (150–1200) |

## Installation

**Manual (until this is accepted into the community plugin directory):**

1. Download the latest release.
2. Copy the folder into `<your vault>/.obsidian/plugins/zenmedu/` — it
   should contain `manifest.json`, `main.js`, `styles.css`, and the
   `cedict.json` / `strokes-*.json` / `audio/` data files alongside it.
3. In Obsidian, go to **Settings → Community plugins**, make sure
   restricted mode is off, and enable **Zenme Du**.

**Once published:** search "Zenme Du" in **Settings →
Community plugins → Browse**.

## Data sources & credits

This plugin's own code is MIT-licensed (see `LICENSE`), but it bundles data
from three separate open sources, each under its own license:

- **Dictionary** — [CC-CEDICT](https://cc-cedict.org/wiki/), published by
  MDBG. Licensed
  [CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/).
- **Stroke order** — [Make Me a
  Hanzi](https://github.com/skishore/makemeahanzi) (`graphics.txt`),
  derived from the Arphic PL KaitiM GB / PL UKai fonts. Licensed under the
  Arphic Public License.
- **Pronunciation audio** —
  [mp3-chinese-pinyin-sound](https://github.com/davinfifield/mp3-chinese-pinyin-sound)
  (1,632 per-syllable recordings, re-encoded to 32 kbps mono to shrink the
  bundle). Public domain ([Unlicense](https://unlicense.org/)).

## Known limitations

- **Desktop only** (`isDesktopOnly: true`) — the interaction model is
  built around a mouse and keyboard.
- **nü/lü audio.** The bundled recordings don't distinguish nü/lü from
  nu/lu (e.g. 女, 绿), so those play the plain nu/lu sound. Definitions and
  pinyin text are unaffected — this only affects the audio button.
- **Bundled data is large** (~50 MB total: dictionary, stroke outlines, and
  audio). See the note below before submitting.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
