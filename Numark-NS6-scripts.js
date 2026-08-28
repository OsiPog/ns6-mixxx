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

// Ticks the platter reports per full revolution. The platter sends a 14-bit
// absolute position that wraps, so this sets how far a given movement scratches.
// If scratching feels too fast, raise it; too slow, lower it.
NS6.ticksPerRevolution = 16384;

// Platter RPM the scratch filter assumes, and its response curve. 33 1/3 is the
// usual choice and matches what the platter is silk-screened for.
NS6.scratchRpm = 33 + 1 / 3;
NS6.scratchAlpha = 1.0 / 8;
NS6.scratchBeta = (1.0 / 8) / 32;

// How far the platter moves the track when not scratching, as a fraction of
// full pitch range per revolution.
NS6.bendScale = 0.8;

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
    // Nothing to send: the NS6 lights its own buttons from the notes the
    // <outputs> section sends, and Mixxx sends those as the controls change.
};

NS6.shutdown = function () {
    for (var group in NS6.decks) {
        if (NS6.decks[group].scratching) {
            engine.scratchDisable(script.deckFromGroup(group));
        }
    }
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
    engine.setValue(group, "jog", delta / NS6.ticksPerRevolution * NS6.bendScale * 100);
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
        engine.scratchEnable(deck, NS6.ticksPerRevolution, NS6.scratchRpm,
                             NS6.scratchAlpha, NS6.scratchBeta);
    } else {
        engine.scratchDisable(deck);
    }
    midi.sendShortMsg(0x90 | (deck - 1), 0x21, state.scratching ? 0x7F : 0x00);
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
            engine.scratchEnable(deck, NS6.ticksPerRevolution, NS6.scratchRpm,
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
    midi.sendShortMsg(0x90 | (deck - 1), 0x27, state.autoloop ? 0x7F : 0x00);
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
