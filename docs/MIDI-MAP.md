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

## LEDs

Recorded from the hardware the same way as the inputs, by sending each message
and watching the panel. The raw recording is in
[recorded-leds.toml](recorded-leds.toml).

Three things are worth knowing before reading the tables.

**LEDs are Control Change**, never note on. A full sweep of note on across all
five channels lights nothing at all.

**The numbers have no relation to the input notes.** SYNC sends note 15 and is
lit by CC 7; PLAY sends note 17 and is lit by CC 9. There is no single offset
between the two — the groups shift by different amounts.

**Deck LEDs are addressed by physical side, not by deck.** Channel 2 is the left
deck and channel 3 the right, whichever layer each is on. This is the opposite
of the input side, where the layer changes which channel a deck transmits on. So
software has to route: when the left deck is switched to layer 3, deck 3's state
has to be sent to channel 2.

Panel-wide lights respond on *any* channel, which is why a sweep shows them
repeatedly.

### Per deck — channel 2 (left) or 3 (right)

| CC | Dec | Lights |
|---|---|---|
| 0x07 | 7 | SYNC |
| 0x08 | 8 | CUE |
| 0x09 | 9 | PLAY |
| 0x0A | 10 | DELETE CUE / SHIFT |
| 0x0B–0x0F | 11–15 | HOT CUE 1–5 |
| 0x10 | 16 | MASTER TEMPO |
| 0x12 | 18 | SCRATCH |
| 0x15 | 21 | LOOP ON/OFF |
| 0x16 | 22 | BLEEP / REVERSE |
| 0x18 | 24 | LOOP MODE |
| 0x19–0x1C | 25–28 | LOOP IN / OUT / SELECT / RELOOP |
| 0x37 | 55 | Pitch fader 0% |
| 0x3C | 60 | Pitch takeover, up arrow |
| 0x3D | 61 | Pitch takeover, down arrow |

### Panel-wide — channel 1

| CC | Dec | Lights |
|---|---|---|
| 0x03 | 3 | CRATES |
| 0x04 | 4 | PREPARE |
| 0x05 | 5 | FILES |
| 0x11 | 17 | Left deck is on layer 3 |
| 0x28 | 40 | Right deck is on layer 4 |
| 0x17 | 23 | FX A on/off |
| 0x2E | 46 | FX B on/off |
| 0x44–0x4B | 68–75 | FX SEND, channel 1 A/B through channel 4 A/B |
| 0x4C | 76 | FX SEND A to master |
| 0x4D | 77 | FX SEND B to master |

### One message will take the device off the USB bus

**CC 57 on channel 1** drops the NS6 off the bus; it needs a power cycle to come
back. It is not a MIDI message as far as the hardware is concerned. The MIDI OUT
byte stream doubles as a serial register interface into an audio chip — the
vendor driver clocks bits through it with the byte patterns
`addr | 0x00/0x40/0x80/0xC0/0xE0` — so some values reach hardware that has
nothing to do with lighting buttons.

Others may exist. Anything not listed above was swept and did nothing, but that
was with value 127; other values were not tried.

### Frame format

MIDI **out** is framed, unlike MIDI in. Every write is one fixed 42-byte packet:

```text
[0 .. 39)  up to 39 MIDI bytes
[39, 40]   0xFD filler
[41]       device control byte, 0xE0 unless something sets it
```

The buffer is pre-filled with `0xFD` and then overwritten, so short messages are
padded rather than truncated. Raw MIDI written without this frame is never
parsed — worth knowing, because the pipe accepts it either way and reports
success.
