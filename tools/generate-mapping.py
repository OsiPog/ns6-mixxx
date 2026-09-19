#!/usr/bin/env python3
"""Generate the Mixxx MIDI mapping for the Numark NS6.

The NS6 is highly regular - four identical deck channels and four identical
mixer strips - so writing the XML by hand would be several hundred nearly
identical elements. This emits it from the tables below, which are transcribed
from docs/recorded-surface.toml, the raw recording of the hardware.
"""
import io
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Numark NS6.midi.xml")

# --- Deck channels. MIDI channel N carries Mixxx deck N.
DECKS = [1, 2, 3, 4]

# note -> (key, options) on the deck's own MIDI channel.
DECK_BUTTONS = {
    0x0F: ("beatsync", ["Button"]),
    0x10: ("cue_default", ["Button"]),
    0x11: ("play", ["Button"]),
    0x18: ("rate_temp_down", ["Button"]),
    0x19: ("rate_temp_up", ["Button"]),
    0x1E: ("bpm_tap", ["Button"]),
    0x1F: ("beats_translate_curpos", ["Button"]),
}

# Buttons that go to script: their behaviour depends on shift or on a mode, or
# they latch. A latching control cannot use <Button>, which sets 1 on press and
# 0 on release - a full press then nets to no change, and the button appears to
# need pressing twice.
#
# Every one of these is emitted twice, on 0x9N and on 0x8N, because the release
# arrives as a real note-off. See the comment at the emit loop below.
DECK_SCRIPT_BUTTONS = {
    0x12: "shift",           # DELETE CUE / SHIFT; double-clicked, moves the
                             # hot cue bank between cues 1-5 and 6-10
    0x1B: "keylock",         # latching: toggled on press only
    0x24: "loopToggle",      # latching
    0x13: "hotcue1",
    0x14: "hotcue2",
    0x15: "hotcue3",
    0x16: "hotcue4",
    0x17: "hotcue5",
    0x1A: "pitchRange",      # PITCH RANGE cycles 8/16/50%
    0x1C: "reverse",         # REVERSE, shift = BLEEP (censor)
    0x1D: "skip",            # held: platter jumps by beat
    0x20: "beatgridAdjust",
    0x21: "scratchMode",     # toggles platter scratch vs pitch bend
    0x22: "loopHalve",       # LOOP 1/2 X, shift = smaller seek distance
    0x23: "loopDouble",      # LOOP 2 X,   shift = larger seek distance
    0x25: "loopShiftLeft",   # LOOP SHIFT, shift = seek back
    0x26: "loopShiftRight",  # LOOP SHIFT, shift = seek forward
    0x27: "loopMode",        # manual <-> autoloop
    0x28: "loopButton1",     # IN  / 1 beat
    0x29: "loopButton2",     # OUT / 2 beats
    0x2A: "loopButton3",     # SELECT / 4 beats
    0x2B: "loopButton4",     # RELOOP / 8 beats
}

# --- Mixer strip: (MIDI channel index, msb CC, group, key)
# The LSB of every 14-bit control rides 32 above its MSB.
STRIPS = {  # mixer channel -> (fader, bass, mid, treble, gain, pfl note)
    1: (0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x31),
    2: (0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x32),
    3: (0x13, 0x14, 0x15, 0x16, 0x17, 0x33),
    4: (0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x34),
}

FX_UNITS = {  # FX unit -> (on/off note, mix msb CC, select CC, select press note, param CC)
    1: (0x2D, 0x57, 0x5A, 0x2E, 0x56),
    2: (0x2F, 0x59, 0x5B, 0x30, 0x58),
}

# FX SEND per mixer channel, notes 0x3D..0x44: channel 1 A, channel 1 B, channel
# 2 A, and so on. Derived from the note in NS6.fxSend rather than listed one by
# one, so this is the first of them.
FX_SEND_FIRST = 0x3D

# CROSSFADER ASSIGN, one three-position switch per mixer channel. It reports two
# notes and not three: L and R each latch on and off, and the middle position is
# both of them off. So neither note alone says where the switch is, and the
# release carries as much as the press - see NS6.assignLeft.
XFADER_ASSIGN = {  # mixer channel -> (L note, R note)
    1: (0x35, 0x36),
    2: (0x37, 0x38),
    3: (0x39, 0x3A),
    4: (0x3B, 0x3C),
}


# Panel-wide LEDs, channel 1. Recorded from the hardware. Driven from script, so
# this table is here only for reference; the authoritative copy is in
# Numark-NS6-scripts.js - NS6.navLeds for the three navigation lamps, NS6.fxLeds
# and NS6.fxSendLed for the effects, NS6.sides for the layer indicators.
#
# The effects lights were <output> entries until they were moved; see the note
# above the empty <outputs> section for why.
GLOBAL_LEDS = {
    "crates": 0x03,
    "prepare": 0x04,
    "files": 0x05,
    "fx1": 0x17,       # FX A on/off, following the effect in slot 1
    "fx2": 0x2E,       # FX B on/off
    "layer_a": 0x11,   # lit when the left deck is on layer 3
    "layer_b": 0x28,   # lit when the right deck is on layer 4
    "send_a": 0x44,    # channel 1 FX A; then B, then channel 2 A/B, ...
    "master_a": 0x4C,
    "master_b": 0x4D,
    # 0x50, 0x51 and 0x52 also reach the layer lamps; see docs/MIDI-MAP.md.
    # Unused, because 0x11 and 0x28 cover every state.
}

# The layer indicators are not on/off lights. Each is a pair of lamps - the
# side's two deck numbers - selected by the CC's *value*: 1 for the base deck,
# 2 (or anything above) for the alternate, 0 for both dark. Sending the usual
# 0x7F picks the alternate whichever deck is showing. Driven from script, in
# NS6.sendLayerLed; see docs/MIDI-MAP.md.
LAYER_LED_VALUES = {"base": 1, "alternate": 2, "dark": 0}

# Displays whose value is a position or a fill rather than on-ness. 0x7F is off
# the end of every one of them and shows nothing, which is why a sweep at 0x7F
# never found them. Driven from script; see NS6.displays and docs/MIDI-MAP.md.
DISPLAYS = {
    "fx1_param": 0x13,     # FX A PARAM ring, position 1..11, any channel
    "fx2_param": 0x2A,     # FX B PARAM ring, position 1..11, any channel
    "serato_bar": 0x36,    # position 1..11, any channel - not driven, no use for it
    "strip_search": 0x4E,  # fill 1..15, on the deck side's channel
    # The platter rings are one number for both decks, packing colour, deck and
    # fill into the value: colour * 64 + deck * 32 + fill, fill 1..21. Channel 2
    # only - unlike every other per-deck light. Not driven yet.
    "platter_rings": 0x3A,
}

# Per-deck LEDs, sent on the deck side's channel: 2 for the left deck, 3 for
# the right. Driven from script, so this table is here only for reference; the
# authoritative copy is in Numark-NS6-scripts.js.
#
# The five hot cue lamps are the numbers of the *buttons*, not of any fixed cue.
# Which cue each one follows depends on the deck's bank - see NS6.hotcueLeds,
# which is why they are not in NS6.deckLeds with the rest.
DECK_LEDS = {
    "sync_enabled": 0x07,
    "cue_indicator": 0x08,
    "play_indicator": 0x09,
    "shift": 0x0A,
    "hotcue_1": 0x0B,
    "hotcue_2": 0x0C,
    "hotcue_3": 0x0D,
    "hotcue_4": 0x0E,
    "hotcue_5": 0x0F,
    "keylock": 0x10,
    "scratch": 0x12,
    "loop_enabled": 0x15,
    "reverse": 0x16,
    "loop_mode": 0x18,
    "loop_in": 0x19,
    "loop_out": 0x1A,
    "loop_select": 0x1B,
    "loop_reloop": 0x1C,
    "pitch_zero": 0x37,
    "takeover_up": 0x3C,
    "takeover_down": 0x3D,
}

# Sending these takes the device off the USB bus; it needs a power cycle. Not a
# hazard for this mapping, which sends nothing near them, but worth carrying
# next to the numbers so a hand-edit does not rediscover them.
HAZARD_LEDS = [(1, 0x39), (4, 0x3B)]  # (MIDI channel, CC)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Xml:
    def __init__(self):
        self.buf = io.StringIO()

    def line(self, indent, text):
        self.buf.write("    " * indent + text + "\n")

    def comment(self, indent, text):
        self.line(indent, f"<!-- {esc(text)} -->")

    def control(self, group, key, status, midino, options=None, indent=3):
        self.line(indent, "<control>")
        self.line(indent + 1, f"<group>{group}</group>")
        self.line(indent + 1, f"<key>{esc(key)}</key>")
        self.line(indent + 1, f"<status>0x{status:02X}</status>")
        self.line(indent + 1, f"<midino>0x{midino:02X}</midino>")
        if options:
            self.line(indent + 1, "<options>")
            for o in options:
                self.line(indent + 2, f"<{o}/>")
            self.line(indent + 1, "</options>")
        else:
            self.line(indent + 1, "<options/>")
        self.line(indent, "</control>")

    def wide(self, group, key, ch, msb, extra=None, indent=3):
        """A 14-bit control: MSB at `msb`, LSB 32 above it."""
        self.control(group, key, 0xB0 | ch, msb, ["fourteen-bit-msb"] + (extra or []), indent)
        self.control(group, key, 0xB0 | ch, msb + 32, ["fourteen-bit-lsb"] + (extra or []), indent)

    def output(self, group, key, status, midino, on=0x7F, off=0x00, indent=3):
        self.line(indent, "<output>")
        self.line(indent + 1, f"<group>{group}</group>")
        self.line(indent + 1, f"<key>{esc(key)}</key>")
        self.line(indent + 1, f"<status>0x{status:02X}</status>")
        self.line(indent + 1, f"<midino>0x{midino:02X}</midino>")
        self.line(indent + 1, f"<on>0x{on:02X}</on>")
        self.line(indent + 1, f"<off>0x{off:02X}</off>")
        self.line(indent, "</output>")


x = Xml()
x.line(0, '<?xml version="1.0" encoding="utf-8"?>')
x.line(0, "<MixxxControllerPreset schemaVersion=\"1\" mixxxVersion=\"2.5\">")
x.line(1, "<info>")
x.line(2, "<name>Numark NS6</name>")
x.line(2, "<author>Osi Bluber - recorded from the hardware</author>")
x.line(2, "<description>Numark NS6 (original, USB 15e4:0079), all four decks. "
          "Needs a driver that presents the NS6 as a MIDI device: Numark's own "
          "on Windows and macOS, or ns6 (github.com/OsiPog/ns6-rs) on Linux, "
          "where the NS6 has no class-compliant MIDI interface at all."
          "</description>")
x.line(2, "<forums></forums>")
x.line(1, "</info>")
x.comment(1, "Shown in Mixxx under Preferences -> Controllers -> Numark NS6, so "
             "the platter can be dialled in with the wheel in your hand rather "
             "than by editing the script and restarting.")
x.line(1, "<settings>")
x.line(2, '<group label="Platter">')

x.line(3, '<option variable="scratchSensitivity" type="real" min="0.25" max="8" '
          'step="0.25" default="2" label="Scratch sensitivity">')
x.line(4, "<description>")
x.line(5, "Turns of a 33 1/3 record per turn of the platter, while scratching. "
          "At 1 the platter behaves as a 12-inch turntable; the NS6 wheel is "
          "roughly half that across, so 2 makes a gesture at the rim cover the "
          "audio a turntable would. Raise it to scratch faster.")
x.line(4, "</description>")
x.line(3, "</option>")

x.line(3, '<option variable="bendPerRevolution" type="integer" min="50" '
          'max="4000" default="800" label="Pitch bend per revolution">')
x.line(4, "<description>")
x.line(5, "How hard the platter bends pitch when SCRATCH is off. Mixxx scales "
          "this down hard before it reaches the rate, so the number has to be "
          "large before the bend is felt at all.")
x.line(4, "</description>")
x.line(3, "</option>")

x.line(3, '<option variable="scratchSmoothing" type="real" min="0.05" max="1" '
          'step="0.05" default="1" label="Scratch smoothing">')
x.line(4, "<description>")
x.line(5, "How much of each reported platter position is believed. 1 is no "
          "smoothing at all: the audio moves exactly as the wheel does and "
          "stops dead when your hand does. Lower it only if the platter's own "
          "resolution makes slow moves sound stepped.")
x.line(4, "</description>")
x.line(3, "</option>")

x.line(3, '<option variable="ticksPerRevolution" type="integer" min="64" '
          'max="16384" default="16384" label="Platter ticks per revolution">')
x.line(4, "<description>")
x.line(5, "How many steps the platter reports for one full turn. A property of "
          "the hardware rather than a preference, and not yet measured - "
          "`ns6 jog` in the ns6 driver reports it. Everything the platter does "
          "scales with this, so scratch sensitivity above is the better knob "
          "for feel.")
x.line(4, "</description>")
x.line(3, "</option>")

x.line(2, "</group>")
x.line(1, "</settings>")
x.line(1, '<controller id="Numark NS6">')
x.line(2, "<scriptfiles>")
x.line(3, '<file filename="Numark-NS6-scripts.js" functionprefix="NS6"/>')
x.line(2, "</scriptfiles>")
x.line(2, "<controls>")

x.comment(3, "=== Mixer, all on MIDI channel 1 ===")
x.wide("[Master]", "crossfader", 0, 0x07)
for ch, (fader, bass, mid, treble, gain, pfl) in STRIPS.items():
    x.comment(3, f"mixer channel {ch}")
    x.wide(f"[Channel{ch}]", "volume", 0, fader)
    x.wide(f"[EqualizerRack1_[Channel{ch}]_Effect1]", "parameter1", 0, bass)
    x.wide(f"[EqualizerRack1_[Channel{ch}]_Effect1]", "parameter2", 0, mid)
    x.wide(f"[EqualizerRack1_[Channel{ch}]_Effect1]", "parameter3", 0, treble)
    x.wide(f"[Channel{ch}]", "pregain", 0, gain)
    # PFL latches in hardware and reports both edges, so the note-off matters
    # as much as the note-on - it is what turns cueing back off. Mixxx matches
    # on the status byte, and a release arrives as 0x80, so it needs its own
    # entry; with only 0x90 declared the release is silently dropped and cueing
    # can be switched on but never off.
    x.control(f"[Channel{ch}]", "NS6.pfl", 0x90, pfl, ["script-binding"])
    x.control(f"[Channel{ch}]", "NS6.pfl", 0x80, pfl, ["script-binding"])

x.comment(3, "master and booth. 7-bit absolute knobs, not encoders.")
x.control("[Master]", "gain", 0xB0, 0x43)
x.control("[Master]", "booth_gain", 0xB0, 0x41)

x.comment(3, "=== Headphones, MIDI channel 1 ===")
x.control("[Master]", "headGain", 0xB0, 0x42)
x.comment(3, "CUE BLEND is 14-bit, like the mixer's knobs: LSB 32 above the MSB.")
x.wide("[Master]", "headMix", 0, 0x12)
x.comment(3, "SPLIT CUE latches, so it is followed rather than toggled.")
x.control("[Master]", "NS6.splitCue", 0x90, 0x00, ["script-binding"])
x.control("[Master]", "NS6.splitCue", 0x80, 0x00, ["script-binding"])

x.comment(3, "The crossfader contour knob. Mixxx keeps the curve in a preference "
             "rather than per deck, so this writes that.")
x.control("[Mixer Profile]", "xFaderCurve", 0xB0, 0x55)

x.comment(3, "CROSSFADER ASSIGN. Two notes per channel for three positions, and "
             "the middle one is both notes off, so both edges are declared.")
for ch, (left, right) in XFADER_ASSIGN.items():
    for note, fn in ((left, "assignLeft"), (right, "assignRight")):
        x.control(f"[Channel{ch}]", f"NS6.{fn}", 0x90, note, ["script-binding"])
        x.control(f"[Channel{ch}]", f"NS6.{fn}", 0x80, note, ["script-binding"])

x.comment(3, "=== Navigation, MIDI channel 1 ===")
x.comment(3, "SCROLL KNOB is a relative encoder: 1 = clockwise, 127 = anticlockwise.")
x.control("[Library]", "MoveVertical", 0xB0, 0x44, ["selectknob"])
x.control("[Library]", "MoveFocusBackward", 0x90, 0x06, ["Button"])
x.control("[Library]", "MoveFocusForward", 0x90, 0x07, ["Button"])
x.control("[Skin]", "show_maximized_library", 0x90, 0x01, ["Button"])
x.comment(3, "CRATES / PREPARE / FILES have no direct Mixxx equivalent; they move "
             "focus in the library, which is the nearest thing.")
x.control("[Library]", "MoveFocusBackward", 0x90, 0x0B, ["Button"])
x.control("[Library]", "MoveFocusForward", 0x90, 0x09, ["Button"])
x.control("[Library]", "GoToItem", 0x90, 0x0A, ["Button"])
x.control("[Library]", "AutoDjAddBottom", 0x90, 0x0D, ["Button"])
x.comment(3, "The SCROLL knob's press.")
x.control("[Library]", "GoToItem", 0x90, 0x08, ["Button"])

x.comment(3, "=== Effects, MIDI channel 1 ===")
# FX SELECT and FX PARAM are relative encoders, but they cannot use <selectknob/>:
# that option is an accumulator, and neither control wants one. See NS6.fxSelect.
for unit, (onoff, mix, sel, sel_press, param) in FX_UNITS.items():
    x.comment(3, f"FX {chr(64 + unit)} maps to EffectUnit{unit}")
    # FX ON/OFF drives the effect in slot 1, not the unit. The unit group has no
    # "enabled" control in Mixxx 2.5 - the effects rework left the unit with
    # routing (group_[ChannelN]_enable) and mix, and moved on/off down to the
    # slot. Writing the old name is silently ignored, which is what made this
    # button dead: every press read 0, wrote 1, and changed nothing.
    x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "NS6.toggleEnabled", 0x90, onoff, ["script-binding"])
    x.wide(f"[EffectRack1_EffectUnit{unit}]", "mix", 0, mix)
    x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "NS6.fxSelect", 0xB0, sel, ["script-binding"])
    x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "NS6.fxParam", 0xB0, param, ["script-binding"])
    if sel_press is not None:
        x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "NS6.toggleEnabled", 0x90, sel_press, ["script-binding"])
x.comment(3, "LAYER. The controller switches channels by itself; script only has to "
             "refresh the LEDs, which would otherwise show the outgoing deck until "
             "something on the new one happened to change.")
x.control("[Master]", "NS6.layer", 0x90, 0x04, ["script-binding"])
x.control("[Master]", "NS6.layer", 0x90, 0x05, ["script-binding"])

x.comment(3, "FX SEND to the master mix, below the MASTER VOLUME knob.")
x.control("[EffectRack1_EffectUnit1]", "NS6.masterSendA", 0x90, 0x45, ["script-binding"])
x.control("[EffectRack1_EffectUnit2]", "NS6.masterSendB", 0x90, 0x46, ["script-binding"])

x.comment(3, "FX SEND per mixer channel: A then B, channel 1 through 4. Which "
             "unit and which channel come from the note, in NS6.fxSend.")
for i in range(8):
    x.control("[Master]", "NS6.fxSend", 0x90, FX_SEND_FIRST + i, ["script-binding"])

for d in DECKS:
    ch = d  # deck N is MIDI channel N (0-indexed), i.e. status 0x9N / 0xBN
    g = f"[Channel{d}]"
    x.comment(3, f"=== Deck {d} - MIDI channel {ch + 1} ===")
    x.comment(3, "PLATTER: 14-bit absolute position that wraps, so the delta has to "
                 "be computed in script.")
    x.control(g, "NS6.platterMsb", 0xB0 | ch, 0x00, ["script-binding"])
    x.control(g, "NS6.platterLsb", 0xB0 | ch, 0x20, ["script-binding"])
    x.comment(3, "PITCH FADER: 14-bit absolute. Through script rather than bound "
                 "straight to `rate`, because the two arrows beside it show the "
                 "gap between the fader and the deck's rate, and only script "
                 "gets told where the fader is. Mixxx still does the takeover; "
                 "see NS6.init. Inversion moved with it, into NS6.rateFromFader.")
    x.control(g, "NS6.pitchMsb", 0xB0 | ch, 0x01, ["script-binding"])
    x.control(g, "NS6.pitchLsb", 0xB0 | ch, 0x21, ["script-binding"])
    x.comment(3, "STRIP SEARCH: absolute position along the track.")
    x.control(g, "NS6.stripSearch", 0xB0 | ch, 0x02, ["script-binding"])
    for note, (key, opts) in sorted(DECK_BUTTONS.items()):
        x.control(g, key, 0x90 | ch, note, opts)
    x.comment(3, "Both edges of every one of these. The hardware sends a real "
                 "note-off on release - captured on the wire, 0x81 note 18 "
                 "follows 0x91 note 18 when DELETE CUE / SHIFT is let go - and "
                 "Mixxx matches on the status byte, so declaring only 0x9N "
                 "takes the presses and silently drops the releases. On a "
                 "button that means something only while held that is fatal: "
                 "SHIFT never sees its release and the shift layer latches on "
                 "for good, which turns every hot cue press into a delete. The "
                 "handlers that do not want the release already return on "
                 "value 0, so this is safe for all of them.")
    for note, fn in sorted(DECK_SCRIPT_BUTTONS.items()):
        x.control(g, f"NS6.{fn}", 0x90 | ch, note, ["script-binding"])
        x.control(g, f"NS6.{fn}", 0x80 | ch, note, ["script-binding"])
    x.comment(3, "LOAD A / LOAD B address a deck and are sent on that deck's channel.")
    x.control(g, "LoadSelectedTrack", 0x90 | ch, 0x0C, ["Button"])
    x.control(g, "LoadSelectedTrack", 0x90 | ch, 0x0E, ["Button"])
    x.comment(3, "FADER START and the per-channel line/mic switches are recorded "
                 "but not mapped: Mixxx has no equivalent of either. See "
                 "docs/MIDI-MAP.md.")

x.line(2, "</controls>")

x.line(2, "<outputs>")
x.comment(3, "Empty, and deliberately so. Every light on this unit is driven "
             "from script - see NS6.connectSide and NS6.connectGlobal.")
x.comment(3, "The per-deck ones have to be: they are addressed by physical deck "
             "side - channel 2 is the left deck whichever layer it is on - and "
             "Mixxx controls are per deck, so something has to route between "
             "them.")
x.comment(3, "The effect lights were <output> entries until they turned out to "
             "need the same treatment for a different reason. Mixxx pushes an "
             "output's first value before it has finished opening the MIDI "
             "output, so all twelve went into a closed port and the panel came "
             "up blank however the effects were set; and on the way out Mixxx "
             "stops driving an output without clearing it, so whichever were "
             "lit stayed lit past shutdown. Script gets the deferred first draw "
             "and the blanking that fixes both.")
x.line(2, "</outputs>")

x.line(1, "</controller>")
x.line(0, "</MixxxControllerPreset>")

import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    f.write(x.buf.getvalue())
print(f"wrote {OUT}: {x.buf.getvalue().count(chr(10))} lines")
