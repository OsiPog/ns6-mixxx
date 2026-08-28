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
crossfader, master and booth.

Effects: both units — on/off, wet/dry, effect select and parameter.

Navigation: scroll, back/forward, prepare, files, crates, view, and LOAD A/B.

**The loop section has two modes**, as on the hardware: MODE switches the four
numbered buttons between Manual (IN, OUT, SELECT, RELOOP) and Autoloop (1, 2, 4
and 8 beats). The MODE button's own light shows which you are in. Note that LOOP
ON/OFF does nothing until a loop exists — that is the hardware's behaviour, not
a gap in the mapping — so make one with IN and OUT, or with a numbered button in
Autoloop mode, first. Autoloop needs the track to have a beatgrid.

**SHIFT** is the DELETE CUE / SHIFT button, as on the panel. Held, it turns hot
cues into hot cue *deletes* (the NS6 cannot overwrite a cue point without
clearing it first), REVERSE into BLEEP, and the loop buttons into loop rolls or
stored-loop jumps.

Deck switching needs nothing from Mixxx: the LAYER buttons make a deck side
transmit on a different MIDI channel, and all four channels are mapped.

## Things you may want to change

At the top of `Numark-NS6-scripts.js`:

- `scratchSensitivity` — how much audio the platter covers per turn while
  scratching, in turns of a 33 1/3 record. Raise it to scratch faster.
- `bendPerRevolution` — how hard the platter bends pitch when SCRATCH is off.
  Mixxx scales the jog control down a long way, so this number is large.
- `beatsPerRevolution` — how far the platter jumps while SKIP is held.
- `fxParamClicks` — clicks to sweep FX PARAM from nothing to full.
- `ticksPerRevolution` — the platter's own resolution, not a feel setting. It
  is assumed to be the full 14-bit range and **has not been checked against a
  counted number of turns**; if it is wrong, everything the platter does is off
  by the same factor. Measure it before reaching for the two settings above.

In `Numark NS6.midi.xml`, the pitch faders carry `<invert/>`. If yours run
backwards, take it out — DJ software disagrees about which end of a pitch fader
is "faster".

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
Mixxx's per-deck controls, and re-points a side's lights when its LAYER button
is pressed.

One caution if you go poking at this yourself: **CC 57 on channel 1 takes the
device off the USB bus** and needs a power cycle. See
[docs/MIDI-MAP.md](docs/MIDI-MAP.md#leds).

## Gaps

A handful of controls were never captured and so are not mapped: the eight
per-channel FX SEND buttons, the FX B select knob's press, the scroll knob's
press, and three unidentified channel-1 CCs. They are listed in
[docs/MIDI-MAP.md](docs/MIDI-MAP.md#not-recorded). Everything else on the panel
is here.
