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

// Set true to trace latching buttons into the Mixxx log, for working out why
// one is not behaving. Off by default: it logs on every press.
NS6.debug = false;

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

// Platter RPM the scratch filter assumes. 33 1/3 is the usual choice and matches
// what the platter is silk-screened for.
NS6.scratchRpm = 33 + 1 / 3;

// Alpha and beta turn Mixxx's scratch filter off rather than tune it.
//
// The filter is an alpha-beta estimator: alpha is how much it believes each new
// position, beta how much velocity it carries between them. The usual 1/8 and
// 1/256 smooth the platter and, more to the point, keep a velocity going after
// the reports stop - so stopping the wheel by hand leaves the deck coasting
// down instead of stopping.
//
// alpha 1 takes each position exactly as reported. beta 0 removes the velocity
// term entirely, so nothing is carried between reports and the audio only moves
// when the platter does. The deck stops when your hand does, and the wheel gets
// whatever resolution it has rather than an interpolation of it.
NS6.scratchAlpha = 1.0;
NS6.scratchBeta = 0.0;

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
            // Where the pitch fader physically is. Null until it first
            // reports, because until then nothing knows: the fader is not a
            // control that can be asked, only one that speaks when moved.
            pitchMsb: 0,
            pitchRaw: null,
        };
    }
    return NS6.decks[group];
};

// --- Lifecycle ---------------------------------------------------------------

// Read the tuning from Preferences -> Controllers, falling back to the values
// above when a setting is absent - which is the case for a mapping that has
// never had its settings saved.
NS6.applySettings = function () {
    var setting = function (name, current) {
        var value = engine.getSetting(name);
        return value === undefined || value === null ? current : value;
    };
    NS6.scratchSensitivity = setting("scratchSensitivity", NS6.scratchSensitivity);
    NS6.bendPerRevolution = setting("bendPerRevolution", NS6.bendPerRevolution);
    NS6.ticksPerRevolution = setting("ticksPerRevolution", NS6.ticksPerRevolution);
    // Only alpha is exposed. Raising beta off zero is what makes the platter
    // coast after your hand stops it, which is the thing this mapping set out
    // to avoid, so it stays where it is.
    NS6.scratchAlpha = setting("scratchSmoothing", NS6.scratchAlpha);
};

// Mixxx opens the controller's MIDI output *after* it runs init(), so anything
// sent from here goes nowhere - the log fills with "not open for output!" and
// the panel starts blank until something happens to change. Pushing the initial
// state from a one-shot timer instead lets the output finish opening first.
NS6.initialLedDelayMs = 500;

NS6.init = function () {
    NS6.applySettings();
    // The pitch fader is written from script rather than bound in the XML, so
    // ask for the soft takeover the <soft-takeover/> option used to give it.
    // Without this a fader left somewhere else snaps the rate on first touch.
    [1, 2, 3, 4].forEach(function (d) {
        engine.softTakeover("[Channel" + d + "]", "rate", true);
    });
    engine.beginTimer(NS6.initialLedDelayMs, function () {
        NS6.connectSide("A");
        NS6.connectSide("B");
        NS6.connectGlobal();
        NS6.drawPanel(true);
    }, true);
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
        NS6.loopLeds.forEach(function (cc) {
            NS6.sendLed(side.channel, cc, false);
        });
        Object.keys(NS6.pitchLeds).forEach(function (key) {
            NS6.sendLed(side.channel, NS6.pitchLeds[key], false);
        });
        // 0 is the layer display's "show nothing", which it never does on its
        // own; deliberate here, because the rest of the panel is going dark too.
        NS6.sendLedValue(side.channel, side.indicator, 0);
        NS6.sendLedValue(side.channel, NS6.displays.stripSearch, 0);
    });
    NS6.globalConnections.forEach(function (c) {
        c.disconnect();
    });
    NS6.globalConnections = [];
    [1, 2].forEach(function (unit) {
        NS6.sendLedValue(0x00, NS6.displays.fxParam[unit], 0);
    });
    NS6.shown = {};
    NS6.drawPanel(false);
};

// --- SHIFT -------------------------------------------------------------------

// DELETE CUE / SHIFT. Held, it is the shift layer; the panel legend calls the
// same button DELETE CUE because its primary job is erasing hot cues, which is
// what shift+hotcue does below.
NS6.shift = function (channel, control, value, status, group) {
    NS6.deckState(group).shift = value > 0;
    var side = NS6.ledSideFor(group);
    if (side !== null) {
        NS6.sendLed(side.channel, NS6.stateLeds.shift, value > 0);
    }
};

// --- Latching buttons --------------------------------------------------------

// A button that latches cannot be mapped straight through in the XML: the
// <Button> option sets the control to 1 on press and 0 on release, so a full
// press nets to no change and the button appears to need pressing twice. These
// act on the press alone and flip whatever the control currently is.
//
// One function serves every instance of a control, because Mixxx passes the
// mapping's <group> in - so the same `pfl` handler covers all four channels.
NS6.flip = function (group, key, value) {
    if (NS6.debug) {
        console.log(
            "NS6 flip " + group + " " + key + " value=" + value +
            " before=" + engine.getValue(group, key)
        );
    }
    if (value > 0) {
        engine.setValue(group, key, engine.getValue(group, key) ? 0 : 1);
    }
};

// PFL is not like the other buttons: it latches in hardware and drives its own
// light, which no message we send can change. Because the device owns that
// state, it reports *both* edges - note-on when it latches on, note-off when it
// latches off, one message per press. Timestamps settle it: consecutive
// messages arrive a second and a half apart, at the pressing cadence, not as
// press-and-release pairs milliseconds apart.
//
// So this follows the button rather than toggling: Mixxx ends up showing what
// the lit button already claims. Toggling here would discard every note-off and
// need two presses per change.
//
// The distinction is worth stating, because both kinds sit on this panel: a
// button whose LED we can drive is momentary and its state is ours to keep
// (see NS6.flip); a button whose LED we cannot drive keeps its own.
NS6.pfl = function (c, ctl, value, s, group) {
    engine.setValue(group, "pfl", value > 0 ? 1 : 0);
};
NS6.keylock = function (c, ctl, value, s, group) { NS6.flip(group, "keylock", value); };
NS6.toggleEnabled = function (c, ctl, value, s, group) { NS6.flip(group, "enabled", value); };
NS6.masterSendA = function (c, ctl, value) {
    NS6.flip("[EffectRack1_EffectUnit1]", "group_[Master]_enable", value);
};
NS6.masterSendB = function (c, ctl, value) {
    NS6.flip("[EffectRack1_EffectUnit2]", "group_[Master]_enable", value);
};

// SPLIT CUE latches in hardware, like PFL, so it is followed rather than
// toggled - and like PFL its release arrives as a real note-off.
NS6.splitCue = function (c, ctl, value) {
    engine.setValue("[Master]", "headSplit", value > 0 ? 1 : 0);
};

// FX SEND, one button per mixer channel per unit. Which unit and which channel
// they belong to comes from the note rather than from eight near-identical
// handlers: the notes run A then B, channel 1 through 4, from NS6.fxSendFirst.
NS6.fxSendFirst = 0x3D;

NS6.fxSend = function (channel, control, value, status, group) {
    var i = control - NS6.fxSendFirst;
    if (i < 0 || i > 7) {
        return;
    }
    var unit = (i % 2) + 1;
    var mixer = Math.floor(i / 2) + 1;
    NS6.flip(
        "[EffectRack1_EffectUnit" + unit + "]",
        "group_[Channel" + mixer + "]_enable",
        value
    );
};

// --- Crossfader assign -------------------------------------------------------

// One three-position switch per mixer channel, reporting *two* notes: L and R
// each latch on and off, and the middle position is both of them off. So neither
// note on its own says where the switch is - only the pair does, which is why
// both are tracked and why the release matters as much as the press.
NS6.assigned = {};

NS6.assignState = function (group) {
    if (NS6.assigned[group] === undefined) {
        NS6.assigned[group] = { left: false, right: false };
    }
    return NS6.assigned[group];
};

// Mixxx: 0 left, 1 centre, 2 right. Both notes down should not happen on a
// physical switch, and centre is the honest answer if it ever does.
NS6.applyAssign = function (group) {
    var s = NS6.assignState(group);
    var orientation = 1;
    if (s.left && !s.right) {
        orientation = 0;
    } else if (s.right && !s.left) {
        orientation = 2;
    }
    engine.setValue(group, "orientation", orientation);
};

NS6.assignLeft = function (c, ctl, value, s, group) {
    NS6.assignState(group).left = value > 0;
    NS6.applyAssign(group);
};

NS6.assignRight = function (c, ctl, value, s, group) {
    NS6.assignState(group).right = value > 0;
    NS6.applyAssign(group);
};

// LOOP ON/OFF. The panel legend is explicit that with no loop set this does
// nothing, so it is not enough on its own to get a loop going - IN and OUT in
// Manual mode, or the numbered buttons in Autoloop mode, are what create one.
NS6.loopToggle = function (c, ctl, value, s, group) {
    if (value === 0) {
        return;
    }
    engine.setValue(group, "reloop_toggle", 1);
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

// The pitch fader is 14-bit and absolute, and it is handled here rather than
// bound straight to "rate" in the XML for one reason: the two arrows beside it
// are the hardware's soft-takeover display, and drawing them needs to know
// where the *fader* is, not where the deck's rate is. A plain <control> binding
// never shows anyone the fader's position.
//
// Mixxx still does the takeover itself. engine.softTakeover applies to values
// script writes exactly as it does to a mapped control, so the behaviour is the
// same as the <soft-takeover/> option this replaces; see NS6.init.

// Fader position as a rate, -1 to 1. Inverted, which is what <invert/> did in
// the XML before this moved into script: DJ software disagrees about which end
// of a pitch fader is "faster". If yours runs backwards, drop the minus sign
// - that is, return 2 * raw / 16383 - 1.
NS6.rateFromFader = function (raw) {
    return 1 - 2 * raw / 16383;
};

// How close to 0% counts as centred, for the detent light. In rate units, so a
// fraction of whatever PITCH RANGE is set to: at +/-8% this is a fifth of a
// percent either side.
NS6.rateZeroWindow = 3 / 128;

// How far apart the fader and the deck have to be before an arrow comes on.
// The same order as Mixxx's own soft-takeover threshold, so the arrows go out at
// about the moment the fader takes hold rather than well before or after.
NS6.takeoverSlack = 2 * 3 / 128;

NS6.pitchMsb = function (channel, control, value, status, group) {
    NS6.deckState(group).pitchMsb = value;
};

// Only the LSB completes a reading, as with the platter.
NS6.pitchLsb = function (channel, control, value, status, group) {
    var state = NS6.deckState(group);
    state.pitchRaw = (state.pitchMsb << 7) | value;
    engine.setValue(group, "rate", NS6.rateFromFader(state.pitchRaw));
    NS6.updatePitchLeds(group);
};

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
    // The four numbered buttons now mean something else, so their lights do too.
    NS6.updateLoopLeds(group);
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

// --- Seeking ------------------------------------------------------------------

// SHIFT turns the four loop-size and loop-shift buttons into a seek: the two
// LOOP SHIFT buttons jump the track, and LOOP 2 X and LOOP 1/2 X set how far.
//
// The distance is Mixxx's own beatjump_size rather than a number kept in here.
// That matters: it is the same size Mixxx shows in its skin and uses for beatjump
// everywhere else, so the panel and the screen cannot disagree about it, and a
// size set with these buttons is still there after the mapping reloads.
//
// Seeking is in beats, so it needs the track to have a beatgrid - as autoloop
// does. Without one, nothing happens.
NS6.seekMin = 1 / 32;
NS6.seekMax = 64;

NS6.nudgeSeek = function (group, factor) {
    var size = engine.getValue(group, "beatjump_size") * factor;
    engine.setValue(
        group,
        "beatjump_size",
        Math.max(NS6.seekMin, Math.min(NS6.seekMax, size))
    );
};

// A trigger wants a press and a release, not a value left at 1, or the second
// press has nothing to change - the same reason NS6.fxSelect does this.
NS6.trigger = function (group, key) {
    engine.setValue(group, key, 1);
    engine.setValue(group, key, 0);
};

NS6.loopHalve = function (channel, control, value, status, group) {
    if (NS6.deckState(group).shift) {
        if (value > 0) {
            NS6.nudgeSeek(group, 0.5);
        }
        return;
    }
    engine.setValue(group, "loop_halve", value > 0 ? 1 : 0);
};

NS6.loopDouble = function (channel, control, value, status, group) {
    if (NS6.deckState(group).shift) {
        if (value > 0) {
            NS6.nudgeSeek(group, 2);
        }
        return;
    }
    engine.setValue(group, "loop_double", value > 0 ? 1 : 0);
};

NS6.loopShiftLeft = function (channel, control, value, status, group) {
    if (NS6.deckState(group).shift) {
        if (value > 0) {
            NS6.trigger(group, "beatjump_backward");
        }
        return;
    }
    engine.setValue(group, "loop_move_1_backward", value > 0 ? 1 : 0);
};

NS6.loopShiftRight = function (channel, control, value, status, group) {
    if (NS6.deckState(group).shift) {
        if (value > 0) {
            NS6.trigger(group, "beatjump_forward");
        }
        return;
    }
    engine.setValue(group, "loop_move_1_forward", value > 0 ? 1 : 0);
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
// control: the SCRATCH button, the loop MODE button, and DELETE CUE / SHIFT,
// which is held rather than latched and so has no control of its own.
NS6.stateLeds = {
    scratch: 0x12,
    loopMode: 0x18,
    shift: 0x0A,
};

// The four numbered LOOP CONTROL buttons, in panel order. What they light for
// depends on which mode the section is in, so they go through NS6.updateLoopLeds
// rather than being connected to one control each.
NS6.loopLeds = [0x19, 0x1A, 0x1B, 0x1C];

// The pitch fader's three lights: centre detent, and the two takeover arrows.
NS6.pitchLeds = {
    zero: 0x37,
    up: 0x3C,
    down: 0x3D,
};

// Displays whose value is a position or a fill rather than on-ness. Nothing
// here may be sent 0x7F: on every one of them that is off the end of the scale
// and shows nothing at all, which is why they went unmapped for so long. See
// docs/MIDI-MAP.md.
NS6.displays = {
    // FX PARAM rings, eleven positions. Panel-wide, so any channel reaches them.
    fxParam: { 1: 0x13, 2: 0x2A },
    // The bar above STRIP SEARCH, fifteen LEDs, filled. Addressed by deck side.
    stripSearch: 0x4E,
};

// Don't resend a value a display already shows.
//
// playposition changes many times a second while a track plays and the strip
// search bar has fifteen steps, so nearly all of those updates ask for the
// number already on the panel. Dropping them matters more here than tidiness
// would suggest: this is the same pipe the vendor driver bit-bangs an audio
// chip's register interface through, and it is what takes the device off the bus
// when too much unexpected traffic goes down it.
NS6.shown = {};
NS6.sendLedOnce = function (channel, cc, value) {
    var key = channel + ":" + cc;
    if (NS6.shown[key] === value) {
        return;
    }
    NS6.shown[key] = value;
    NS6.sendLedValue(channel, cc, value);
};

// CRATES, PREPARE and FILES, which answer on any channel. Their buttons move
// focus in the library and have no state to show, so they are simply lit - an
// unlit button on this panel reads as a dead one. Set this false for a dark
// navigation row instead.
NS6.litNavButtons = true;
NS6.navLeds = [0x03, 0x04, 0x05];

// Which deck each physical side is showing. The LAYER buttons only report that
// they were pressed, never which way, so this is tracked here and starts where
// the hardware does.
NS6.sides = {
    // side -> { name, channel, deck, alternate, indicator }
    A: { name: "A", channel: 0x01, deck: 1, alternate: 3, indicator: 0x11 },
    B: { name: "B", channel: 0x02, deck: 2, alternate: 4, indicator: 0x28 },
};

NS6.sideOf = function (deck) {
    return deck === 1 || deck === 3 ? NS6.sides.A : NS6.sides.B;
};

// The side a deck's lights are on, or null if that deck is not the one its side
// is currently showing. A background deck's state has nowhere to go: there is
// no second set of lamps behind the layer button, so writing them would
// overwrite the deck that is actually on the panel.
NS6.ledSideFor = function (group) {
    var deck = script.deckFromGroup(group);
    var side = NS6.sideOf(deck);
    return side.deck === deck ? side : null;
};

NS6.sendLed = function (channel, cc, on) {
    NS6.sendLedValue(channel, cc, on ? 0x7F : 0x00);
};

// Most lights are on or off and 0x7F means on. The layer indicators are not,
// so the value has to be sayable.
NS6.sendLedValue = function (channel, cc, value) {
    midi.sendShortMsg(0xB0 | channel, cc, value);
};

// The layer indicator is not one lamp but two - a lamp beside each of the
// side's deck numbers, 1 and 3 on the left, 2 and 4 on the right - and the
// value picks which of them is lit rather than switching one on. Measured on
// the hardware:
//
//     value 0        both lamps dark
//     value 1        the side's base deck      (1 on the left, 2 on the right)
//     value 2 and up the side's alternate deck (3 on the left, 4 on the right)
//
// Nothing here may send 0x7F, which is what a light normally gets. It
// saturates to the alternate deck whichever deck is actually showing, and the
// 0x00 it pairs with darkens the display entirely - a state the panel never
// shows by itself, and one that reads as a broken indicator rather than as
// "deck 1". Both halves of the obvious on/off mapping are wrong.
NS6.sendLayerLed = function (side) {
    NS6.sendLedValue(side.channel, side.indicator, side.deck === side.alternate ? 2 : 1);
};

// --- Lights that are a function of several controls -------------------------

// The four numbered LOOP CONTROL buttons. MODE changes what they do, so it
// changes what they light for.
NS6.updateLoopLeds = function (group) {
    var side = NS6.ledSideFor(group);
    if (side === null) {
        return;
    }
    var lit;
    if (NS6.deckState(group).autoloop) {
        // The buttons are 1, 2, 4 and 8 beats: light whichever the loop that
        // exists is the length of.
        lit = [1, 2, 4, 8].map(function (beats) {
            return engine.getValue(group, "beatloop_" + beats + "_enabled") > 0;
        });
    } else {
        // Manual. IN and OUT light as each end is placed, so the pair doubles as
        // a record of how far through setting a loop you are, and RELOOP lights
        // once there is a loop to return to. SELECT is mapped to loop_exit here
        // and has no state of its own to show, so it stays dark.
        var start = engine.getValue(group, "loop_start_position") >= 0;
        var end = engine.getValue(group, "loop_end_position") >= 0;
        lit = [start, end, false, start && end];
    }
    lit.forEach(function (on, i) {
        NS6.sendLed(side.channel, NS6.loopLeds[i], on);
    });
};

// The pitch fader's lights. The centre detent is just the rate; the arrows are
// the gap between where the fader is and where it would have to be for the rate
// the deck is actually at - which is exactly what soft takeover is waiting for.
NS6.updatePitchLeds = function (group) {
    var side = NS6.ledSideFor(group);
    if (side === null) {
        return;
    }
    var rate = engine.getValue(group, "rate");
    NS6.sendLed(side.channel, NS6.pitchLeds.zero, Math.abs(rate) < NS6.rateZeroWindow);

    var fader = NS6.deckState(group).pitchRaw;
    if (fader === null) {
        // The fader has never reported, so nothing is known about the gap. Both
        // arrows off is the honest answer, not "aligned".
        NS6.sendLed(side.channel, NS6.pitchLeds.up, false);
        NS6.sendLed(side.channel, NS6.pitchLeds.down, false);
        return;
    }
    // Both sides of this are rates, not fader positions, which is deliberate:
    // it keeps the arrows correct even if NS6.rateFromFader's inversion is
    // changed, because "which way is -%" is a fact about the panel and not
    // about how the fader is wired.
    //
    // Positive means the fader is asking for more speed than the deck has, so
    // the fader has to come back toward -% for the two to meet.
    var gap = NS6.rateFromFader(fader) - rate;
    // The up arrow is the one at the -% end of the fader's travel.
    NS6.sendLed(side.channel, NS6.pitchLeds.up, gap > NS6.takeoverSlack);
    NS6.sendLed(side.channel, NS6.pitchLeds.down, gap < -NS6.takeoverSlack);
};

// STRIP SEARCH's bar: fifteen LEDs filled to the play position.
//
// A loaded track at its very start shows one LED rather than none, because a dark
// bar already means something else - no track - and the two should not look alike.
NS6.updateStripSearch = function (group) {
    var side = NS6.ledSideFor(group);
    if (side === null) {
        return;
    }
    var fill = 0;
    if (engine.getValue(group, "track_loaded") === 1) {
        var at = engine.getValue(group, "playposition");
        fill = Math.max(1, Math.min(15, Math.round(at * 15)));
    }
    NS6.sendLedOnce(side.channel, NS6.displays.stripSearch, fill);
};

// An FX PARAM ring, eleven positions, following that unit's parameter. Panel-wide
// rather than per deck, so it is not part of either side's connections.
NS6.updateFxParam = function (unit) {
    var group = "[EffectRack1_EffectUnit" + unit + "_Effect1]";
    var meta = Math.max(0, Math.min(1, engine.getValue(group, "meta")));
    NS6.sendLedOnce(0x00, NS6.displays.fxParam[unit], 1 + Math.round(meta * 10));
};

// Controls to watch for each of those, since neither is one control's value.
// Listed after the functions because these are plain properties, not
// declarations, and are not hoisted.
NS6.derivedLeds = [
    {
        keys: ["loop_start_position", "loop_end_position", "loop_enabled",
               "beatloop_1_enabled", "beatloop_2_enabled",
               "beatloop_4_enabled", "beatloop_8_enabled"],
        draw: NS6.updateLoopLeds,
    },
    {
        // rateRange moves the rate under a stationary fader, so it changes the
        // gap the arrows show just as moving the fader does.
        keys: ["rate", "rateRange"],
        draw: NS6.updatePitchLeds,
    },
    {
        keys: ["playposition", "track_loaded"],
        draw: NS6.updateStripSearch,
    },
];

// The panel-wide displays, which belong to no deck side and so are connected
// once rather than rebuilt when a layer switches.
NS6.globalConnections = [];

NS6.connectGlobal = function () {
    NS6.globalConnections.forEach(function (c) {
        c.disconnect();
    });
    NS6.globalConnections = [];
    [1, 2].forEach(function (unit) {
        var group = "[EffectRack1_EffectUnit" + unit + "_Effect1]";
        var connection = engine.makeConnection(group, "meta", function () {
            NS6.updateFxParam(unit);
        });
        connection.trigger();
        NS6.globalConnections.push(connection);
    });
};

// --- Wiring ----------------------------------------------------------------

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

    // The derived lights are drawn once here and then redrawn whenever any of
    // the controls they read moves. They are not triggered per connection: one
    // draw covers all of that group's controls, and triggering each would draw
    // the same thing several times over.
    NS6.derivedLeds.forEach(function (led) {
        led.keys.forEach(function (key) {
            NS6.connections[name].push(engine.makeConnection(group, key, function () {
                led.draw(group);
            }));
        });
        led.draw(group);
    });

    // Which of the side's two deck numbers is lit.
    NS6.sendLayerLed(side);

    // Script-held state does not come from a Mixxx control, so push it here.
    var state = NS6.deckState(group);
    NS6.sendLed(side.channel, NS6.stateLeds.scratch, state.scratching);
    NS6.sendLed(side.channel, NS6.stateLeds.loopMode, state.autoloop);
    NS6.sendLed(side.channel, NS6.stateLeds.shift, state.shift);
};

// The panel-wide lights, which are not per deck and so are not part of either
// side. Sent on channel 1; the recording found they answer on any channel.
NS6.drawPanel = function (on) {
    NS6.navLeds.forEach(function (cc) {
        NS6.sendLed(0x00, cc, on && NS6.litNavButtons);
    });
};

// LAYER, on channel 1. The press says which side moved but not which way, so
// this flips that side and rebuilds against the deck now showing.
//
// The flip is a guess, and it is only here so the panel reacts the instant the
// button is hit. What makes it right is NS6.observeDeck below, which corrects it
// from the traffic a moment later.
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

// Which deck a side is showing, taken from the traffic rather than tracked.
//
// The panel never states it: the LAYER buttons report that they were pressed
// and not which way. But a deck side transmits on the channel of the deck it is
// currently showing - that is what the LAYER button changes - so every message
// from that side names the deck it came from. The platters report continuously,
// touched or not, so the answer arrives on its own within milliseconds and
// keeps arriving.
//
// Tracking it instead means starting from an assumption. Mixxx launched against
// hardware already switched to layers 3 and 4 would have every deck light on
// the wrong side, and no press of anything would ever put it right, because the
// toggle and the hardware would stay exactly one flip apart. Observing cannot
// drift: the worst case is being right one platter report late.
//
// Only handlers bound to a deck's own MIDI channel may call this. NS6.pfl must
// not: it is bound to [Channel1..4] as mixer strips, all on channel 1, so a PFL
// press would otherwise claim its strip number as a layer.
NS6.observeDeck = function (group) {
    var deck = script.deckFromGroup(group);
    var side = NS6.sideOf(deck);
    if (side.deck === deck) {
        return;
    }
    side.deck = deck;
    NS6.connectSide(side.name);
};

// Wrapping rather than a call at the top of each: these are every handler bound
// to a deck's own channel, and the list is the point - it is what says which
// handlers carry layer information and which, like NS6.pfl, do not.
[
    "platterMsb", "platterLsb", "pitchMsb", "pitchLsb", "stripSearch",
    "shift", "keylock", "pitchRange", "reverse", "skip", "beatgridAdjust",
    "scratchMode", "loopMode", "loopToggle",
    "loopHalve", "loopDouble", "loopShiftLeft", "loopShiftRight",
    "hotcue1", "hotcue2", "hotcue3", "hotcue4", "hotcue5",
    "loopButton1", "loopButton2", "loopButton3", "loopButton4",
].forEach(function (name) {
    var handler = NS6[name];
    NS6[name] = function (channel, control, value, status, group) {
        NS6.observeDeck(group);
        return handler(channel, control, value, status, group);
    };
});
