// Numark NS6 controller mapping for Mixxx.
//
// Companion to "Numark NS6.midi.xml". Everything that is a plain one-to-one
// binding lives in the XML; this file holds the controls whose behaviour
// depends on state - the platters, the SHIFT layer, and the LOOP CONTROL
// buttons, which mean different things in Manual and Autoloop mode.
//
// The NS6 has no class-compliant MIDI interface. It only appears as an ALSA
// MIDI port because the `ns6` userspace driver puts it there; see
// https://github.com/OsiPog/ns6-rs
//
// Channel layout, established by recording the hardware:
//   MIDI channel 1  mixer, FX, navigation
//   MIDI channel 2  deck 1        (left platter, LAYER on 1)
//   MIDI channel 3  deck 2        (right platter, LAYER on 2)
//   MIDI channel 4  deck 3        (left platter, LAYER on 3)
//   MIDI channel 5  deck 4        (right platter, LAYER on 4)
// The LAYER buttons are handled entirely in the controller: flipping one makes
// the same physical controls emit on a different MIDI channel, so Mixxx needs
// to do nothing about them.

var NS6 = {};

// --- Tuning ------------------------------------------------------------------

// Ticks the platter reports per full revolution. This is meant to be the
// hardware's number rather than a feel setting: the platter sends a 14-bit
// absolute position that wraps, and the assumption here is that one turn is the
// whole 14-bit range. That has not been confirmed against the wheel with a
// counted number of turns - if it is wrong, everything the platter does is off
// by the same factor, so it is the first thing to check.
NS6.ticksPerRevolution = 16384;

// Turns of a 33 1/3 record per turn of the platter, while scratching. At 1 the
// platter behaves as a 12" turntable; the NS6's wheel is roughly half that
// across, so 1 makes the same gesture at the rim cover half the audio a
// turntable would, which is what "too slow" feels like. 2 matches the rim
// travel instead. Raise it to scratch faster.
NS6.scratchSensitivity = 2;

// Platter RPM the scratch filter assumes, and its response curve. 33 1/3 is the
// usual choice and matches what the platter is silk-screened for.
NS6.scratchRpm = 33 + 1 / 3;
NS6.scratchAlpha = 1.0 / 8;
NS6.scratchBeta = (1.0 / 8) / 32;

// Jog units sent per full revolution when the platter is bending pitch rather
// than scratching. Mixxx scales this down hard before it reaches the rate - it
// multiplies by 0.1 and then averages the last 25 readings - so the number has
// to be large before the bend is felt at all. Raise it to bend harder.
NS6.bendPerRevolution = 800;

// PITCH RANGE cycles through these, matching the values the button is labelled
// with on the panel.
NS6.pitchRanges = [0.08, 0.16, 0.50];

// Beats jumped per platter revolution while SKIP is held.
NS6.beatsPerRevolution = 16;

// --- State -------------------------------------------------------------------

// One entry per deck, keyed by Mixxx group.
NS6.decks = {};

NS6.deckState = function (group) {
    if (NS6.decks[group] === undefined) {
        NS6.decks[group] = {
            shift: false,
            // The platter is a motorised turntable: scratching is off until the
            // SCRATCH button turns it on, exactly as the hardware behaves.
            scratching: false,
            skipping: false,
            // Autoloop mode is what the four bottom LOOP CONTROL buttons do by
            // default on this unit.
            autoloop: true,
            platterMsb: 0,
            lastPosition: null,
            pitchRangeIndex: 0,
        };
    }
    return NS6.decks[group];
};

// --- Lifecycle ---------------------------------------------------------------

NS6.init = function () {
    NS6.connectSide("A");
    NS6.connectSide("B");
};

NS6.shutdown = function () {
    for (var group in NS6.decks) {
        if (NS6.decks[group].scratching) {
            engine.scratchDisable(script.deckFromGroup(group));
        }
    }
    // Leave the panel dark rather than frozen on the last state.
    ["A", "B"].forEach(function (name) {
        var side = NS6.sides[name];
        NS6.connections[name].forEach(function (c) {
            c.disconnect();
        });
        Object.keys(NS6.deckLeds).forEach(function (key) {
            NS6.sendLed(side.channel, NS6.deckLeds[key], false);
        });
        Object.keys(NS6.stateLeds).forEach(function (key) {
            NS6.sendLed(side.channel, NS6.stateLeds[key], false);
        });
        NS6.sendLed(side.channel, side.indicator, false);
    });
};

// --- SHIFT -------------------------------------------------------------------

// DELETE CUE / SHIFT. Held, it is the shift layer; the panel legend calls the
// same button DELETE CUE because its primary job is erasing hot cues, which is
// what shift+hotcue does below.
NS6.shift = function (channel, control, value, status, group) {
    NS6.deckState(group).shift = value > 0;
};

// --- Hot cues ----------------------------------------------------------------

NS6.hotcue = function (n, value, group) {
    var state = NS6.deckState(group);
    if (state.shift) {
        // Cue points cannot be overwritten on this unit; the manual is explicit
        // that you erase first. Shift+hotcue is that erase.
        if (value > 0) {
            engine.setValue(group, "hotcue_" + n + "_clear", 1);
        }
        return;
    }
    engine.setValue(group, "hotcue_" + n + "_activate", value > 0 ? 1 : 0);
};

NS6.hotcue1 = function (c, ctl, value, s, group) { NS6.hotcue(1, value, group); };
NS6.hotcue2 = function (c, ctl, value, s, group) { NS6.hotcue(2, value, group); };
NS6.hotcue3 = function (c, ctl, value, s, group) { NS6.hotcue(3, value, group); };
NS6.hotcue4 = function (c, ctl, value, s, group) { NS6.hotcue(4, value, group); };
NS6.hotcue5 = function (c, ctl, value, s, group) { NS6.hotcue(5, value, group); };

// --- Platter -----------------------------------------------------------------

// Ticks a record revolution is worth, which is what engine.scratchEnable wants.
// Fewer ticks per record revolution means the same gesture covers more audio,
// so this is where scratchSensitivity does its work.
NS6.scratchIntervals = function () {
    return NS6.ticksPerRevolution / NS6.scratchSensitivity;
};

// The platter reports absolute position as a 14-bit value that wraps, MSB then
// LSB. Only the LSB completes a reading, so that is where the work happens.
NS6.platterMsb = function (channel, control, value, status, group) {
    NS6.deckState(group).platterMsb = value;
};

NS6.platterLsb = function (channel, control, value, status, group) {
    var state = NS6.deckState(group);
    var position = (state.platterMsb << 7) | value;

    if (state.lastPosition === null) {
        state.lastPosition = position;
        return;
    }

    // Shortest way round the circle, so a wrap past zero is a small step rather
    // than a full-scale jump.
    var delta = position - state.lastPosition;
    var half = NS6.ticksPerRevolution / 2;
    if (delta > half) {
        delta -= NS6.ticksPerRevolution;
    } else if (delta < -half) {
        delta += NS6.ticksPerRevolution;
    }
    state.lastPosition = position;

    if (delta === 0) {
        return;
    }

    var deck = script.deckFromGroup(group);

    if (state.skipping) {
        // SKIP held: the platter jumps by beat instead of moving audio.
        var beats = delta / NS6.ticksPerRevolution * NS6.beatsPerRevolution;
        engine.setValue(group, "beatjump", beats);
        return;
    }

    if (state.scratching) {
        engine.scratchTick(deck, delta);
        return;
    }

    // Not scratching: the platter bends pitch, which is what the manual says it
    // does when SCRATCH is off.
    engine.setValue(group, "jog", delta / NS6.ticksPerRevolution * NS6.bendPerRevolution);
};

// SCRATCH turns Scratch Mode on and off. The button lights while it is on.
NS6.scratchMode = function (channel, control, value, status, group) {
    if (value === 0) {
        return;
    }
    var state = NS6.deckState(group);
    var deck = script.deckFromGroup(group);
    state.scratching = !state.scratching;
    if (state.scratching) {
        engine.scratchEnable(deck, NS6.scratchIntervals(), NS6.scratchRpm,
                             NS6.scratchAlpha, NS6.scratchBeta);
    } else {
        engine.scratchDisable(deck);
    }
    NS6.sendLed(NS6.sideOf(deck).channel, NS6.stateLeds.scratch, state.scratching);
};

// SKIP is a hold, not a toggle: while it is down the platter jumps by beat and
// scratching is suspended, which is what the hardware does.
NS6.skip = function (channel, control, value, status, group) {
    var state = NS6.deckState(group);
    state.skipping = value > 0;
    if (state.scratching) {
        var deck = script.deckFromGroup(group);
        if (state.skipping) {
            engine.scratchDisable(deck);
        } else {
            engine.scratchEnable(deck, NS6.scratchIntervals(), NS6.scratchRpm,
                                 NS6.scratchAlpha, NS6.scratchBeta);
        }
    }
};

// --- STRIP SEARCH ------------------------------------------------------------

// A touch strip whose length is the length of the track. Absolute, 7-bit.
NS6.stripSearch = function (channel, control, value, status, group) {
    if (engine.getValue(group, "track_loaded") !== 1) {
        return;
    }
    engine.setValue(group, "playposition", value / 127);
};

// --- Pitch -------------------------------------------------------------------

// PITCH RANGE steps through +/-8%, 16% and 50%, as labelled.
NS6.pitchRange = function (channel, control, value, status, group) {
    if (value === 0) {
        return;
    }
    var state = NS6.deckState(group);
    state.pitchRangeIndex = (state.pitchRangeIndex + 1) % NS6.pitchRanges.length;
    engine.setValue(group, "rateRange", NS6.pitchRanges[state.pitchRangeIndex]);
};

// --- Reverse / bleep ---------------------------------------------------------

// BLEEP / REVERSE. Plain, it reverses and playback continues from wherever it
// stops. With SHIFT it is BLEEP: the track carries on underneath and resumes
// where it would have been, which is Mixxx's reverse_roll.
NS6.reverse = function (channel, control, value, status, group) {
    var key = NS6.deckState(group).shift ? "reverse_roll" : "reverse";
    engine.setValue(group, key, value > 0 ? 1 : 0);
};

// --- Beat grid ---------------------------------------------------------------

// ADJUST / SLIP shifts the whole grid. Mixxx has no direct equivalent of
// dragging the grid with the platter, so this snaps the nearest marker to the
// playhead, which is the useful half of what the button does.
NS6.beatgridAdjust = function (channel, control, value, status, group) {
    if (value === 0) {
        return;
    }
    var key = NS6.deckState(group).shift
        ? "beats_translate_match_alignment"
        : "beats_translate_curpos";
    engine.setValue(group, key, 1);
};

// --- Loops -------------------------------------------------------------------

// MODE switches the four bottom LOOP CONTROL buttons between Manual (IN, OUT,
// SELECT, RELOOP) and Autoloop (1, 2, 4, 8 beats).
NS6.loopMode = function (channel, control, value, status, group) {
    if (value === 0) {
        return;
    }
    var state = NS6.deckState(group);
    state.autoloop = !state.autoloop;
    var deck = script.deckFromGroup(group);
    NS6.sendLed(NS6.sideOf(deck).channel, NS6.stateLeds.loopMode, state.autoloop);
};

// The four buttons, in panel order. Shift gives the alternate functions the
// manual lists: loop rolls in Manual mode, stored loops in Autoloop mode.
NS6.loopButton = function (n, value, group) {
    if (value === 0) {
        return;
    }
    var state = NS6.deckState(group);
    var beats = [1, 2, 4, 8][n - 1];

    if (state.shift) {
        if (state.autoloop) {
            // Jump to stored loop n and reloop it.
            engine.setValue(group, "loop_move_" + beats + "_forward", 1);
        } else {
            // Loop roll in eighth, quarter, half, one-note measurements.
            var roll = [0.125, 0.25, 0.5, 1][n - 1];
            engine.setValue(group, "beatlooproll_" + roll + "_activate", 1);
        }
        return;
    }

    if (state.autoloop) {
        engine.setValue(group, "beatloop_" + beats + "_toggle", 1);
        return;
    }
    switch (n) {
    case 1: engine.setValue(group, "loop_in", 1); break;
    case 2: engine.setValue(group, "loop_out", 1); break;
    case 3: engine.setValue(group, "loop_exit", 1); break;
    case 4: engine.setValue(group, "reloop_andstop", 1); break;
    }
};

NS6.loopButton1 = function (c, ctl, value, s, group) { NS6.loopButton(1, value, group); };
NS6.loopButton2 = function (c, ctl, value, s, group) { NS6.loopButton(2, value, group); };
NS6.loopButton3 = function (c, ctl, value, s, group) { NS6.loopButton(3, value, group); };
NS6.loopButton4 = function (c, ctl, value, s, group) { NS6.loopButton(4, value, group); };

// --- Effects -----------------------------------------------------------------

// FX SELECT and FX PARAM are relative encoders: 1 for one click clockwise, 127
// for one anticlockwise. The XML's <selectknob/> option cannot drive them,
// because it is an accumulator - it writes "current value + click" back to the
// control. For "effect_selector", which is an encoder that never returns to
// zero, that means the value drifts away from zero and only its sign is ever
// read, so the knob soon selects in one direction whichever way it is turned.
// For "meta", a plain 0..1 knob, one click writes 0 + 1 and pins it at full.
// Both are handled here instead, where one click means one click.

// Clicks it takes to sweep FX PARAM from nothing to full.
NS6.fxParamClicks = 32;

// Turn an encoder byte into a signed number of clicks.
NS6.encoderDelta = function (value) {
    return value < 64 ? value : value - 128;
};

NS6.fxSelect = function (channel, control, value, status, group) {
    var delta = NS6.encoderDelta(value);
    if (delta === 0) {
        return;
    }
    // next_effect and prev_effect are buttons, so each click is a press and a
    // release rather than a value to be added to anything.
    var key = delta > 0 ? "next_effect" : "prev_effect";
    for (var i = 0; i < Math.abs(delta); i++) {
        engine.setValue(group, key, 1);
        engine.setValue(group, key, 0);
    }
};

NS6.fxParam = function (channel, control, value, status, group) {
    var delta = NS6.encoderDelta(value);
    if (delta === 0) {
        return;
    }
    var meta = engine.getValue(group, "meta") + delta / NS6.fxParamClicks;
    engine.setValue(group, "meta", Math.max(0, Math.min(1, meta)));
};

// --- LEDs ------------------------------------------------------------------

// LEDs are control change, and their numbers have nothing to do with the notes
// the same buttons send. Recorded from the hardware.
//
// They are also addressed by *physical deck side*, not by deck: channel 2 is
// the left deck whatever layer it is on, channel 3 the right. Mixxx controls
// are per deck, so something has to route between the two - which is why these
// are here rather than in the mapping's <outputs> section.
NS6.deckLeds = {
    sync_enabled: 0x07,
    cue_indicator: 0x08,
    play_indicator: 0x09,
    keylock: 0x10,
    loop_enabled: 0x15,
    reverse: 0x16,
    hotcue_1_status: 0x0B,
    hotcue_2_status: 0x0C,
    hotcue_3_status: 0x0D,
    hotcue_4_status: 0x0E,
    hotcue_5_status: 0x0F,
};

// Lights the controller drives from script state rather than from a Mixxx
// control: the SCRATCH button, the loop MODE button, and the layer indicators.
NS6.stateLeds = {
    scratch: 0x12,
    loopMode: 0x18,
};

// Which deck each physical side is showing. The LAYER buttons only report that
// they were pressed, never which way, so this is tracked here and starts where
// the hardware does.
NS6.sides = {
    // side -> { channel, deck, alternate, indicator }
    A: { channel: 0x01, deck: 1, alternate: 3, indicator: 0x11 },
    B: { channel: 0x02, deck: 2, alternate: 4, indicator: 0x28 },
};

NS6.sideOf = function (deck) {
    return deck === 1 || deck === 3 ? NS6.sides.A : NS6.sides.B;
};

NS6.sendLed = function (channel, cc, on) {
    midi.sendShortMsg(0xB0 | channel, cc, on ? 0x7F : 0x00);
};

// Connections are per side, not per deck: when a side switches layer its
// connections are torn down and remade against the deck it now shows.
NS6.connections = { A: [], B: [] };

NS6.connectSide = function (name) {
    var side = NS6.sides[name];
    NS6.connections[name].forEach(function (c) {
        c.disconnect();
    });
    NS6.connections[name] = [];

    var group = "[Channel" + side.deck + "]";
    Object.keys(NS6.deckLeds).forEach(function (key) {
        var cc = NS6.deckLeds[key];
        var connection = engine.makeConnection(group, key, function (value) {
            NS6.sendLed(side.channel, cc, value > 0);
        });
        connection.trigger();
        NS6.connections[name].push(connection);
    });

    // The indicator is lit when the side is showing its alternate layer.
    NS6.sendLed(side.channel, side.indicator, side.deck === side.alternate);

    // Script-held state does not come from a Mixxx control, so push it here.
    var state = NS6.deckState(group);
    NS6.sendLed(side.channel, NS6.stateLeds.scratch, state.scratching);
    NS6.sendLed(side.channel, NS6.stateLeds.loopMode, state.autoloop);
};

// LAYER, on channel 1. Which way it went is not reported, only that it moved,
// so the side is flipped between its two decks and everything is rebuilt
// against the one now showing.
NS6.layer = function (channel, control, value, status, group) {
    if (value === 0) {
        return;
    }
    var name = control === 0x04 ? "A" : "B";
    var side = NS6.sides[name];
    var base = name === "A" ? 1 : 2;
    side.deck = side.deck === base ? side.alternate : base;
    NS6.connectSide(name);
};
