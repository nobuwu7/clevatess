# Design passes

The UI went through three review passes in a fixed order: Emil Kowalski's design-engineering principles first, then [Impeccable](https://github.com/pbakaus/impeccable), then Taste. Each pass reviewed the result of the one before it.

## 1. Emil (design engineering, motion)

The first build already followed the core rules (exact transition properties, custom ease-out curves, `scale(0.97)` on press, hover gated behind `(hover: hover)`, no animation on keyboard actions, dialogs exit faster than they enter). The review then found:

| Before | After | Why |
| --- | --- | --- |
| `.suggestion` animated with `forwards` fill | `backwards` fill, keyframes define only the `from` state | A held keyframe overrode the `:active` scale, so suggestion presses gave no feedback |
| Every chat message animated on mount | Only messages created this session animate | Reloading the page made the whole history fly in at once |
| Aspect change snapped the frame to a new size | 240ms blur, opacity and scale settle via WAAPI | Blur masks the swap so it reads as one change |
| Tab underline jumped between tabs | One indicator slides, 220ms ease-in-out | Spatial continuity between panels |
| Titles and captions faded in even when paused at their first frame | A paused frame renders the settled state | A still preview should show content; entrance motion belongs to playback |
| "Undo this" disappeared silently | Undone turns show "Undone" and strike through their ops | State indication |
| Toast sat over the transport bar | Raised clear of it | It covered the play controls |

## 2. Impeccable (audit and polish, Operate mode)

Ran `impeccable context` (no PRODUCT.md, so this was a refinement of the incumbent implementation), then the craft floor, `audit` and `polish`, plus the mechanical detector.

| Finding | Change |
| --- | --- |
| Detector: gradient text on the "thinking" shimmer | Replaced with an opacity pulse |
| Faint text at about 3.3:1 | Raised to `#87857c` (at least 4.5:1) |
| Uppercase tracked section labels (a banned eyebrow pattern) | Sentence-case 12px semibold group labels |
| No signature move; the world read as grey plus one accent | **Edit seams**: amber cut markers showing where the last automatic edit touched the footage |
| No loading state while importing | Inline "Importing N files" status |
| Tool buttons (Cut silences, Transcribe) left the busy state stuck and swallowed errors | The executor restores busy state and toasts errors |
| Error copy named environment variables to end users | Copy points to Settings and names the recovery |
| Browser surfaces at defaults | Themed selection, caret and thin scrollbars; long URLs wrap in chat |
| 26 to 30px targets on touch | 38px minimum on coarse pointers; wider trim handles |
| Mobile overflowed by 57px | Transport wraps; timeline toolbar scrolls |
| A unicode "×" used as an icon | A real icon |

The detector reported nothing after the fixes.

## 3. Taste (anti-slop)

Taste is built for landing pages and declares dense product UI out of scope, so only its transferable rules were applied. Design read: *an operate-mode creative tool for video makers, in a dark, instrument-calm language, leaning toward native CSS tokens + Geist + restrained, state-driven motion.*

| Rule | Change |
| --- | --- |
| Em-dash ban | Removed every em and en dash from visible copy and op labels ("Cut 1.0-2.0s") |
| Serif discipline: Fraunces and Instrument Serif banned as defaults | Brand fonts now offer Outfit and Playfair Display in their place; the editorial caption style uses Playfair Display italic |
| One icon family, Phosphor preferred over Lucide | Every icon moved to Phosphor |
| Colour consistency lock | Waveform and audio track desaturated so amber stays the only saturated hue besides state colours |
| Shape consistency lock | Radius rule written down in DESIGN.md and checked |
| Copy self-audit | Every string re-read; no filler verbs, no fake numbers |

Not applied, deliberately: Taste's light/dark dual-mode default (a video editor is judged against a dark surround), and self-hosted fonts. Fonts still load from Google Fonts because the build environment had no package registry access; switching to `@fontsource/*` packages is a small follow-up.
