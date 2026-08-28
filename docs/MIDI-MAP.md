# Numark NS6 MIDI implementation

Numark never published one. This is recorded from the hardware — every number
below was produced by moving the control and reading what came out, with
`ns6 map` from [ns6-rs](https://github.com/OsiPog/ns6-rs). The raw recording is
in [recorded-surface.toml](recorded-surface.toml).

Nothing here is Linux-specific. The NS6 sends the same MIDI whichever driver is
presenting it.

## Channels

The NS6 is a four-deck controller with two physical platters. The **LAYER**
button on each deck does not change the note numbers — it changes the **MIDI
channel** the whole deck side transmits on.

| MIDI channel | Carries |
|---|---|
| 1 | Mixer, effects, navigation |
| 2 | Deck 1 — left platter, LAYER on 1 |
| 3 | Deck 2 — right platter, LAYER on 2 |
| 4 | Deck 3 — left platter, LAYER on 3 |
| 5 | Deck 4 — right platter, LAYER on 4 |

The two LAYER buttons themselves report on channel 1: note 4 (deck A) and note 5
(deck B).

Note the consequence: a deck's controls go silent on their old channel the
moment you flip its layer. There is no "deck 1 and deck 3 both live" state.

## Per-deck, on that deck's channel

Identical on all four deck channels.

### Continuous

| Control | Message | Notes |
|---|---|---|
| PLATTER | CC 0 (MSB) + CC 32 (LSB) | 14-bit **absolute** position that wraps. Take the difference between readings, shortest way round. |
| PITCH FADER | CC 1 + CC 33 | 14-bit absolute |
| STRIP SEARCH | CC 2 | 7-bit absolute, 0 = start of track |

### Buttons

| Note | Dec | Control |
|---|---|---|
| 0x0F | 15 | SYNC |
| 0x10 | 16 | CUE |
| 0x11 | 17 | PLAY / PAUSE |
| 0x12 | 18 | DELETE CUE / SHIFT |
| 0x13–0x17 | 19–23 | HOT CUE 1–5 |
| 0x18 | 24 | PITCH BEND − |
| 0x19 | 25 | PITCH BEND + |
| 0x1A | 26 | PITCH RANGE |
| 0x1B | 27 | MASTER TEMPO |
| 0x1C | 28 | BLEEP / REVERSE |
| 0x1D | 29 | SKIP |
| 0x1E | 30 | TAP |
| 0x1F | 31 | BEAT GRID SET / CLEAR |
| 0x20 | 32 | BEAT GRID ADJUST / SLIP |
| 0x21 | 33 | SCRATCH |
| 0x22 | 34 | LOOP 1/2 X |
| 0x23 | 35 | LOOP 2 X |
| 0x24 | 36 | LOOP ON / OFF |
| 0x25 | 37 | LOOP SHIFT LEFT |
| 0x26 | 38 | LOOP SHIFT RIGHT |
| 0x27 | 39 | LOOP MODE (manual / autoloop) |
| 0x28 | 40 | LOOP IN, or autoloop 1 beat |
| 0x29 | 41 | LOOP OUT, or autoloop 2 beats |
| 0x2A | 42 | LOOP SELECT, or autoloop 4 beats |
| 0x2B | 43 | LOOP RELOOP, or autoloop 8 beats |

LOAD A is note 0x0C (12) and LOAD B note 0x0E (14), each sent on the channel of
the deck it loads.

## Mixer, channel 1

Every fader and knob is 14-bit: the LSB always sits 32 above the MSB.

| Strip | Fader | Bass | Mid | Treble | Gain | PFL (note) |
|---|---|---|---|---|---|---|
| 1 | CC 8 | 9 | 10 | 11 | 12 | 0x31 (49) |
| 2 | CC 13 | 14 | 15 | 16 | 17 | 0x32 (50) |
| 3 | CC 19 | 20 | 21 | 22 | 23 | 0x33 (51) |
| 4 | CC 24 | 25 | 26 | 27 | 28 | 0x34 (52) |

| Control | Message |
|---|---|
| CROSSFADER | CC 7 + CC 39 |
| MASTER VOLUME | CC 67, 7-bit absolute |
| BOOTH / ZONE VOLUME | CC 65, 7-bit absolute |

Note the gap at CC 18: the strips are otherwise a clean run of five, so
something sits there unaccounted for. It reports a resting value, so it exists.

**A channel transmits nothing at all unless its INPUT SELECTOR is set to PC.**
That switch is hardware — if a whole strip looks dead, check it before anything
else.

## Effects, channel 1

The FX SELECT, FX PARAM and SCROLL knobs are **relative encoders**: they send
1 for one click clockwise and 127 for one click anticlockwise, never an absolute
position.

| Control | FX A | FX B |
|---|---|---|
| ON / OFF | note 0x2D (45) | note 0x2F (47) |
| FX MIX | CC 87 + CC 119 | CC 89 + CC 121 |
| FX SELECT (encoder) | CC 90 | CC 91 |
| FX SELECT press | note 0x2E (46) | not recorded |
| FX PARAM (encoder) | CC 86 | CC 88 |

FX SEND to the master mix: note 0x45 (69) for A, 0x46 (70) for B.

## Navigation, channel 1

| Control | Message |
|---|---|
| SCROLL KNOB | CC 68, relative encoder |
| BACK | note 0x06 (6) |
| FWD | note 0x07 (7) |
| PREPARE | note 0x09 (9) |
| FILES | note 0x0A (10) |
| CRATES | note 0x0B (11) |
| LOAD PREPARE | note 0x0D (13) |
| VIEW | note 0x01 (1) |

## Not recorded

Honest gaps, rather than guesses:

- The eight per-channel **FX SEND** buttons (four strips × A/B). Only the two
  master ones were captured.
- **FX B SELECT knob press.**
- The **SCROLL knob press**.
- Whatever **CC 18** is.
- **CC 66** and **CC 85**, both of which report a resting value on channel 1.
  CC 85 rests at 64, so it is probably something that centres — CUE BLEND on the
  front panel would fit.

## LEDs — not yet verified

**The output direction is a guess.** Everything above was recorded from the
hardware; this section was not.

The mapping's `<outputs>` section assumes the usual convention on controllers of
this era — that sending a button the note it emits lights it, velocity 127 on
and 0 off. That has not been confirmed on an NS6, and there is no way to confirm
it from the vendor driver either: `ns6_usb.sys` forwards whatever the host sends
down the MIDI OUT pipe and holds no LED table of its own. Serato ITCH has it.

The NS6 also has lights that no button sends: the platter rings, the BPM meter,
the takeover LEDs beside each pitch fader. Those cannot follow the convention,
because there is no input note to mirror.

`ns6 leds` in [ns6-rs](https://github.com/OsiPog/ns6-rs) walks the output space
to settle it — one note lit at a time across all five channels, recording what
each one turns on. This section will be replaced with the result.

### Frame format

Whatever the note numbers turn out to be, MIDI **out** is framed, unlike MIDI
in. Every write to the device is one fixed 42-byte packet:

```text
[0 .. 39)  up to 39 MIDI bytes
[39, 40]   0xFD filler
[41]       device control byte, 0xE0 unless something sets it
```

The buffer is pre-filled with `0xFD` and then overwritten, so short messages are
padded rather than truncated. Raw MIDI written without this frame is simply
never parsed — which is worth knowing, because the pipe accepts it either way.
