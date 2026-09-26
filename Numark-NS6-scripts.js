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

// --- Hardware, not preferences ---

// The platter reports a 14-bit absolute position that wraps, so positions live
// on a circle whose circumference is the full 14-bit range. This is the modulus
// the wrap correction needs, and it is a property of the message format rather
// than of the wheel or of anyone's taste. Nothing else may use it.
NS6.platterModulus = 16384;

// Ticks one physical turn of the platter emits. A measured property of the
// hardware, and the number everything else is expressed against: if it is
// wrong, scratch, bend and skip are all off by the same factor.
//
// It has NOT been counted against the wheel. `ns6 jog` in the driver reports
// it; spin a counted number of turns and divide. 16384 here is the assumption
// that one turn is exactly one wrap of the position - plausible, unverified,
// and the first thing to check if the wheel feels geared wrong.
NS6.platterTicksPerRev = 16384;

// Revolutions per minute the scratch filter treats as normal speed. 33 1/3 is
// what the platter is silk-screened for. It only ever appears alongside
// scratchTurnsPerRev below, and the two multiply into a single number, so this
// stays a constant and that one is the knob.
NS6.scratchRpm = 33 + 1 / 3;

// Mixxx's scratch filter is an alpha-beta tracker stepped every millisecond.
// Beta is the term that produces the velocity the deck actually plays at; alpha
// only tunes the position estimate feeding it. These are the values Mixxx
// mappings normally use, and they settle in tens of milliseconds.
//
// Both must be non-zero. engine.scratchEnable guards its arguments with
// `if (alpha && beta)`, so a zero in either one makes Mixxx discard the pair
// and quietly substitute its timecode-vinyl defaults - alpha 1/512, a tracker
// needing the better part of a second to reach the speed of your hand. That is
// what "the wheel has to go round several times before anything happens" was.
NS6.scratchAlpha = 1 / 8;
NS6.scratchBeta = (1 / 8) / 32;

// --- Feel: one knob per thing the platter does ---

// Turns of a 33 1/3 record per turn of the platter, while scratching. At 1 the
// platter covers what a 12" turntable would; the NS6 wheel is about half that
// diameter, so 2 makes a gesture at the rim travel the same audio. Raise it to
// scratch faster.
NS6.scratchTurnsPerRev = 2;

// Pitch bend depth: the rate offset produced by turning the platter at one
// revolution per second. 0.5 means that speed plays the track half again as
// fast, and the offset is proportional, so half that speed bends half as hard.
//
// This drives Mixxx's `wheel` control, which is added to the rate unfiltered.
// The older `jog` control is deliberately not used: Mixxx runs every write to
// it through a 25-tap moving average, about 280ms of lag before the bend is
// felt at all. `wheel` has none, at the cost of not springing back on its own -
// see NS6.platterIdleMs.
NS6.bendStrength = 0.5;

// As far as the bend may go, so a hard spin cannot throw the rate somewhere
// absurd. Negative rates stay reachable on purpose: pushing the platter
// backwards past a standstill plays backwards, as a record would.
NS6.bendLimit = 2.0;

// Beats jumped per platter revolution while SKIP is held.
NS6.beatsPerRev = 16;

// How long the platter must go quiet before the wheel counts as released.
//
// This platter has no touch sensor - nothing in the recording says whether a
// hand is on it - so a gap in the reports is the only "let go" signal there is.
// It is what returns the bend to zero and what ends a scratch. Too short and a
// slow turn keeps releasing under your hand; too long and the deck hangs on
// after you stop.
NS6.platterIdleMs = 60;

// PITCH RANGE cycles through these, matching the values the button is labelled
// with on the panel.
NS6.pitchRanges = [0.08, 0.16, 0.50];

// --- State -------------------------------------------------------------------

// One entry per deck, keyed by Mixxx group.
NS6.decks = {};

NS6.deckState = function (group) {
    if (NS6.decks[group] === undefined) {
        NS6.decks[group] = {
            shift: false,
            // Which of the five hot cue layers the five buttons are on, 1 to 5.
            // The panel has five hot cue buttons and no pad grid, so a layer is
            // the only way past five bindings; see NS6.hotcueFor.
            hotcueLayer: 1,
            // Per button: this button's press was spent picking a layer, so
            // its release is not a cue being let go of. See NS6.hotcue.
            hotcuePicked: [false, false, false, false, false],
            // What the SCRATCH and SKIP buttons are asking for. These are the
            // only inputs to the platter's mode; see NS6.platterMode.
            scratchArmed: false,
            skipping: false,
            // Autoloop mode is what the four bottom LOOP CONTROL buttons do by
            // default on this unit.
            autoloop: true,
            platterMsb: 0,
            lastPosition: null,
            // What the platter did with its last turn, so that changing mode
            // part-way through a gesture can put the previous mode's control
            // back. Null until the wheel is first moved.
            platterMode: null,
            // There is no touch sensor, so "let go" is a gap in the reports.
            // This timer is that gap; NS6.platterKeepAlive restarts it on every
            // turn, so it only ever fires once the wheel has actually stopped.
            platterIdleTimer: null,
            platterLastMs: null,
            // engine.scratchEnable is on for this deck. Tracked because it may
            // not be left on: while it is, scratch2 owns the deck's rate
            // outright and the track cannot play normally.
            scratchEnabled: false,
            // Fractional beats the platter has turned through under SKIP,
            // carried until they add up to a whole beat worth jumping.
            skipBeats: 0,
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
    // Only the two feel knobs are exposed. platterTicksPerRev is a measurement
    // and platterModulus is a fact about the message format; neither is
    // anyone's preference, and letting the modulus be edited would break the
    // wrap correction rather than change how the wheel feels.
    NS6.scratchTurnsPerRev = setting("scratchTurnsPerRev", NS6.scratchTurnsPerRev);
    NS6.bendStrength = setting("bendStrength", NS6.bendStrength);
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
        // The platter leaves two things behind that outlive the script: a
        // scratch that owns the deck's rate, and a bend offset that does not
        // spring back on its own. Both would freeze the deck at whatever it was
        // doing when Mixxx closed.
        NS6.platterRelease(group, false);
        if (NS6.decks[group].platterIdleTimer !== null) {
            engine.stopTimer(NS6.decks[group].platterIdleTimer);
            NS6.decks[group].platterIdleTimer = null;
        }
    }
    // Leave the panel dark rather than frozen on the last state.
    ["A", "B"].forEach(function (name) {
        var side = NS6.sides[name];
        NS6.connections[name].forEach(function (c) {
            c.disconnect();
        });
        NS6.hotcueConnections[name].forEach(function (c) {
            c.disconnect();
        });
        Object.keys(NS6.deckLeds).forEach(function (key) {
            NS6.sendLed(side.channel, NS6.deckLeds[key], false);
        });
        NS6.hotcueLeds.forEach(function (cc) {
            NS6.sendLed(side.channel, cc, false);
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
        // The effect lights go out with the rest of the panel. As <output>
        // entries they could not: Mixxx stops driving an output when it closes
        // the controller but sends nothing to clear it, so whichever were lit
        // stayed lit, through the shutdown and past it.
        NS6.sendLed(0x00, NS6.fxLeds.enabled[unit], false);
        NS6.sendLed(0x00, NS6.fxLeds.master[unit], false);
        [1, 2, 3, 4].forEach(function (mixer) {
            NS6.sendLed(0x00, NS6.fxSendLed(unit, mixer), false);
        });
    });
    NS6.shown = {};
    NS6.drawPanel(false);
};

// --- SHIFT -------------------------------------------------------------------

// DELETE CUE / SHIFT. A plain hold: the panel legend calls the same button
// DELETE CUE because its primary job is erasing hot cues, which is what
// shift+hotcue does below. It has no gesture of its own - held or tapped, it
// only ever changes what another button means.
NS6.shift = function (channel, control, value, status, group) {
    var state = NS6.deckState(group);
    state.shift = value > 0;
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

// The panel has five hot cue buttons per deck and no pad grid, so five is all
// it can reach at once. A layer says which five: the deck holds a layer between
// 1 and 5, the button says which of that layer's five, and the two together
// name one of twenty-five bindings.
//
// There are as many layers as there are buttons, because the picker below is
// the buttons: five of them, so five layers, and no constant to keep in step.
//
// Per deck rather than per side, matching SHIFT itself: each deck keeps its own
// layer, and the LAYER button shows the layer of the deck it brings up.

// Fifteen of the twenty-five bindings have a Mixxx hot cue behind them - layers
// 1, 2 and 3, in order. The remaining ten are spare: they do nothing when
// pressed and their lamps stay dark.
NS6.hotcueCount = 15;

// The Mixxx cue a button reaches on a layer, or 0 for a binding with nothing
// behind it yet.
NS6.hotcueFor = function (layer, n) {
    var binding = (layer - 1) * NS6.hotcueLeds.length + n;
    return binding <= NS6.hotcueCount ? binding : 0;
};

// Holding SKIP turns the five hot cue buttons into a layer picker: the lamps
// stop showing cues and show the layer instead - the one button that is the
// current layer lit, the other four dark - and pressing a button moves the deck
// onto that layer.
//
// SKIP is free for this. Held, it is the platter's beat-jump modifier, so the
// hand that uses it is on the wheel; nothing was reading SKIP together with a
// hot cue button before. Nothing is taken away from the panel to pay for the
// gesture, which matters on a unit where every button is already mapped.
//
// It also answers the question the old two-bank arrangement could not: with the
// lamps borrowed to show the layer, the panel can finally say which one you are
// on, so dark cue lamps mean "no cues here" and only that.
NS6.pickHotcueLayer = function (group, state, n) {
    if (state.hotcueLayer === n) {
        return;
    }
    state.hotcueLayer = n;
    // The five lamps now follow five different controls, so they are rewired
    // rather than merely redrawn. A deck that is not the one its side is
    // showing has nowhere to draw, and its layer simply moves unseen.
    var side = NS6.ledSideFor(group);
    if (side !== null) {
        NS6.connectHotcues(side.name);
    }
};

// `n` is the button, 1 to 5, as it always has been. The layer is what turns it
// into a cue number - and both cue branches go through it, so shift+hotcue
// erases the cue the same button would have jumped to.
NS6.hotcue = function (n, value, group) {
    var state = NS6.deckState(group);
    if (state.skipping) {
        // SKIP is down, so this press picks a layer and never reaches a cue.
        if (value > 0) {
            state.hotcuePicked[n - 1] = true;
            NS6.pickHotcueLayer(group, state, n);
        }
        return;
    }
    if (state.hotcuePicked[n - 1]) {
        state.hotcuePicked[n - 1] = false;
        // SKIP was let go while the button was still down. The press was spent
        // on the layer, so the release that follows it is not a cue being let
        // go of. A *press* with the flag still set means the release never
        // arrived - per docs/MIDI-MAP.md the edge most easily lost on the way
        // here - so it falls through rather than leaving the button dead.
        if (value === 0) {
            return;
        }
    }
    var cue = NS6.hotcueFor(state.hotcueLayer, n);
    if (cue === 0) {
        return;
    }
    if (state.shift) {
        // Cue points cannot be overwritten on this unit; the manual is explicit
        // that you erase first. Shift+hotcue is that erase.
        if (value > 0) {
            engine.setValue(group, "hotcue_" + cue + "_clear", 1);
        }
        return;
    }
    engine.setValue(group, "hotcue_" + cue + "_activate", value > 0 ? 1 : 0);
};

NS6.hotcue1 = function (c, ctl, value, s, group) { NS6.hotcue(1, value, group); };
NS6.hotcue2 = function (c, ctl, value, s, group) { NS6.hotcue(2, value, group); };
NS6.hotcue3 = function (c, ctl, value, s, group) { NS6.hotcue(3, value, group); };
NS6.hotcue4 = function (c, ctl, value, s, group) { NS6.hotcue(4, value, group); };
NS6.hotcue5 = function (c, ctl, value, s, group) { NS6.hotcue(5, value, group); };

// --- Platter -----------------------------------------------------------------

// The platter has three jobs and no touch sensor, which between them decide the
// shape of everything below.
//
// The three jobs are picked by NS6.platterMode and each has its own Mixxx
// control; nothing here shares a destination with anything else, so there is no
// state to keep beyond which mode the buttons are asking for.
//
// The missing touch sensor is the harder half. Nothing the hardware sends says
// whether a hand is on the wheel, so "let go" has to be inferred from the
// reports stopping - NS6.platterIdleMs of quiet. One timer per deck does that,
// and it is what returns the bend to zero and what ends a scratch. It replaces
// the enable/disable calls the SCRATCH and SKIP handlers used to make by hand.

// What the platter should do with the turn it just reported.
NS6.platterMode = function (group, state) {
    if (state.skipping) {
        return "skip";
    }
    // A stopped deck scrubs like a record whether or not SCRATCH is lit: there
    // is nothing to bend the pitch of, and hunting for a cue point by hand is
    // the only thing the wheel is good for while the track is not moving.
    if (state.scratchArmed || engine.getValue(group, "play") !== 1) {
        return "scratch";
    }
    return "bend";
};

// Ticks that make up one revolution of the imagined record, which is what
// engine.scratchEnable is asking for. Fewer ticks per record revolution means
// the same gesture covers more audio, so this is where scratchTurnsPerRev does
// its work.
NS6.scratchIntervals = function () {
    return NS6.platterTicksPerRev / NS6.scratchTurnsPerRev;
};

// Hand the deck back: stop any scratch and take the bend off. Safe to call on a
// deck that is doing neither, which is why the idle timer and shutdown can both
// just call it.
//
// `ramp` eases a scratch back to playback speed the way letting go of a record
// does. It is wanted on release and not on shutdown, where there is nothing
// left to ease into.
NS6.platterRelease = function (group, ramp) {
    var state = NS6.deckState(group);
    if (state.scratchEnabled) {
        engine.scratchDisable(script.deckFromGroup(group), ramp);
        state.scratchEnabled = false;
    }
    engine.setValue(group, "wheel", 0);
    state.platterLastMs = null;
};

// Restart the "has the wheel gone quiet?" countdown. Called on every turn, so
// it only fires once the platter has been still for NS6.platterIdleMs.
NS6.platterKeepAlive = function (group) {
    var state = NS6.deckState(group);
    if (state.platterIdleTimer !== null) {
        engine.stopTimer(state.platterIdleTimer);
    }
    state.platterIdleTimer = engine.beginTimer(NS6.platterIdleMs, function () {
        NS6.deckState(group).platterIdleTimer = null;
        NS6.platterRelease(group, true);
    }, true);
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

    // Shortest way round the circle, so a wrap past zero reads as the small
    // step it was rather than a jump the length of the whole range. The
    // circumference is the 14-bit modulus and nothing else: using a tunable
    // number here would corrupt every delta larger than half of it.
    var delta = position - state.lastPosition;
    var half = NS6.platterModulus / 2;
    if (delta > half) {
        delta -= NS6.platterModulus;
    } else if (delta < -half) {
        delta += NS6.platterModulus;
    }
    state.lastPosition = position;

    if (delta === 0) {
        // The platter is understood to report whether or not it is being
        // turned, so most of what arrives is this. Returning before the idle
        // timer is kicked is the point: only movement keeps the wheel alive,
        // or a resting platter would hold the last bend open forever.
        return;
    }

    var revolutions = delta / NS6.platterTicksPerRev;
    var mode = NS6.platterMode(group, state);

    // Changing mode mid-turn must not leave the previous one's control set:
    // a bend held at some offset, or a scratch still owning the rate.
    if (state.platterMode !== mode) {
        NS6.platterRelease(group, false);
        state.platterMode = mode;
    }

    if (mode === "skip") {
        NS6.platterSkip(group, state, revolutions);
    } else if (mode === "scratch") {
        NS6.platterScratch(group, state, delta);
    } else {
        NS6.platterBend(group, state, revolutions);
    }

    NS6.platterKeepAlive(group);
};

// SKIP held: the platter jumps by beat instead of moving audio.
//
// The turn is accumulated and spent a whole beat at a time. Handing Mixxx the
// raw fraction instead would fire a seek on every report - thousands of them
// per revolution, each a few thousandths of a beat - which stutters rather than
// jumps.
NS6.platterSkip = function (group, state, revolutions) {
    state.skipBeats += revolutions * NS6.beatsPerRev;
    var whole = state.skipBeats > 0
        ? Math.floor(state.skipBeats)
        : Math.ceil(state.skipBeats);
    if (whole !== 0) {
        engine.setValue(group, "beatjump", whole);
        state.skipBeats -= whole;
    }
};

// Scratch: the turn goes to Mixxx's scratch filter, which owns the deck's rate
// for as long as it is enabled. That is why it is switched on at the first turn
// rather than by the SCRATCH button - a deck left with scratch enabled cannot
// play, because scratch2 overrides the rate outright.
NS6.platterScratch = function (group, state, delta) {
    var deck = script.deckFromGroup(group);
    if (!state.scratchEnabled) {
        engine.scratchEnable(deck, NS6.scratchIntervals(), NS6.scratchRpm,
                             NS6.scratchAlpha, NS6.scratchBeta);
        state.scratchEnabled = true;
    }
    engine.scratchTick(deck, delta);
};

// Bend: the turn becomes a speed, and the speed becomes a rate offset Mixxx
// adds to the deck unfiltered.
//
// It has to be a speed rather than a distance. `wheel` is a standing offset
// with no spring-back, so what it wants is "how fast is the hand moving now",
// which means dividing by the time since the last report rather than trusting
// the reports to arrive evenly.
NS6.platterBend = function (group, state, revolutions) {
    var now = Date.now();
    var elapsed = state.platterLastMs === null ? 0 : now - state.platterLastMs;
    state.platterLastMs = now;

    // First turn of a gesture, or two reports inside the same millisecond:
    // there is no interval to divide by yet. Wait for the next one rather than
    // divide by zero - at these intervals it is a millisecond away.
    if (elapsed <= 0) {
        return;
    }

    var revsPerSecond = revolutions / (elapsed / 1000);
    var offset = revsPerSecond * NS6.bendStrength;
    engine.setValue(group, "wheel",
                    Math.max(-NS6.bendLimit, Math.min(NS6.bendLimit, offset)));
};

// SCRATCH and SKIP only say what the platter should do with the next turn. The
// switching itself belongs to the platter, which is the only thing that knows
// when a gesture starts and - through the idle timer - when it ends.
NS6.scratchMode = function (channel, control, value, status, group) {
    if (value === 0) {
        return;
    }
    var state = NS6.deckState(group);
    state.scratchArmed = !state.scratchArmed;
    NS6.sendLed(NS6.sideOf(script.deckFromGroup(group)).channel,
                NS6.stateLeds.scratch, state.scratchArmed);
};

// SKIP is a hold, not a toggle: the platter jumps by beat while it is down.
//
// It is also the hot cue layer picker - see NS6.pickHotcueLayer - so the two
// things it means are settled on the same edge.
NS6.skip = function (channel, control, value, status, group) {
    var state = NS6.deckState(group);
    state.skipping = value > 0;
    // Part of a beat turned through under one press should not be spent by the
    // next one, possibly minutes later.
    state.skipBeats = 0;
    // The five hot cue lamps show the layer while SKIP is down and go back to
    // showing cues when it comes up. Same lamps, two things to say with them.
    var side = NS6.ledSideFor(group);
    if (side !== null) {
        NS6.drawHotcueLeds(side);
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
};

// The five HOT CUE lamps, in panel order. Not in NS6.deckLeds, whose keys are
// literally the Mixxx control names its connections bind to: which cue each of
// these follows depends on the deck's layer, so the name is not fixed and the
// generic loop cannot build them. NS6.connectHotcues does it instead.
NS6.hotcueLeds = [0x0B, 0x0C, 0x0D, 0x0E, 0x0F];

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

// The effect lights, panel-wide. These were <output> entries in the mapping,
// which is where a light with a Mixxx control behind it belongs - but Mixxx
// pushes an <output>'s first value before it has finished opening the MIDI
// output, so all twelve went into a closed port and the log filled with "not
// open for output!". The panel then started blank however the effects were
// actually set, and stayed that way until something moved. Driving them here
// puts them behind the same one-shot timer as everything else (see NS6.init),
// and lets NS6.shutdown put them out rather than leaving them frozen on.
NS6.fxLeds = {
    enabled: { 1: 0x17, 2: 0x2E },  // FX A / FX B on-off
    master: { 1: 0x4C, 2: 0x4D },   // FX SEND to the master mix
};

// FX SEND per mixer channel: channel 1's A then its B, then channel 2's, and so
// on, two apart per channel - the same run as the notes, in NS6.fxSend.
NS6.fxSendLedFirst = 0x44;

NS6.fxSendLed = function (unit, mixer) {
    return NS6.fxSendLedFirst + (mixer - 1) * 2 + (unit - 1);
};

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

    // The effect lights. Every one of these is triggered as it is connected, so
    // the panel comes up showing how Mixxx actually has the effects set rather
    // than dark - which is the point of moving them out of <outputs>. Mixxx
    // starts with unit 1 on channel 1 and unit 2 on channel 2, so two of the FX
    // SEND lights are lit before anything is touched.
    var connect = function (group, key, cc) {
        var connection = engine.makeConnection(group, key, function (value) {
            NS6.sendLed(0x00, cc, value > 0);
        });
        connection.trigger();
        NS6.globalConnections.push(connection);
    };
    [1, 2].forEach(function (unit) {
        var unitGroup = "[EffectRack1_EffectUnit" + unit + "]";
        var slotGroup = "[EffectRack1_EffectUnit" + unit + "_Effect1]";
        // FX A / FX B on-off follows the effect in slot 1, which is what the
        // button sets: the unit group has no "enabled" control in Mixxx 2.5.
        connect(slotGroup, "enabled", NS6.fxLeds.enabled[unit]);
        [1, 2, 3, 4].forEach(function (mixer) {
            connect(unitGroup, "group_[Channel" + mixer + "]_enable",
                    NS6.fxSendLed(unit, mixer));
        });
        connect(unitGroup, "group_[Master]_enable", NS6.fxLeds.master[unit]);
    });
};

// --- Wiring ----------------------------------------------------------------

// Connections are per side, not per deck: when a side switches layer its
// connections are torn down and remade against the deck it now shows.
NS6.connections = { A: [], B: [] };

// The hot cue lamps are kept apart from the rest so a layer change can rebuild
// five connections rather than the whole side. Rebuilding a side resends every
// lamp on it, and docs/MIDI-MAP.md is plain about what unexpected traffic down
// this pipe does to the device.
NS6.hotcueConnections = { A: [], B: [] };

// One hot cue lamp, drawn from whichever of the two things the five of them are
// saying: the deck's layer while SKIP is held, the cues of that layer otherwise.
// Every path to these lamps goes through here, so there is one place that knows
// which of the two is showing.
NS6.drawHotcueLed = function (side, i) {
    var group = "[Channel" + side.deck + "]";
    var state = NS6.deckState(group);
    var lit;
    if (state.skipping) {
        lit = state.hotcueLayer === i + 1;
    } else {
        var cue = NS6.hotcueFor(state.hotcueLayer, i + 1);
        lit = cue !== 0
            && engine.getValue(group, "hotcue_" + cue + "_status") > 0;
    }
    NS6.sendLed(side.channel, NS6.hotcueLeds[i], lit);
};

NS6.drawHotcueLeds = function (side) {
    NS6.hotcueLeds.forEach(function (cc, i) {
        NS6.drawHotcueLed(side, i);
    });
};

// Bind the five lamps to the cues the deck's layer currently reaches. A binding
// with nothing behind it has no control to follow, so it gets no connection and
// its lamp is simply drawn dark.
NS6.connectHotcues = function (name) {
    var side = NS6.sides[name];
    NS6.hotcueConnections[name].forEach(function (c) {
        c.disconnect();
    });
    NS6.hotcueConnections[name] = [];

    var group = "[Channel" + side.deck + "]";
    var state = NS6.deckState(group);
    NS6.hotcueLeds.forEach(function (cc, i) {
        var cue = NS6.hotcueFor(state.hotcueLayer, i + 1);
        if (cue === 0) {
            NS6.drawHotcueLed(side, i);
            return;
        }
        var connection = engine.makeConnection(group, "hotcue_" + cue + "_status", function () {
            NS6.drawHotcueLed(side, i);
        });
        connection.trigger();
        NS6.hotcueConnections[name].push(connection);
    });
};

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
    NS6.sendLed(side.channel, NS6.stateLeds.scratch, state.scratchArmed);
    NS6.sendLed(side.channel, NS6.stateLeds.loopMode, state.autoloop);
    NS6.sendLed(side.channel, NS6.stateLeds.shift, state.shift);

    // Last, because which cues these follow is the deck's own state and not a
    // fixed control name.
    NS6.connectHotcues(name);
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
    // Decks 1 and 3 are the same physical platter, and each keeps its own last
    // position. The one being switched to holds wherever the wheel was when
    // that layer was last live, which may be minutes and many turns ago, so the
    // first report after the flip would read as a jump of up to half a
    // revolution. Forget it and let the next report re-seed.
    NS6.deckState(group).lastPosition = null;
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
