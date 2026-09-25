/* ================================================================
   GO-BACK-N ARQ SIMULATOR  —  script.js
   Pure Vanilla JavaScript, no libraries, no backend.

   HOW IT WORKS
   ─────────────────────────────────────────────────────────────────
   1. buildTimeline()  runs a real DISCRETE-EVENT SIMULATION of Go-Back-N
      on a virtual clock (pure logic, no DOM). Every send, arrival,
      loss, ACK, timer start/stop and timeout happens at an exact
      virtual time, in the order a real network would produce.
   2. The UI then PLAYS that timeline. Packets are drawn as a pure
      function of virtual time, so several frames are in flight at once,
      exactly like a pipelined sliding-window protocol.
   3. STEP jumps to the next protocol event; PLAY chains steps
      automatically; PAUSE freezes the clock.

   GO-BACK-N MODEL (textbook-exact)
   ─────────────────────────────────────────────────────────────────
   Sender:   Sf = first outstanding frame     Sn = next frame to send
             Sw = window size (Sw < 2^m, so Sw ≤ 7 for m = 3)
   Receiver: Rn = next expected sequence number (receiver window = 1)

   SENDER
     • may send while  Sn < Sf + Sw  (and Sn < N)   — one frame per TX tick
     • ONE timer, always for the oldest outstanding frame Sf
         – starts when a frame is sent and no timer is running
         – restarts when a cumulative ACK moves Sf and frames remain
         – stops when everything sent has been acknowledged
     • ACK N (cumulative: "everything < N received, send N next")
         – N > Sf  → Sf = N, window slides
         – N ≤ Sf  → duplicate / stale, ignored
     • TIMEOUT → Sn is rewound to Sf and every outstanding frame
       (Sf … Sn−1) is sent again, in order

   ERROR MODES
     normal  — nothing lost or corrupted
     loss    — first transmission of frame 1 is LOST in the channel
     ackloss — the ACK for frame 1 and the final ACK are LOST in the channel
     corrupt — frame 1's first transmission, and the final ACK, each arrive
               intact-looking but fail their checksum and are discarded
               (receiver rule c / sender rule c below)

   RECEIVER
     • seq == Rn  → accept, Rn++, send ACK Rn
     • otherwise  → discard (NOT buffered), re-send ACK Rn (duplicate)

   SEQUENCE NUMBERS  (absolute frame ID  vs.  protocol sequence number)
     Two separate numeric domains are kept side by side, on purpose:

       • ABSOLUTE FRAME ID — a plain, unbounded counter (0, 1, 2, …)
         used ONLY for bookkeeping: indexing states[]/attempts[],
         counting stats, positioning the sliding-window UI, and
         deciding when all N frames have been delivered. It never
         appears on the "wire" and the protocol never compares it
         as if it were a sequence number.

       • PROTOCOL SEQUENCE NUMBER — the genuine m-bit, modulo-2^m
         value that actually rides in a frame/ACK header: Sf, Sn,
         Rn and every ACK number are real values in [0, SEQ_SPACE),
         computed with seqOf(frameId) = frameId mod SEQ_SPACE and
         advanced with nextSeq(seq) = (seq + 1) mod SEQ_SPACE. A
         frame's sequence number wraps exactly like a real m-bit
         header would: frame 8's sequence number IS 0, the same
         value frame 0 once carried.

     Because sequence numbers wrap, the engine never compares them
     with plain ">" or "<" (an ACK of 0 is not "less than" an Sf of
     7 — it is one modulo step ahead of it). Every sequence-number
     comparison instead goes through seqDistance(from, to): the
     number of forward modulo steps from `from` to `to`, always in
     [0, SEQ_SPACE-1] — e.g. seqDistance(7, 0) = 1, seqDistance(6, 0) = 2.
     A cumulative ACK is valid iff 0 < seqDistance(Sf, ackNum) ≤ the
     number of frames currently outstanding (itself computed the
     same way, as seqDistance(Sf, Sn)) — this is exactly "don't
     accept an ACK that advances beyond the outstanding window",
     expressed without ever subtracting or ordering raw sequence
     numbers. This only works because Sw < SEQ_SPACE (enforced by
     MAX_SW below): at most Sw frames are ever outstanding at once,
     so a modulo distance can never be confused with "actually" a
     multiple of SEQ_SPACE further along.
   ================================================================ */

'use strict';

/* ================================================================
   CONSTANTS
   ================================================================ */
const M         = 3;               // sequence-number bits
const SEQ_SPACE = 1 << M;          // 2^m = 8
const MAX_SW    = SEQ_SPACE - 1;   // Go-Back-N requires Sw < 2^m  → 7 for m = 3.
                                    // UI enforcement: see readConfig() and the
                                    // window-size stepper handlers, which clamp
                                    // to MAX_SW and surface a validation message
                                    // rather than silently allowing Sw ≥ 8.
const MIN_FRAMES = 5;
const MAX_FRAMES = 20;

/* Virtual-time model (arbitrary "time units", drawn to scale):
     TX       sender can start one new frame every TX units
     D / A    one-way propagation delay for DATA / ACK
     TIMEOUT  retransmission timeout  (> RTT = D + A, so no spurious
              timeouts happen unless a frame really is lost)          */
const NET = { TX: 1, D: 3, A: 3, TIMEOUT: 10 };

/* ── absolute-frame-id  ⇄  protocol-sequence-number helpers ──
   seqOf(k)             protocol (wire) sequence number of absolute frame id k:
                        k mod SEQ_SPACE
   wire(k)              alias of seqOf, kept for the renderer's existing call sites
   nextSeq(seq)         the sequence number that follows `seq`, wrapping at
                        SEQ_SPACE: nextSeq(7) === 0
   seqDistance(from,to) number of forward modulo steps from `from` to `to`,
                        always in [0, SEQ_SPACE-1] — e.g. seqDistance(7,0) === 1,
                        seqDistance(6,0) === 2. This is the ONLY way the engine
                        below compares sequence numbers — there is no
                        "ack > Sf" / "seq < Rn" anywhere in the protocol logic.
   advanceSeq(k)        ABSOLUTE frame-id bookkeeping only (k + 1, never wraps) —
                        tracks how many frames have been sent/delivered/acked
                        so far. Deliberately separate from the modulo sequence
                        numbers above; never fed into a sequence comparison.   */
const seqOf        = k => k % SEQ_SPACE;
const wire         = seqOf;
const nextSeq      = seq => (seq + 1) % SEQ_SPACE;
const seqDistance  = (from, to) => ((to - from) % SEQ_SPACE + SEQ_SPACE) % SEQ_SPACE;
const advanceSeq   = k => k + 1;

const range    = (a, b) => (b <= a ? `${a}` : `${a} – ${b}`);

// Full-sentence explanation of the modulo relationship between an absolute
// Frame ID and the wire sequence number it carries, for tooltips that need
// to spell out wraparound rather than just juxtapose two bare numbers.
const seqExplain = k => (k >= SEQ_SPACE
  ? `Frame ID ${k} → Seq ${seqOf(k)} (sequence numbers operate modulo ${SEQ_SPACE}).`
  : `Frame ID ${k} → Seq ${k}.`);

// What a cumulative ACK means, expressed purely in terms of sequence
// numbers (never Frame IDs): "ACK N" says everything through Seq N−1 (mod
// SEQ_SPACE) is in, and Seq N is next. Used anywhere the UI explains an
// ACK's meaning so an ACK number is never read as if it were a Frame ID.
const ackMeaning = ackNum => {
  const prevSeq = (ackNum + SEQ_SPACE - 1) % SEQ_SPACE;
  return `ACK ${ackNum}: all frames through Seq ${prevSeq} have been received correctly; ` +
         `Seq ${ackNum} is the next sequence number expected.`;
};

// Sequence-number-first display for the sender/receiver protocol registers
// (Sf/Sn/Rn/lastAck): the genuine wire sequence number is shown as the
// primary value; the absolute frame id is added, explicitly labeled, only
// once the two diverge after wraparound. This keeps "Sf = 8" from ever
// being misread as if 8 itself were a sequence number when the real wire
// value is 0.
const regLabel = k => `Seq ${seqOf(k)}` + (k >= SEQ_SPACE ? ` (Frame ID ${k})` : '');
// Same text as regLabel minus the leading "Seq " — for the timer bar, whose
// static "Seq " prefix lives in index.html (so the label never reads "Seq Seq 0").
const regValue = k => regLabel(k).replace(/^Seq /, '');

/* ================================================================
   PROTOCOL ENGINE  (pure logic — no DOM, testable in Node)
   ================================================================ */
function buildTimeline(cfg) {
  const N  = cfg.totalFrames;
  const Sw = cfg.windowSize;
  const { TX, D, A, TIMEOUT } = NET;

  /* Channel fault plans — each fires exactly once, then the channel behaves.
       mode 'loss'    → DATA frame 1 is LOST on its first transmission
                        (textbook example: discards, duplicate ACKs, go-back).
       mode 'ackloss' → the ACKs for frame 1 and the LAST frame are LOST
                        (cumulative-ACK-absorbs-a-loss + timeout demo).
       mode 'corrupt' → DATA frame 1's first transmission arrives but is
                        CORRUPTED (discarded silently, no ACK — FSM receiver
                        rule c); the ACK for the LAST frame arrives at the
                        sender but is CORRUPTED (discarded, ignored — FSM
                        sender rule c).                                       */
  const mode = cfg.mode || (cfg.lossMode ? 'loss' : 'normal');
  const dataFault = new Map();   // "seq#attempt" -> 'lost' | 'corrupt'
  const ackFault  = new Map();   // seq (the accepted frame) -> 'lost' | 'corrupt'
  const lostAckNums = new Set(); // ACK numbers actually dropped (for "covered" narration)
  if (mode === 'loss')    dataFault.set('1#1', 'lost');
  if (mode === 'ackloss') { ackFault.set(1, 'lost');    ackFault.set(N - 1, 'lost'); }
  if (mode === 'corrupt') { dataFault.set('1#1', 'corrupt'); ackFault.set(N - 1, 'corrupt'); }

  /* ── protocol state ──
     sfAbs / snAbs / rnAbs are ABSOLUTE, unbounded frame-id counters used only
     for bookkeeping (array indexing, stats, "have we sent/delivered/acked all
     N frames yet"). They are exposed to the UI/snapshot as Sf/Sn/Rn exactly as
     before, unbounded, so the sliding-window UI keeps working unchanged.
     The genuine PROTOCOL sequence numbers the algorithm actually reasons with
     — the real, wrapping, modulo-2^m Sf/Sn/Rn — are always derived on the fly
     with seqOf(sfAbs) / seqOf(snAbs) / seqOf(rnAbs) and never stored as a
     separate mutable register (storing them separately would just invite the
     two copies to drift out of sync). */
  let sfAbs = 0, snAbs = 0, rnAbs = 0, lastAck = 0;
  let highest = 0;                    // highest Sn ever reached (to detect retransmissions)
  // Display-only FSM flag. TIMEOUT internally rewinds Sn back to Sf for
  // retransmission bookkeeping, which would otherwise make the snapshot
  // taken at that exact instant compute 0 frames outstanding and show the
  // sender as READY for one event, even though the timer just fired *because*
  // frames were outstanding. This flag is set true only for the duration of
  // that single TIMEOUT emit() and cleared immediately afterward (see the
  // TIMEOUT case below) — it does NOT persist through the retransmission
  // burst that follows. Per the FSM, a timeout is a self-loop: it never by
  // itself forces BLOCKING. Every event after the TIMEOUT (each resent SEND,
  // ARRIVE, ACK_ARRIVE, …) must derive `blocking` purely from the genuine
  // modulo distance between Sf and Sn, exactly like every other event — so
  // the badge correctly reads READY whenever the window isn't actually full
  // (e.g. a lost/corrupted ACK on the very last frame, where only one slot
  // of the window is ever occupied).
  let retransmitting = false;
  let txFree = 0;                     // time the transmitter is free again
  let pumpPending = false;
  let tokenCounter = 0;
  let timer = { active: false, seq: -1, start: 0, dur: TIMEOUT, token: 0 };
  const states   = Array(N).fill('waiting');
  const attempts = Array(N).fill(0);
  const stats    = { delivered: 0, acked: 0, retx: 0, timeouts: 0 };

  const events  = [];                 // narrative events (one per STEP)
  const packets = [];                 // drawn objects (frames, ACKs)

  /* ── priority queue of scheduled things ── */
  const q = [];
  let order = 0;
  const PRI = { ARRIVE: 0, LOST: 0, CORRUPT: 0, ACK_LOST: 1, ACK_CORRUPT: 1, ACK_ARRIVE: 1, TIMEOUT: 2, PUMP: 3 };
  const schedule = (t, kind, data) => q.push({ t, kind, pri: PRI[kind], n: order++, data });
  const popNext = () => {
    let bi = 0;
    for (let i = 1; i < q.length; i++) {
      const a = q[i], b = q[bi];
      if (a.t < b.t || (a.t === b.t && (a.pri < b.pri || (a.pri === b.pri && a.n < b.n)))) bi = i;
    }
    return q.splice(bi, 1)[0];
  };

  const snap = () => ({
    Sf: sfAbs, Sn: snAbs, Rn: rnAbs, lastAck,
    states: states.slice(),
    stats:  { ...stats },
    timer:  { ...timer },
    // FSM sender state, derived via genuine modulo distance (not Sn − Sf).
    // `retransmitting` is true ONLY while the TIMEOUT event itself is being
    // emitted (see the TIMEOUT case), purely to suppress that one instant's
    // transient "0 outstanding" reading right after Sn is rewound — it is
    // false for every other event, so a retransmission burst reports its
    // real window occupancy exactly like normal sends do:
    blocking: retransmitting || seqDistance(seqOf(sfAbs), seqOf(snAbs)) >= Sw,
  });
  const emit = (type, t, extra) => events.push({ type, t, ...extra, snap: snap() });

  // How many frames are currently outstanding, as a genuine modulo distance
  // between the two protocol sequence numbers — never as a subtraction of
  // absolute ids (that would be the same number here, but for the wrong
  // reason: it's the WRAP-SAFE distance that makes this correct in general).
  const outstandingCount = () => seqDistance(seqOf(sfAbs), seqOf(snAbs));
  const canSend = () => outstandingCount() < Sw && snAbs < N;

  function requestPump(t) {
    if (pumpPending) return;
    pumpPending = true;
    schedule(Math.max(t, txFree), 'PUMP', {});
  }
  function startTimer(t, seq) {
    tokenCounter++;
    timer = { active: true, seq, start: t, dur: TIMEOUT, token: tokenCounter };
    schedule(t + TIMEOUT, 'TIMEOUT', { token: tokenCounter });
  }
  function stopTimer() { timer = { ...timer, active: false }; }

  /* ── sender transmits frame Sn ── */
  function doSend(t) {
    const frameId = snAbs;              // absolute id (bookkeeping only)
    const seq     = seqOf(frameId);     // genuine wire sequence number this frame carries
    attempts[frameId]++;
    const attempt = attempts[frameId];
    const retx    = frameId < highest;
    highest       = Math.max(highest, frameId + 1);
    const fault   = dataFault.get(`${frameId}#${attempt}`);   // undefined | 'lost' | 'corrupt'
    if (fault) dataFault.delete(`${frameId}#${attempt}`);
    const lost    = fault === 'lost';
    const corrupt = fault === 'corrupt';

    snAbs++;                            // Sn (mod) = seqOf(snAbs), recomputed wherever it's needed
    states[frameId] = retx ? 'retx' : 'sent';
    if (retx) stats.retx++;

    let timerStarted = false;
    if (!timer.active) { startTimer(t, sfAbs); timerStarted = true; }

    // Lost frames vanish mid-channel (frac 0.5); corrupted frames travel the
    // full distance and are only rejected once they reach the receiver.
    const pkt = {
      kind: 'data', seq: frameId, retx, lost, corrupt, discarded: false,
      t0: t, t1: lost ? t + D / 2 : t + D, frac: lost ? 0.5 : 1,
      startEv: events.length, endEv: Infinity, el: null, markerEl: null,
    };
    packets.push(pkt);
    const arrivalKind = lost ? 'LOST' : corrupt ? 'CORRUPT' : 'ARRIVE';
    // The channel carries the genuine wire sequence number (`wireSeq`), kept
    // deliberately separate from the absolute frame id (`seq`) used for
    // bookkeeping/UI — this is exactly what the receiver below compares.
    schedule(pkt.t1, arrivalKind, { seq: frameId, wireSeq: seq, pkt, retx });

    emit('SEND', t, { seq: frameId, retx, attempt, timerStarted });
    txFree = t + TX;
  }

  /* ── main loop ── */
  requestPump(0);
  let done = false, guard = 0;

  while (q.length && !done && guard++ < 50000) {
    const ev = popNext();
    const t  = ev.t;

    switch (ev.kind) {

      case 'PUMP': {
        pumpPending = false;
        if (canSend()) {
          doSend(t);
          if (canSend()) requestPump(t + TX);
        }
        break;
      }

      case 'LOST': {
        const { seq, pkt } = ev.data;
        states[seq] = 'lost';
        pkt.endEv = events.length;
        emit('LOST', t, { seq });
        break;
      }

      case 'CORRUPT': {
        // Receiver FSM rule (c): a corrupted packet is discarded — no ACK.
        const { seq, pkt } = ev.data;
        states[seq] = 'corrupted';
        pkt.endEv = events.length;
        emit('CORRUPT', t, { seq, Rn: rnAbs });
        break;
      }

      case 'ARRIVE': {
        const { seq: frameId, wireSeq, pkt, retx } = ev.data;
        const RnBeforeAbs = rnAbs;
        const RnMod       = seqOf(rnAbs);     // genuine protocol register the receiver compares against
        let accepted = false, reason = '';

        if (wireSeq === RnMod) {              // Receiver rule: accept ONLY when packet.seq === Rn (modulo!)
          accepted = true;
          rnAbs = advanceSeq(rnAbs);          // absolute bookkeeping: one more frame delivered
          stats.delivered = rnAbs;
          states[frameId] = 'received';
        } else if (frameId < rnAbs) {         // already delivered earlier (absolute-id bookkeeping check)
          reason = 'duplicate';
          if (states[frameId] !== 'acked') states[frameId] = 'received';
        } else {                              // gap → out of order
          reason = 'out-of-order';
          states[frameId] = 'discarded';
        }
        // New Rn, as a genuine modulo increment — nextSeq(seq) wraps at SEQ_SPACE,
        // exactly the "Rn = (Rn + 1) % 8" rule. rnAbs (bumped above) always agrees.
        const RnAfterMod = accepted ? nextSeq(RnMod) : RnMod;
        const RnAfterAbs = rnAbs;
        lastAck = RnAfterAbs;
        if (!accepted) pkt.discarded = true;
        pkt.endEv = events.length;

        // Does the ACK produced by this arrival meet a fault in the channel?
        const ackFaultKind = accepted ? ackFault.get(frameId) : undefined; // undefined | 'lost' | 'corrupt'
        if (ackFaultKind) ackFault.delete(frameId);
        const ackLost    = ackFaultKind === 'lost';
        const ackCorrupt = ackFaultKind === 'corrupt';
        if (ackLost) lostAckNums.add(RnAfterAbs);   // tracked in the ABSOLUTE domain (never the wrapped one)

        // The ACK carries the genuine (wrapping) Rn — either the NEW Rn after
        // accepting, or the CURRENT, unchanged Rn as the duplicate ACK.
        const ack = {
          kind: 'ack', ackNum: RnAfterMod, confirmedSeq: RnMod, dup: !accepted,
          lost: ackLost, corrupt: ackCorrupt,
          t0: t, t1: ackLost ? t + A / 2 : t + A, frac: ackLost ? 0.5 : 1,
          startEv: events.length, endEv: Infinity, el: null, markerEl: null,
        };
        packets.push(ack);
        const ackKind = ackLost ? 'ACK_LOST' : ackCorrupt ? 'ACK_CORRUPT' : 'ACK_ARRIVE';
        schedule(ack.t1, ackKind, { ackNum: RnAfterMod, confirmedSeq: RnMod, pkt: ack });

        emit('ARRIVE', t, {
          seq: frameId, accepted, reason, retx,
          RnBefore: RnBeforeAbs, RnAfter: RnAfterAbs, ackNum: RnAfterMod,
        });
        break;
      }

      case 'ACK_LOST': {
        const { ackNum, confirmedSeq, pkt } = ev.data;
        pkt.endEv = events.length;
        emit('ACK_LOST', t, { ackNum, confirmedSeq });
        break;
      }

      case 'ACK_CORRUPT': {
        // Sender FSM rule (c): a corrupted ACK is discarded — ignored, no state change.
        const { ackNum, confirmedSeq, pkt } = ev.data;
        pkt.endEv = events.length;
        emit('ACK_CORRUPT', t, { ackNum, confirmedSeq, Sf: sfAbs });
        break;
      }

      case 'ACK_ARRIVE': {
        const { ackNum, pkt } = ev.data;          // ackNum: genuine modulo seq number, 0..SEQ_SPACE-1
        pkt.endEv = events.length;
        const SfBefore = sfAbs;
        const sfSeq    = seqOf(sfAbs);
        const snSeq    = seqOf(snAbs);
        const wasBlocking = retransmitting || seqDistance(sfSeq, snSeq) >= Sw;   // sender FSM state before this ACK
        let slide = false, timerAction = 'continue';

        const outstanding = seqDistance(sfSeq, snSeq);   // frames outstanding, via modulo distance
        const advance      = seqDistance(sfSeq, ackNum); // frames this ACK confirms, via modulo distance

        // Cumulative-ACK validity rule, expressed purely via modulo distance —
        // no "ackNum > Sf" / "ackNum < Sf" anywhere:
        //   advance === 0              → ackNum equals Sf: stale/duplicate, confirms nothing
        //   0 < advance ≤ outstanding  → valid; the window slides by `advance` frames
        //   advance > outstanding      → cannot correspond to anything currently
        //                                outstanding (e.g. a very stale ACK) — reject
        if (advance > 0 && advance <= outstanding) {
          slide = true;
          retransmitting = false;   // always already false here (see TIMEOUT case) — kept as a defensive no-op
          for (let k = sfAbs; k < sfAbs + advance && k < N; k++) states[k] = 'acked';
          sfAbs += advance;                      // absolute bookkeeping advances by `advance` frames
          stats.acked = sfAbs;
          if (snAbs < sfAbs) snAbs = sfAbs;      // never (re)send acknowledged frames
          if (sfAbs < snAbs) { startTimer(t, sfAbs); timerAction = 'restart'; }
          else                { stopTimer();          timerAction = 'stop'; }
        }
        const nowBlocking = seqDistance(seqOf(sfAbs), seqOf(snAbs)) >= Sw;

        const coveredLostAck = slide &&
          [...lostAckNums].some(a => a > SfBefore && a < sfAbs);   // both sides absolute — no domain mixing

        emit('ACK_ARRIVE', t, {
          ackNum, slide, SfBefore, SfAfter: sfAbs, timerAction,
          isDupAck: pkt.dup, coveredLostAck,
          wasBlocking, nowBlocking,
        });

        if (slide) requestPump(t);
        if (sfAbs >= N) {
          emit('COMPLETE', t, {});
          done = true;
        }
        break;
      }

      case 'TIMEOUT': {
        if (!(timer.active && timer.token === ev.data.token)) break;   // stale timer
        stats.timeouts++;
        const SnOld = snAbs;
        const seqs = [];
        for (let k = sfAbs; k < snAbs; k++) seqs.push(k);
        snAbs = sfAbs;                             // ← "go back" (absolute bookkeeping rewind)
        retransmitting = true;                     // suppress the transient "0 outstanding" reading in THIS snapshot only
        startTimer(t, sfAbs);
        emit('TIMEOUT', t, { Sf: sfAbs, SnOld, seqs });
        retransmitting = false;                     // real outstanding count governs every event from here on (self-loop, not a forced BLOCKING)
        requestPump(t);
        break;
      }
    }
  }

  if (!done) {                                    // safety net — should never trigger
    emit('COMPLETE', events.length ? events[events.length - 1].t : 0, {});
  }

  return { events, packets };
}

/* ================================================================
   UI STATE
   ================================================================ */
const sim = {
  // config
  windowSize:  4,
  totalFrames: 10,
  mode:        'normal',   // 'normal' | 'loss' | 'ackloss'
  stepMs:      1200,       // real ms per "3 time units" (speed selector)

  // timeline
  events:  [],
  packets: [],
  evIdx:   0,              // next event to commit

  // clock
  vt:        0,            // current virtual time
  target:    null,         // virtual time we're travelling to (next event)
  dwellLeft: 0,            // real ms left to hold on the current event (PLAY only)

  // playback flags
  autoplay: false,         // PLAY chain
  advance:  false,         // clock is allowed to move (PLAY, or one STEP)
  finished: false,
  raf:      null,
  lastTs:   null,
  completeTimer: null,

  // what is shown right now
  view: null,
  lastEvent: null,
};

const unitMs  = () => sim.stepMs / 3;
const dwellMs = () => sim.stepMs * 0.45;

function initialView() {
  return {
    Sf: 0, Sn: 0, Rn: 0, lastAck: 0,
    states: Array(sim.totalFrames).fill('waiting'),
    stats:  { delivered: 0, acked: 0, retx: 0, timeouts: 0 },
    timer:  { active: false, seq: -1, start: 0, dur: NET.TIMEOUT, token: 0 },
  };
}

/* ================================================================
   DOM REFERENCES
   ================================================================ */
let D = {};
function populateDomRefs() {
  const $ = id => document.getElementById(id);
  D = {
    windowSizeDisplay: $('windowSizeDisplay'), totalFramesInput: $('totalFramesInput'),
    btnWinMinus: $('btnWinMinus'), btnWinPlus: $('btnWinPlus'), speedSelect: $('speedSelect'),

    infoSf: $('infoSf'), infoSn: $('infoSn'), infoSw: $('infoSw'),
    infoRn: $('infoRn'), infoLastAck: $('infoLastAck'),

    channelArea: $('channelArea'), packetLayer: $('packetLayer'),
    senderBox: $('senderBox'), receiverBox: $('receiverBox'),
    senderState: $('senderState'), senderBuffer: $('senderBuffer'),

    timerFrameLabel: $('timerFrameLabel'), timerStatus: $('timerStatus'), timerFill: $('timerFill'),

    windowTrack: $('windowTrack'), windowBracket: $('windowBracket'), bracketW: $('bracketW'),

    eventBody: $('eventBody'), eventIcon: $('eventIcon'),
    eventTitle: $('eventTitle'), eventDesc: $('eventDesc'),

    statDelivered: $('statDelivered'), statAcked: $('statAcked'),
    statRetx: $('statRetx'), statTimeouts: $('statTimeouts'),

    btnStep: $('btnStep'), btnPlay: $('btnPlay'), btnPause: $('btnPause'), btnReset: $('btnReset'),

    completionOverlay: $('completionOverlay'), completionStats: $('completionStats'),
    btnRunAgain: $('btnRunAgain'),
  };
}

const setText = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };

/* ================================================================
   CONFIG / RESET
   ================================================================ */
function readConfig() {
  let sw = parseInt(D.windowSizeDisplay.textContent, 10) || 4;
  sw = Math.max(1, Math.min(MAX_SW, sw));
  sim.windowSize = sw;
  D.windowSizeDisplay.textContent = sw;

  let n = parseInt(D.totalFramesInput.value, 10);
  if (!Number.isFinite(n)) n = 10;
  sim.totalFrames = Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, n));
  D.totalFramesInput.value = sim.totalFrames;

  sim.stepMs = parseInt(D.speedSelect.value, 10) || 1200;
  const modeEl = document.querySelector('input[name="errorMode"]:checked');
  sim.mode = modeEl ? modeEl.value : 'normal';
}

function resetSimulation() {
  if (sim.raf) { cancelAnimationFrame(sim.raf); sim.raf = null; }
  clearTimeout(sim.completeTimer);
  sim.lastTs = null;

  sim.autoplay = false;
  sim.advance  = false;
  sim.finished = false;
  sim.vt = 0; sim.target = null; sim.dwellLeft = 0; sim.evIdx = 0;
  sim.lastEvent = null;

  readConfig();
  const tl = buildTimeline({
    totalFrames: sim.totalFrames, windowSize: sim.windowSize, mode: sim.mode,
  });
  sim.events  = tl.events;
  sim.packets = tl.packets;
  sim.view    = initialView();

  D.packetLayer.innerHTML = '';
  D.completionOverlay.hidden = true;
  setConfigLocked(false);
  setButtons('idle');

  updateInfoPanels();
  renderWindow();
  updateStats();
  renderFrame();
  const intro = {
    normal:  'Normal mode: nothing is lost or corrupted.',
    loss:    'Loss mode: the first transmission of Frame ID 1 will be dropped in the channel.',
    ackloss: `Lost-ACK mode: the ACK for Frame ID 1 and the final ACK (for Frame ID ${sim.totalFrames - 1}) will be dropped in the channel.`,
    corrupt: `Corruption mode: Frame ID 1's first transmission and the final ACK (for Frame ID ${sim.totalFrames - 1}) will each arrive intact but fail their checksum, and be discarded.`,
  }[sim.mode];
  setEvent('normal', '⬡', 'Ready to simulate',
    intro + '\nPress ▶ PLAY for continuous playback or STEP → to advance one event at a time.');
}

function setButtons(mode) {
  const b = { idle: [0, 0, 1], playing: [1, 1, 0], paused: [0, 0, 1], done: [1, 1, 1] }[mode];
  D.btnPlay.disabled  = !!b[0];
  D.btnStep.disabled  = !!b[1];
  D.btnPause.disabled = !!b[2];
}

function setConfigLocked(locked) {
  D.btnWinMinus.disabled = locked;
  D.btnWinPlus.disabled  = locked;
  D.totalFramesInput.disabled = locked;
  D.speedSelect.disabled = locked;
  document.querySelectorAll('input[name="errorMode"]').forEach(r => (r.disabled = locked));
}

/* ================================================================
   PLAYBACK
   ================================================================ */
function ensureLoop() {
  if (!sim.raf) { sim.lastTs = null; sim.raf = requestAnimationFrame(tick); }
}

function startPlay() {
  if (sim.finished) return;
  setConfigLocked(true);
  sim.autoplay = true;
  sim.advance  = true;
  setButtons('playing');
  if (sim.lastEvent) showEvent(sim.lastEvent);      // clear the "paused" banner
  ensureLoop();
}

function pauseSimulation() {
  if (sim.finished) return;
  sim.autoplay = false;
  sim.advance  = false;
  setButtons('paused');
  setEvent('warning', '⏸', 'PAUSED',
    'The clock is frozen mid-flight.\nPress ▶ PLAY to continue or STEP → to advance one event.');
}

function stepForward() {
  if (sim.finished || sim.autoplay || sim.advance) return;
  if (sim.evIdx >= sim.events.length) return;
  setConfigLocked(true);
  sim.dwellLeft = 0;
  sim.advance   = true;         // runs until ONE event is committed
  ensureLoop();
}

function tick(ts) {
  sim.raf = null;
  const dt = sim.lastTs == null ? 0 : Math.min(ts - sim.lastTs, 80);
  sim.lastTs = ts;

  if (sim.advance) {
    if (sim.dwellLeft > 0) {
      sim.dwellLeft -= dt;                              // hold on the event so it can be read
    } else {
      if (sim.target === null && sim.evIdx < sim.events.length) {
        sim.target = sim.events[sim.evIdx].t;           // travel to the next event
      }
      if (sim.target !== null) {
        sim.vt += dt / unitMs();
        if (sim.vt >= sim.target - 1e-9) {
          sim.vt = sim.target;
          commitEvent();
        }
      }
    }
  }

  renderFrame();
  if (sim.advance) sim.raf = requestAnimationFrame(tick);
  else sim.lastTs = null;
}

function commitEvent() {
  const ev = sim.events[sim.evIdx++];
  sim.view      = ev.snap;
  sim.lastEvent = ev;
  sim.target    = null;

  updateInfoPanels();
  renderWindow();
  updateStats();
  showEvent(ev);
  pulseForEvent(ev);

  if (ev.type === 'COMPLETE') { finish(); return; }
  if (sim.autoplay) sim.dwellLeft = dwellMs();
  else              sim.advance = false;                // a STEP ends after one event
}

function finish() {
  sim.finished = true;
  sim.autoplay = false;
  sim.advance  = false;
  setButtons('done');

  const st = sim.view.stats;
  D.completionStats.innerHTML =
    `<div>Frames delivered: <strong>${sim.totalFrames}</strong></div>` +
    `<div>Retransmissions:  <strong>${st.retx}</strong></div>` +
    `<div>Timeouts:         <strong>${st.timeouts}</strong></div>` +
    `<div>Total time:       <strong>${sim.vt} units</strong></div>`;
  sim.completeTimer = setTimeout(() => { D.completionOverlay.hidden = false; }, 900);
}

/* ================================================================
   RENDERING
   ================================================================ */
function renderFrame() {
  renderPackets();
  renderTimer();
}

/* ── packets & lost markers, drawn purely from virtual time ── */
const PKT_W = 48, PKT_H = 36;

function makePacketEl(p) {
  const el = document.createElement('div');
  // The pill shows the value actually carried on the wire (an m-bit field).
  // Within any one window this is always unambiguous — Sw < 2^m guarantees
  // no two outstanding frames ever share a wire sequence number. The
  // absolute frame count (needed only because our demo runs past 2^m
  // frames) lives in the tooltip and in the info panels, not squeezed
  // into a 48×36 pill.
  if (p.kind === 'data') {
    el.className = `packet data${p.retx ? ' retx' : ''}`;
    el.innerHTML = `<span class="pkt-num">${wire(p.seq)}</span>` +
      (p.retx ? '<span class="pkt-sub">↻RETX</span>' : '');
    el.title = seqExplain(p.seq);
  } else {
    el.className = `packet ack${p.dup ? ' dup-ack' : ''}`;
    el.innerHTML = `<span class="pkt-sub">ACK</span><span class="pkt-num">${wire(p.ackNum)}</span>` +
      (p.dup ? '<span class="pkt-sub">DUP</span>' : '');
    el.title = `${ackMeaning(p.ackNum)}${p.dup ? ' (duplicate)' : ''}`;
  }
  el.style.width  = PKT_W + 'px';
  el.style.height = PKT_H + 'px';
  D.packetLayer.appendChild(el);
  return el;
}

function renderPackets() {
  const W  = D.channelArea.clientWidth;
  const H  = D.channelArea.clientHeight;
  const xa = 4;
  const xb = Math.max(xa, W - PKT_W - 4);
  const yData = H * 0.27 - PKT_H / 2;
  const yAck  = H * 0.67 - PKT_H / 2;
  const vt = sim.vt;

  for (const p of sim.packets) {
    const started = sim.evIdx > p.startEv;
    const ended   = sim.evIdx > p.endEv;
    let alive = started && !ended;

    // a rejected packet (out-of-order discard, or corruption) lingers a moment
    let fading = false, glitching = false;
    if (p.kind === 'data' && p.discarded && !p.corrupt && started && ended && vt < p.t1 + 1.2) {
      alive = true; fading = true;
    }
    if (p.corrupt && started && ended && vt < p.t1 + 1.2) {
      alive = true; glitching = true;
    }

    if (alive) {
      if (!p.el) p.el = makePacketEl(p);
      const prog = Math.max(0, Math.min(1, (vt - p.t0) / (p.t1 - p.t0)));
      const x = p.kind === 'data'
        ? xa + (xb - xa) * p.frac * prog
        : xb - (xb - xa) * prog;
      p.el.style.left = x + 'px';
      p.el.style.top  = (p.kind === 'data' ? yData : yAck) + 'px';
      p.el.classList.toggle('lost', fading);
      p.el.classList.toggle('glitching', glitching);
    } else if (p.el) {
      p.el.remove(); p.el = null;
    }

    // "LOST" marker where a frame/ACK vanished mid-channel
    if (p.lost) {
      const markerAlive = started && ended && vt < p.t1 + 3;
      if (markerAlive) {
        if (!p.markerEl) {
          const m = document.createElement('div');
          m.className = 'lost-marker';
          m.innerHTML = '<span class="lost-x">✕</span><span class="lost-text">' +
            (p.kind === 'ack' ? 'ACK LOST' : 'LOST') + '</span>';
          D.packetLayer.appendChild(m);
          p.markerEl = m;
        }
        p.markerEl.style.left = (xa + (xb - xa) * 0.5 + PKT_W / 2 - 24) + 'px';
        p.markerEl.style.top  = ((p.kind === 'ack' ? yAck : yData) + PKT_H / 2 - 22) + 'px';
      } else if (p.markerEl) {
        p.markerEl.remove(); p.markerEl = null;
      }
    }

    // "CORRUPT" marker at the end of a full journey that was rejected on arrival
    if (p.corrupt) {
      const markerAlive = started && ended && vt < p.t1 + 3;
      if (markerAlive) {
        if (!p.markerEl) {
          const m = document.createElement('div');
          m.className = 'lost-marker corrupt-marker';
          m.innerHTML = '<span class="lost-x">⚡</span><span class="lost-text">' +
            (p.kind === 'ack' ? 'ACK CORRUPT' : 'CORRUPT') + '</span>';
          D.packetLayer.appendChild(m);
          p.markerEl = m;
        }
        const endX = p.kind === 'data' ? xb : xa;
        p.markerEl.style.left = (endX + PKT_W / 2 - 28) + 'px';
        p.markerEl.style.top  = ((p.kind === 'ack' ? yAck : yData) + PKT_H / 2 - 22) + 'px';
      } else if (p.markerEl) {
        p.markerEl.remove(); p.markerEl = null;
      }
    }
  }
}

/* ── timer bar: real progress of the protocol timer ── */
function renderTimer() {
  const T = sim.view.timer;
  const flashing = sim.lastEvent && sim.lastEvent.type === 'TIMEOUT';

  if (flashing) {
    setText(D.timerFrameLabel, regValue(sim.lastEvent.Sf));
    setText(D.timerStatus, '⚠ TIMEOUT');
    D.timerStatus.className = 'timer-status timeout-flash';
    renderTimerBar(1, true);
  } else if (T.active) {
    const prog = Math.max(0, Math.min(1, (sim.vt - T.start) / T.dur));
    setText(D.timerFrameLabel, regValue(T.seq));
    setText(D.timerStatus, 'RUNNING');
    D.timerStatus.className = 'timer-status';
    renderTimerBar(prog, true);
  } else {
    setText(D.timerFrameLabel, '—');
    setText(D.timerStatus, sim.evIdx > 0 && !sim.finished ? 'STOPPED' : '');
    D.timerStatus.className = 'timer-status';
    renderTimerBar(0, false);
  }
}

function renderTimerBar(progress, active) {
  D.timerFill.style.width = (progress * 100).toFixed(2) + '%';
  let cls = 'timer-fill';
  if (active && progress >= 0.82) cls += ' danger';
  else if (active && progress >= 0.55) cls += ' warning';
  if (D.timerFill.className !== cls) D.timerFill.className = cls;
}

/* ── sliding window / frame cells ── */
function renderWindow() {
  const track = D.windowTrack, bracket = D.windowBracket;
  const CELL_W = 52, GAP = 6, STEP = CELL_W + GAP;
  const V = sim.view, N = sim.totalFrames, Sw = sim.windowSize;

  if (track.querySelectorAll('.frame-cell').length !== N) {
    track.innerHTML = '';
    for (let i = 0; i < N; i++) {
      const cell = document.createElement('div');
      cell.id = `fc-${i}`;
      cell.className = 'frame-cell';
      cell.title = seqExplain(i);
      // Past the first 2^m frames the absolute id and the wire sequence
      // number diverge (e.g. frame 8 → seq 0) — show both directly on
      // the cell, not just in the hover tooltip, so wraparound is
      // visible at a glance during a live demo.
      const seqBadge = i >= SEQ_SPACE ? `<span class="frame-cell-seq">Seq ${seqOf(i)}</span>` : '';
      cell.innerHTML = `<span class="frame-cell-num">${i}</span>${seqBadge}<span class="frame-cell-icon"></span>`;
      track.appendChild(cell);
    }
  }

  const ICONS = { waiting: '', sent: '→', received: '✓', acked: '✓✓', lost: '✕', retx: '↻', discarded: '🚫', corrupted: '⚡' };
  for (let i = 0; i < N; i++) {
    const cell = document.getElementById(`fc-${i}`);
    const st   = V.states[i];
    const inWin = i >= V.Sf && i < V.Sf + Sw;
    cell.className = `frame-cell state-${st}${inWin ? ' in-window' : ''}`;
    cell.querySelector('.frame-cell-icon').textContent = ICONS[st] || '';
  }

  const wCount = Math.min(Sw, Math.max(0, N - V.Sf));
  bracket.style.left  = V.Sf * STEP + 'px';
  bracket.style.width = Math.max(0, wCount * STEP - GAP) + 'px';
  setText(D.bracketW, Sw);
}

function updateInfoPanels() {
  const V = sim.view;
  setText(D.infoSf, regLabel(V.Sf));
  setText(D.infoSn, regLabel(V.Sn));
  setText(D.infoSw, sim.windowSize);
  setText(D.infoRn, regLabel(V.Rn));
  setText(D.infoLastAck, regLabel(V.lastAck));
  renderSenderState();
  renderSenderBuffer();
}

/* ── FSM sender state badge: READY while Sn − Sf < Sw, else BLOCKING ── */
function renderSenderState() {
  const blocking = !!sim.view.blocking;
  setText(D.senderState, blocking ? 'BLOCKING' : 'READY');
  D.senderState.className = 'sender-state ' + (blocking ? 'state-blocking' : 'state-ready');
}

/* ── compact label for buffer chips: the protocol sequence number ("Seq 0").
   Within one window it is always unambiguous (Sw < 2^m); the absolute Frame ID
   is given in the chip's tooltip, e.g. "Frame ID 8 → Seq 0". ── */
const bufChipLabel = k => `Seq ${seqOf(k)}`;

/* ── stored copies of outstanding (sent, unacknowledged) frames — FSM
       rule: "a copy of the packet is stored" until it is acknowledged ── */
function renderSenderBuffer() {
  const V = sim.view;
  const seqs = [];
  for (let i = V.Sf; i < V.Sn; i++) seqs.push(i);
  D.senderBuffer.innerHTML = seqs.length
    ? seqs.map(i => `<span class="buf-chip" title="${seqExplain(i)}">${bufChipLabel(i)}</span>`).join('')
    : '<span class="buf-empty">— empty —</span>';
}

function updateStats() {
  const s = sim.view.stats;
  setText(D.statDelivered, s.delivered);
  setText(D.statAcked,     s.acked);
  setText(D.statRetx,      s.retx);
  setText(D.statTimeouts,  s.timeouts);
}

/* ── current-event panel ── */
function setEvent(type, icon, title, desc) {
  const body = D.eventBody;
  body.style.animation = 'none';
  void body.offsetWidth;
  body.style.animation = '';
  body.className = `event-body ev-${type}`;
  D.eventIcon.textContent  = icon;
  D.eventTitle.textContent = title;
  D.eventDesc.textContent  = desc;
}

function showEvent(ev) {
  const d = describe(ev);
  setEvent(d.cls, d.icon, d.title, d.desc);
}

function describe(ev) {
  const s = ev.snap, Sw = sim.windowSize, N = sim.totalFrames;

  switch (ev.type) {

    case 'SEND': {
      const out = s.Sn - s.Sf;
      let d = `Sender transmits Frame ID ${ev.seq} / Seq ${seqOf(ev.seq)}${ev.attempt > 1 ? `  (attempt ${ev.attempt})` : ''}. A copy is stored until it is acknowledged.\n` +
              `Sf = ${regLabel(s.Sf)}   |   Sn: ${regLabel(ev.seq)} → ${regLabel(s.Sn)}   |   Sw = ${Sw}\n` +
              `Outstanding: ${out} of ${Sw} allowed.`;
      if (s.Sn >= N)                         d += `\nAll frames have now been sent at least once.`;
      else if (s.blocking)                   d += `\nThe window is now full — the sender moves to BLOCKING and must wait for an ACK or a timeout.`;
      if (ev.timerStarted)                   d += `\nThe single timer starts, tracking ${regLabel(s.Sf)}.`;
      if (ev.retx)                           d += `\n\nGo-Back-N: the timeout rewound Sn to Sf, so every outstanding frame is sent again, in order.`;
      return {
        cls: ev.retx ? 'warning' : 'normal', icon: ev.retx ? '↻' : '📤',
        title: `${ev.retx ? 'RETRANSMIT' : 'SEND'} — Frame ID ${ev.seq} / Seq ${seqOf(ev.seq)}`,
        desc: d,
      };
    }

    case 'LOST': {
      let d = `Frame ID ${ev.seq} / Seq ${seqOf(ev.seq)} was dropped by the network. Nobody is notified — this is a physical loss, not a checksum failure.\n\n` +
              `Receiver still expects Seq ${seqOf(s.Rn)}.\n`;
      if (s.Sn > ev.seq + 1) {
        d += `Frame IDs ${range(ev.seq + 1, s.Sn - 1)} are already in flight behind it; they will arrive out of order and be discarded.\n`;
      }
      d += `The sender's timer keeps running for ${regLabel(s.Sf)}.`;
      return { cls: 'error', icon: '✕', title: `FRAME ID ${ev.seq} / SEQ ${seqOf(ev.seq)} LOST IN CHANNEL`, desc: d };
    }

    case 'CORRUPT': {
      let d = `Frame ID ${ev.seq} / Seq ${seqOf(ev.seq)} reached the receiver, but its checksum fails — the bits were damaged in transit.\n\n` +
              `FSM receiver rule (c): a corrupted packet is silently discarded. No ACK — not even a duplicate — is sent.\n` +
              `Rn stays at Seq ${seqOf(s.Rn)}.\n`;
      if (s.Sn > ev.seq + 1) {
        d += `Frame IDs ${range(ev.seq + 1, s.Sn - 1)} are already in flight behind it; they will arrive out of order and be discarded (with an ACK, unlike this one).\n`;
      }
      d += `The sender's timer keeps running for ${regLabel(s.Sf)} — from the sender's point of view this looks identical to a lost frame.`;
      return { cls: 'error', icon: '⚡', title: `FRAME ID ${ev.seq} / SEQ ${seqOf(ev.seq)} CORRUPTED — discarded, no ACK`, desc: d };
    }

    case 'ACK_LOST':
      return {
        cls: 'error', icon: '✕', title: `ACK ${ev.ackNum} LOST IN CHANNEL`,
        desc:
          `The ACK confirming Seq ${ev.confirmedSeq} was dropped. The sender never hears it.\n\n` +
          `The receiver has already delivered that frame, but the sender cannot know that.\n` +
          `Sf stays ${regLabel(s.Sf)} and the timer keeps running for it.\n\n` +
          `Will it matter? Only if no later cumulative ACK arrives before the timer expires.`,
      };

    case 'ACK_CORRUPT':
      return {
        cls: 'error', icon: '⚡', title: `ACK ${ev.ackNum} CORRUPTED — discarded`,
        desc:
          `This ACK reached the sender, but its checksum fails — the bits were damaged in transit.\n\n` +
          `FSM sender rule (c): a corrupted ACK is discarded, exactly like an ACK that doesn't relate to any ` +
          `outstanding frame. It is ignored — no window slide, no timer change.\n` +
          `Sf stays ${regLabel(s.Sf)} and the timer keeps running for it.\n\n` +
          `Will it matter? Only if no later cumulative ACK arrives before the timer expires.`,
      };

    case 'ARRIVE': {
      const seq         = seqOf(ev.seq);        // wire sequence number this frame carries
      const rnSeqBefore = seqOf(ev.RnBefore);   // Rn (sequence number) before this arrival

      if (ev.accepted) {
        const rnSeqAfter = seqOf(ev.RnAfter);
        return {
          cls: 'success', icon: '📥',
          title: `${ev.retx ? '↻ RETRANSMISSION ARRIVES' : 'FRAME ARRIVES'} — Frame ID ${ev.seq} / Seq ${seq} accepted`,
          desc:
            `Frame ID ${ev.seq} / Seq ${seq} arrived → expected Seq ${rnSeqBefore} → ACCEPT.\n` +
            `Rn advances to Seq ${rnSeqAfter} and ACK ${ev.ackNum} is sent.\n\n` +
            ackMeaning(ev.ackNum),
        };
      }
      if (ev.reason === 'duplicate') {
        return {
          cls: 'warning', icon: '🚫',
          title: `FRAME ID ${ev.seq} / SEQ ${seq} DISCARDED — already delivered`,
          desc:
            `Frame ID ${ev.seq} / Seq ${seq} arrived. This Frame ID was already delivered earlier — ` +
            `the sender resent it only because an earlier ACK never reached it (lost or corrupted).\n` +
            `The copy is discarded; Rn remains at Seq ${rnSeqBefore}.\n\n` +
            `Receiver re-sends ACK ${ev.ackNum}. ${ackMeaning(ev.ackNum)}`,
        };
      }
      return {
        cls: 'error', icon: '🚫',
        title: `FRAME ID ${ev.seq} / SEQ ${seq} DISCARDED — out of order`,
        desc:
          `Frame ID ${ev.seq} / Seq ${seq} arrived → receiver expects Seq ${rnSeqBefore} → ` +
          `Seq ${seq} is out of order → DISCARD.\n` +
          `The receiver window is 1: nothing is buffered. Rn remains at Seq ${rnSeqBefore}.\n\n` +
          `Receiver sends duplicate ACK ${ev.ackNum}. ${ackMeaning(ev.ackNum)}`,
      };
    }

    case 'ACK_ARRIVE': {
      if (ev.slide) {
        const n = ev.SfAfter - ev.SfBefore;
        const allowed = Math.max(0, Math.min(ev.SfAfter + Sw, N) - s.Sn);
        let d = `${ackMeaning(ev.ackNum)}\n\n` +
                `Sf ${regLabel(ev.SfBefore)} → ${regLabel(ev.SfAfter)}   (${n} frame${n > 1 ? 's' : ''} confirmed, window slides ${n}).\n`;
        d += ev.timerAction === 'restart' ? `Timer restarted for the new oldest outstanding frame, ${regLabel(ev.SfAfter)}.\n`
                                          : `Nothing is outstanding — the timer stops.\n`;
        if (ev.coveredLostAck) d += `\nThis single cumulative ACK also covers an earlier ACK that never arrived — no retransmission is needed.\n`;
        if (ev.wasBlocking && !ev.nowBlocking) d += `\nThe sender was BLOCKING (window full); this ACK frees a slot, so it returns to READY.\n`;
        d += allowed > 0 ? `The window now lets the sender transmit ${allowed} more frame${allowed > 1 ? 's' : ''}.`
                         : (s.Sn >= N ? 'All frames have been sent.' : 'The window is still full.');
        return { cls: 'success', icon: '✓', title: `ACK ${ev.ackNum} received — window slides`, desc: d };
      }
      return {
        cls: 'warning', icon: '⚠',
        title: `ACK ${ev.ackNum} received — not related to any outstanding frame, ignored`,
        desc:
          `The modulo distance from Sf = ${regLabel(s.Sf)} to ACK ${ev.ackNum} is either 0 (a duplicate — ` +
          `Sf itself) or larger than the number of frames currently outstanding (a stale ACK): either way ` +
          `it confirms nothing new.\n\n` +
          `FSM rule: an ACK that is corrupted, or whose ackNo doesn't relate to an outstanding frame, is simply discarded.\n` +
          `Sf stays ${regLabel(s.Sf)}, the window does not slide, and the timer keeps running for it.\n` +
          `Go-Back-N does not react to duplicate ACKs; it waits for the timeout.`,
      };
    }

    case 'TIMEOUT': {
      const sfSeq = seqOf(ev.Sf);
      const idList = ev.seqs.join(', ');
      const mapLines = ev.seqs.map(id => `Frame ID ${id} → Seq ${seqOf(id)}`).join('\n');
      return {
        cls: 'error', icon: '⚠',
        title: `TIMEOUT — Timer for Seq ${sfSeq} expired`,
        desc:
          `No ACK covering Seq ${sfSeq} arrived in time.\n\n` +
          `Go-Back-N retransmits every outstanding frame, Sf … Sn−1 — the copies were kept in the sender's buffer for exactly this reason.\n` +
          `Outstanding Frame IDs: ${idList}\n` +
          (mapLines ? `${mapLines}\n` : '') +
          `Sn rewinds to Seq ${sfSeq}; the timer restarts.\n\n` +
          // Explanation only — this is absolute Frame-ID bookkeeping (s.Rn and ev.Sf are
          // unbounded delivered/first-outstanding counts), NOT a sequence-number comparison.
          // The protocol's own ACK handling uses seqDistance() (modulo arithmetic).
          (s.Rn > ev.Sf
            ? `The receiver may already have delivered some of these Frame IDs (${range(ev.Sf, s.Rn - 1)}); the sender cannot know because the ACK was lost or corrupted, so Go-Back-N retransmits them anyway and the receiver will discard the copies.`
            : `Frames after Frame ID ${ev.Sf} must be sent again because the receiver discarded them.`),
      };
    }

    case 'COMPLETE':
      return {
        cls: 'success', icon: '✓', title: 'TRANSMISSION COMPLETE',
        desc: `All ${N} frames were delivered in order and cumulatively acknowledged.\nSf = ${regLabel(N)}   |   nothing outstanding   |   timer stopped.`,
      };
  }
  return { cls: 'normal', icon: '·', title: '', desc: '' };
}

/* ── node glow ── */
function pulseNode(el, color) {
  const cls = color === 'red' ? 'pulse-red' : 'pulse-green';
  el.classList.remove('pulse-red', 'pulse-green');
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 600);
}

function pulseForEvent(ev) {
  switch (ev.type) {
    case 'ARRIVE':      pulseNode(D.receiverBox, ev.accepted ? 'green' : 'red'); break;
    case 'CORRUPT':     pulseNode(D.receiverBox, 'red'); break;
    case 'ACK_ARRIVE':  pulseNode(D.senderBox, ev.slide ? 'green' : 'red'); break;
    case 'ACK_CORRUPT': pulseNode(D.senderBox, 'red'); break;
    case 'TIMEOUT':     pulseNode(D.senderBox, 'red'); break;
  }
}

function injectDynamicStyles() {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes pgreen{0%,100%{box-shadow:none}50%{box-shadow:0 0 22px 5px rgba(0,230,118,.65)}}
    @keyframes pred  {0%,100%{box-shadow:none}50%{box-shadow:0 0 22px 5px rgba(255,61,90,.7)}}
    .pulse-green{animation:pgreen .5s ease}
    .pulse-red  {animation:pred   .5s ease}
  `;
  document.head.appendChild(s);
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */
function attachEventListeners() {
  // Every configuration change rebuilds the whole simulation immediately.
  D.btnWinMinus.addEventListener('click', () => {
    D.windowSizeDisplay.textContent = Math.max(1, (parseInt(D.windowSizeDisplay.textContent, 10) || 4) - 1);
    resetSimulation();
  });
  D.btnWinPlus.addEventListener('click', () => {
    const current   = parseInt(D.windowSizeDisplay.textContent, 10) || 4;
    const attempted = current + 1;
    D.windowSizeDisplay.textContent = Math.min(MAX_SW, attempted);
    resetSimulation();
    // Go-Back-N requires Sw < 2^m. Reject (don't silently allow) an
    // attempt to grow past MAX_SW — surface it, rather than just
    // capping the number with no explanation.
    if (attempted > MAX_SW) {
      setEvent('warning', '⚠', `WINDOW SIZE CAPPED AT ${MAX_SW}`,
        `Go-Back-N requires Sw < 2^m. With m = ${M} sequence bits, SEQ_SPACE = ${SEQ_SPACE}, ` +
        `so the largest valid window is ${MAX_SW}.\n` +
        `A window of ${SEQ_SPACE} or more would let two outstanding frames share the same ` +
        `wire sequence number, which the receiver could not tell apart — so it is rejected.`);
    }
  });
  D.totalFramesInput.addEventListener('change', resetSimulation);
  document.querySelectorAll('input[name="errorMode"]')
    .forEach(r => r.addEventListener('change', resetSimulation));
  D.speedSelect.addEventListener('change', () => {
    sim.stepMs = parseInt(D.speedSelect.value, 10) || 1200;
  });

  D.btnPlay.addEventListener('click',     startPlay);
  D.btnPause.addEventListener('click',    pauseSimulation);
  D.btnStep.addEventListener('click',     stepForward);
  D.btnReset.addEventListener('click',    resetSimulation);
  D.btnRunAgain.addEventListener('click', resetSimulation);

  document.addEventListener('keydown', e => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (sim.finished) break;
        if (sim.autoplay) pauseSimulation(); else startPlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        stepForward();
        break;
      case 'KeyR':
        e.preventDefault();
        resetSimulation();
        break;
    }
  });
}

/* ================================================================
   BOOTSTRAP
   ================================================================ */
function init() {
  populateDomRefs();
  injectDynamicStyles();
  attachEventListeners();
  resetSimulation();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTimeline, NET, SEQ_SPACE, MAX_SW, seqOf, nextSeq, seqDistance };
}
