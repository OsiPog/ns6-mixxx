# Numark NS6 mapping for Mixxx

A Mixxx controller mapping for the **original Numark NS6**, covering all four
decks, the mixer, the effects section and the platters.

Numark shipped the NS6 for Serato ITCH and never published its MIDI
implementation. This mapping was built by recording the hardware control by
control; the resulting reference is in [docs/MIDI-MAP.md](docs/MIDI-MAP.md) and
is useful on its own, whatever software you point the NS6 at.

> For the **original NS6**, USB `15e4:0079`. The NS6II is a different, fully
> class-compliant device and Mixxx already ships a mapping for it.

## Install

Copy both files into your Mixxx user controller directory, then pick **Numark
NS6** in Preferences → Controllers.

| OS | Directory |
|---|---|
| Linux | `~/.mixxx/controllers/` |
| macOS | `~/Library/Application Support/Mixxx/controllers/` |
| Windows | `%USERPROFILE%\AppData\Local\Mixxx\controllers\` |

```sh
cp "Numark NS6.midi.xml" Numark-NS6-scripts.js ~/.mixxx/controllers/
```

Built against Mixxx 2.5.

## Getting the NS6 to appear as a MIDI device

The NS6 is not class-compliant — it will not show up until something is
driving it.

- **Windows, macOS:** install Numark's own NS6 driver. The controller then
  appears as an ordinary MIDI device.
- **Linux:** the vendor driver does not exist, and the NS6 presents only
  vendor-specific USB interfaces, so the kernel ignores it entirely. Use
  [ns6](https://github.com/OsiPog/ns6-rs), a userspace driver that speaks the
  device's protocol and publishes it as an ALSA MIDI port.

## What is mapped

Per deck: platter (scratch and pitch bend), pitch fader with soft takeover,
play, cue, sync, five hot cues, pitch bend and range, key lock, reverse and
bleep, skip, tap, beat grid, strip search, and the full loop section in both
Manual and Autoloop modes.

Mixer: four channel faders, four three-band EQs, four gains, four PFL buttons,
crossfader and its assign switches, master, booth, headphone volume, cue blend,
split cue and the crossfader contour knob.

Effects: both units — on/off, wet/dry, effect select and parameter, both select
presses, and FX SEND for all four strips as well as the master.

Navigation: scroll and its press, back/forward, prepare, files, crates, view, and
LOAD A/B.

**The loop section has two modes**, as on the hardware: MODE switches the four
numbered buttons between Manual (IN, OUT, SELECT, RELOOP) and Autoloop (1, 2, 4
and 8 beats). The MODE button's own light shows which you are in. Note that LOOP
ON/OFF does nothing until a loop exists — that is the hardware's behaviour, not
a gap in the mapping — so make one with IN and OUT, or with a numbered button in
Autoloop mode, first. Autoloop needs the track to have a beatgrid.

**SHIFT** is the DELETE CUE / SHIFT button, as on the panel, and it is per deck —
each deck side has its own, on its own MIDI channel. Held, it changes:

| Button | Plain | With SHIFT |
|---|---|---|
| HOT CUE 1–5 | jump to the cue | **delete** it — the NS6 cannot overwrite a cue without clearing it first |
| BLEEP / REVERSE | reverse, and playback continues from where it stops | **bleep**: the track runs on underneath and resumes where it would have been |
| LOOP 1–4 | beatloop, or IN / OUT / SELECT / RELOOP | loop rolls in Manual mode, stored-loop jumps in Autoloop |
| LOOP SHIFT ← → | move the loop | **seek** the track back and forward |
| LOOP 2 X, LOOP ½ X | double or halve the loop | double or halve the **seek distance** |
| BEAT GRID ADJUST | snap the nearest marker to the playhead | align the grid to the other deck |

The seek distance is Mixxx's own `beatjump_size`, not a number this mapping keeps
to itself, so it is the same size Mixxx shows in its skin and uses for beatjump
elsewhere — the panel and the screen cannot disagree about it, and it survives a
mapping reload. It runs from 1/32 of a beat to 64 beats. Seeking is in beats, so
like Autoloop it needs the track to have a beatgrid.

Every other deck button ignores SHIFT rather than doing something invented for it.

Deck switching needs nothing from Mixxx: the LAYER buttons make a deck side
transmit on a different MIDI channel, and all four channels are mapped.

## Things you may want to change

In **Preferences → Controllers → Numark NS6**, so the platter can be dialled in
with the wheel in your hand:

- **Scratch sensitivity** (`scratchSensitivity`) — how much audio the platter
  covers per turn while scratching, in turns of a 33 1/3 record. Raise it to
  scratch faster.
- **Pitch bend per revolution** (`bendPerRevolution`) — how hard the platter
  bends pitch when SCRATCH is off. Mixxx scales the jog control down a long way,
  so this number is large.
- **Scratch smoothing** (`scratchAlpha`) — how much of each reported platter
  position is believed. 1 is none: the audio moves exactly as the wheel does and
  stops dead when your hand does. Lower it only if the platter's own resolution
  makes slow moves sound stepped.
- **Platter ticks per revolution** (`ticksPerRevolution`) — the platter's own
  resolution, not a feel setting. It is assumed to be the full 14-bit range and
  **has not been checked against a counted number of turns**; if it is wrong,
  everything the platter does is off by the same factor. `ns6 jog` in the
  [driver](https://github.com/OsiPog/ns6-rs) measures it. Do that before
  reaching for the two settings above.

Still constants at the top of `Numark-NS6-scripts.js`:

- `beatsPerRevolution` — how far the platter jumps while SKIP is held.
- `fxParamClicks` — clicks to sweep FX PARAM from nothing to full.
- `scratchBeta` — deliberately zero. It is how much velocity the scratch filter
  carries between platter reports, which is exactly what makes a stopped wheel
  keep coasting.

The pitch faders are inverted, in `NS6.rateFromFader` in the script. If yours
run backwards, drop the minus sign there — DJ software disagrees about which end
of a pitch fader is "faster". (This used to be `<invert/>` in the XML; the fader
moved into script so that the takeover arrows beside it could be lit, which
needs the fader's position and not just the deck's rate.)

## Regenerating the XML

The four decks and four mixer strips are identical, so the XML is generated
rather than hand-written:

```sh
python3 tools/generate-mapping.py
```

Edit the tables at the top of that script, not the XML.

## LEDs

Recorded from the hardware, not assumed. They turned out to be Control Change
rather than note on, with numbers unrelated to the input notes, and addressed by
physical deck side rather than by deck — so the left deck's lights are on
channel 2 whichever layer it is showing. The mapping routes between that and
Mixxx's per-deck controls.

Which deck a side is showing is **observed rather than tracked**. The LAYER
buttons report that they were pressed but not which way, so a mapping that
toggles is wrong from the moment Mixxx starts against hardware already switched
over, and stays wrong. But a deck side transmits on the channel of the deck it is
showing, and the platters report continuously whether or not anyone is touching
them, so the traffic says which deck it is, over and over. See `NS6.observeDeck`.

The layer indicators themselves are the one place the LED **value** matters: each
is a pair of lamps, the side's two deck numbers, and the value picks between them
(1 base, 2 alternate, 0 both dark). The usual 0x7F is wrong — it selects the
alternate deck whichever one is showing. See
[docs/MIDI-MAP.md](docs/MIDI-MAP.md#the-layer-indicators-and-why-127-is-the-wrong-value).

Every recorded light is driven. Besides the obvious ones, that means the
pitch fader's centre detent and its two soft-takeover arrows, the four LOOP
CONTROL buttons — which follow whichever mode the section is in, so in Autoloop
they show the length of the loop you have — and the SHIFT button while it is
held. CRATES, PREPARE and FILES have no state to show and are simply lit;
`NS6.litNavButtons` turns that off.

Some of the panel is not lamps at all but **displays**, whose value is a position
or a fill. The two **FX PARAM rings** follow their unit's parameter across eleven
positions, and each deck's **STRIP SEARCH bar** fills to the play position across
fifteen LEDs — a loaded track at its start shows one LED, because a dark bar
already means "no track". Position updates are only sent when the number on the
display actually changes, which turns a few hundred playposition callbacks a
minute into a handful of messages.

Two displays are found and documented but deliberately not driven: the **Serato
bar**, which has no natural Mixxx equivalent, and the **platter rings**, which
also carry a colour and want a decision about what red should mean. Both are in
[docs/MIDI-MAP.md](docs/MIDI-MAP.md#the-position-displays) if you want them.

One caution if you go poking at this yourself: **CC 57 on channel 1 and CC 59 on
channel 4 take the device off the USB bus** and need a power cycle. See
[docs/MIDI-MAP.md](docs/MIDI-MAP.md#leds).

## Gaps

The **PFL / headphone-cue buttons light themselves**. They latch in hardware and
no message reaches their LEDs — every control change and every note, on all five
channels, was tried. So the mapping follows the button instead of driving it,
and the light is always right by construction.


Every control on the panel is recorded, and everything Mixxx has an equivalent
for is mapped. Two things are recorded and deliberately not bound, because Mixxx
has nothing to bind them to: **FADER START**, and the per-strip **LINE / MIC**
switches. Both are in [docs/MIDI-MAP.md](docs/MIDI-MAP.md) if a use turns up.

The **crossfader assign** switches are worth a note. Each reports two notes for
three positions — L and R latch on and off, and the middle position is both of
them off — so the mapping tracks the pair and declares both edges. Declaring only
note-on would see a switch leave centre and never come back.

One deliberate blank: **LOOP SELECT stays dark in Manual mode.** It is mapped to
`loop_exit` here and has no state of its own to show. If the hardware's own
behaviour was to light it for something, that is not reproduced.
