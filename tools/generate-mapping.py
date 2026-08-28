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
    0x1B: ("keylock", ["Button"]),
    0x1E: ("bpm_tap", ["Button"]),
    0x1F: ("beats_translate_curpos", ["Button"]),
    0x22: ("loop_halve", ["Button"]),
    0x23: ("loop_double", ["Button"]),
    0x24: ("reloop_toggle", ["Button"]),
    0x25: ("loop_move_1_backward", ["Button"]),
    0x26: ("loop_move_1_forward", ["Button"]),
}

# Buttons whose behaviour depends on shift or on a mode, so they go to script.
DECK_SCRIPT_BUTTONS = {
    0x12: "shift",           # DELETE CUE / SHIFT
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
    2: (0x2F, 0x59, 0x5B, None, 0x58),
}


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
    x.control(f"[Channel{ch}]", "pfl", 0x90, pfl, ["Button"])

x.comment(3, "master and booth. 7-bit absolute knobs, not encoders.")
x.control("[Master]", "gain", 0xB0, 0x43)
x.control("[Master]", "booth_gain", 0xB0, 0x41)

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
x.control("[AutoDJ]", "add_bottom", 0x90, 0x0D, ["Button"])

x.comment(3, "=== Effects, MIDI channel 1 ===")
for unit, (onoff, mix, sel, sel_press, param) in FX_UNITS.items():
    x.comment(3, f"FX {chr(64 + unit)} maps to EffectUnit{unit}")
    x.control(f"[EffectRack1_EffectUnit{unit}]", "enabled", 0x90, onoff, ["Button"])
    x.wide(f"[EffectRack1_EffectUnit{unit}]", "mix", 0, mix)
    x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "effect_selector", 0xB0, sel, ["selectknob"])
    x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "meta", 0xB0, param, ["selectknob"])
    if sel_press is not None:
        x.control(f"[EffectRack1_EffectUnit{unit}_Effect1]", "enabled", 0x90, sel_press, ["Button"])
x.comment(3, "FX SEND to the master mix, below the MASTER VOLUME knob.")
x.control("[EffectRack1_EffectUnit1]", "group_[Master]_enable", 0x90, 0x45, ["Button"])
x.control("[EffectRack1_EffectUnit2]", "group_[Master]_enable", 0x90, 0x46, ["Button"])

for d in DECKS:
    ch = d  # deck N is MIDI channel N (0-indexed), i.e. status 0x9N / 0xBN
    g = f"[Channel{d}]"
    x.comment(3, f"=== Deck {d} - MIDI channel {ch + 1} ===")
    x.comment(3, "PLATTER: 14-bit absolute position that wraps, so the delta has to "
                 "be computed in script.")
    x.control(g, "NS6.platterMsb", 0xB0 | ch, 0x00, ["script-binding"])
    x.control(g, "NS6.platterLsb", 0xB0 | ch, 0x20, ["script-binding"])
    x.comment(3, "PITCH FADER. If it feels backwards, swap <invert/> in or out here.")
    x.wide(g, "rate", ch, 0x01, ["soft-takeover", "invert"])
    x.comment(3, "STRIP SEARCH: absolute position along the track.")
    x.control(g, "NS6.stripSearch", 0xB0 | ch, 0x02, ["script-binding"])
    for note, (key, opts) in sorted(DECK_BUTTONS.items()):
        x.control(g, key, 0x90 | ch, note, opts)
    for note, fn in sorted(DECK_SCRIPT_BUTTONS.items()):
        x.control(g, f"NS6.{fn}", 0x90 | ch, note, ["script-binding"])
    x.comment(3, "LOAD A / LOAD B address a deck and are sent on that deck's channel.")
    x.control(g, "LoadSelectedTrack", 0x90 | ch, 0x0C, ["Button"])
    x.control(g, "LoadSelectedTrack", 0x90 | ch, 0x0E, ["Button"])
    x.comment(3, "The per-channel FX SEND buttons are not mapped: their note "
                 "numbers were never captured. Only the two master FX SEND "
                 "buttons, and the scroll knob's press, are missing from this "
                 "mapping for the same reason.")

x.line(2, "</controls>")

x.line(2, "<outputs>")
x.comment(3, "LEDs. The controller lights a button when it is sent the same note it "
             "sends, so the output map mirrors the input map.")
for ch, (_, _, _, _, _, pfl) in STRIPS.items():
    x.output(f"[Channel{ch}]", "pfl", 0x90, pfl)
for unit, (onoff, _, _, _, _) in FX_UNITS.items():
    x.output(f"[EffectRack1_EffectUnit{unit}]", "enabled", 0x90, onoff)
for d in DECKS:
    ch = d
    g = f"[Channel{d}]"
    x.output(g, "play_indicator", 0x90 | ch, 0x11)
    x.output(g, "cue_indicator", 0x90 | ch, 0x10)
    x.output(g, "sync_enabled", 0x90 | ch, 0x0F)
    x.output(g, "keylock", 0x90 | ch, 0x1B)
    x.output(g, "loop_enabled", 0x90 | ch, 0x24)
    for i in range(1, 6):
        x.output(g, f"hotcue_{i}_status", 0x90 | ch, 0x12 + i)
x.line(2, "</outputs>")

x.line(1, "</controller>")
x.line(0, "</MixxxControllerPreset>")

import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    f.write(x.buf.getvalue())
print(f"wrote {OUT}: {x.buf.getvalue().count(chr(10))} lines")
