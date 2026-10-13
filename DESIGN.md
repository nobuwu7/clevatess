# Clevatess design system

**Mode:** Operate. People come here to finish an edit; the tool should disappear into the task.

**World:** an editing suite at night. Warm graphite surfaces, so footage reads true, with one tungsten-amber accent for whatever is live or selected: the playhead, the current selection, primary actions and the assistant's cut marks.

## Tokens (`src/ui/styles.css`)

| Role | Value |
| --- | --- |
| Ground / panel / raised / sunken | `#0b0b0a` / `#121211` / `#191917` / `#0e0e0d` |
| Text / muted / faint | `#edebe5` / `#9b998f` / `#87857c` (all at least 4.5:1 on panels) |
| Accent | `#ffb224` with ink `#1c1300` |
| State | ok `#6fd6a0`, danger `#ff6b5e` |
| Track fills | video `#24231f`, text `#3a2c10`, audio `#1a2420` with waveform `#8aa898` |

Dark only, deliberately: video is judged against a dark surround.

## Type

Geist for the interface, Geist Mono only for measurements (timecodes, sizes, hex values, URLs). One family carries headings, labels and body. The scale steps are 11.5, 12, 13, 15 and 26px.

Brand-kit typefaces (Bricolage Grotesque, Space Grotesk, Outfit, Archivo Black, DM Sans, Playfair Display) are content: they style titles and captions in the video, never the UI.

## Shape

| Element | Radius |
| --- | --- |
| Controls (buttons, inputs, segmented controls) | 6px |
| Cards, list rows, presets | 9px |
| Dialogs, composer | 14px |
| Status pills, the play button | full |

## Icons

Phosphor (via `react-icons/pi`), regular weight, 13 to 16px. The two-panel logo mark is the only hand-drawn glyph.

## Motion

Motion carries state, and nothing else.

- Easing tokens: `--ease-out` `cubic-bezier(0.23,1,0.32,1)` for things entering, `--ease-in-out` for movement on screen.
- Presses scale to 0.97 in 140ms. Hovers apply only on fine pointers.
- Dialogs enter at scale 0.96 in 200ms and leave faster (140ms).
- Nothing animates on keyboard actions (space, S, arrows, undo).
- Reframing to a new aspect ratio blurs in over 240ms so the size jump reads as one change.
- Cut marks drop in with a 30ms stagger.
- Titles and captions animate only during playback. A paused frame shows their settled state.
- Under `prefers-reduced-motion`, only opacity changes remain.

## Signature move

**Edit seams.** After an assistant or tool edit, each new cut point gets a small amber marker on the ruler and a dashed line through the tracks. The toolbar counts them ("4 new cuts"). They persist across edits that don't touch the footage, and clear on undo or on a manual change.
