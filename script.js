/* ================================================================
   GO-BACK-N ARQ SIMULATOR — script.js
   Full Discrete-Event Engine & Dynamic Vertical Sliding-Window UI
   ================================================================ */

'use strict';

/* ================================================================
   SIMULATION CONFIGURATION & STATE
   ================================================================ */
const NET = { TX: 1, D: 3, A: 3, TIMEOUT: 10 };

/* Delay faults. A delayed packet normally takes a few units to cross; a delayed one is held back long enough
   for the sender's timer to beat it. If a timeout happens while it is still travelling, its arrival is retimed
   to land HOLD units after the timeout (so the late original and the retransmitted copy never overlap). */
const DELAY = { FRAME_FALLBACK: 40, ACK_FALLBACK: 18, HOLD_FRAME: 1.5, HOLD_ACK: 2 };

const sim = {
  // Configurable Parameters
  mBits:        3,          // Sequence bits (m) -> 2, 3, 4
  seqSpace:     8,          // 2^m
  maxSw:        7,          // 2^m - 1
  windowSize:   4,          // Sw
  totalFrames:  9,          // N (dynamic single source of truth!)
  mode:         'normal',   // 'normal' | 'loss' | 'ackloss' | 'framedelay' | 'ackdelay' | 'framecorrupt' | 'ackcorrupt'
  targetFrame:  1,          // Which frame or ACK is affected
  stepMs:       1200,       // Real ms per unit for playback speed

  // Timeline & Playback
  events:       [],
  packets:      [],
  evIdx:        0,
  vt:           0,
  target:       null,
  dwellLeft:    0,
  autoplay:     false,
  advance:      false,
  finished:     false,
  raf:          null,
  lastTs:       null,

  // Current view snapshot & last event
  view:         null,
  lastEvent:    null,

};

/* ================================================================
   MODULO SEQUENCE ARITHMETIC (Dynamic according to mBits)
   ================================================================ */
const seqOf = (k, space = sim.seqSpace) => ((k % space) + space) % space;
const nextSeq = (seq, space = sim.seqSpace) => (seq + 1) % space;
const seqDistance = (from, to, space = sim.seqSpace) => ((to - from) % space + space) % space;

const regLabel = (k, space = sim.seqSpace) => `Seq ${seqOf(k, space)}` + (k >= space ? ` (F#${k})` : '');

/* ================================================================
   DISCRETE-EVENT ENGINE (Pure Logic Timeline Generator)
   ================================================================ */
function buildTimeline(cfg) {
  const M         = cfg.mBits || 3;
  const SEQ_SPACE = 1 << M;
  const MAX_SW    = SEQ_SPACE - 1;
  const N         = cfg.totalFrames;
  const Sw        = Math.min(cfg.windowSize, MAX_SW);
  const { TX, D, A, TIMEOUT } = NET;

  const mode = cfg.mode || 'normal';
  const targetFrame = Math.max(0, Math.min(N - 1, cfg.targetFrame !== undefined ? cfg.targetFrame : 1));

  // Channel fault configuration
  const dataFault   = new Map(); // "frameId#attempt" -> 'lost'
  const ackFault    = new Map(); // frameId -> 'lost'
  const lostAckNums = new Set();

  if (mode === 'loss') {
    dataFault.set(`${targetFrame}#1`, 'lost');
  } else if (mode === 'ackloss') {
    ackFault.set(targetFrame, 'lost');
  } else if (mode === 'framedelay') {
    dataFault.set(`${targetFrame}#1`, 'delay');
  } else if (mode === 'ackdelay') {
    ackFault.set(targetFrame, 'delay');
  } else if (mode === 'framecorrupt') {
    dataFault.set(`${targetFrame}#1`, 'corrupt');     // crosses the whole channel, then fails its checksum
  } else if (mode === 'ackcorrupt') {
    ackFault.set(targetFrame, 'corrupt');
  }
  const isDelay = mode === 'framedelay' || mode === 'ackdelay';
  const delayedWaiting = [];   // delayed packets (their queue entry is retimed when a timeout happens first)
  let allAcked = false;        // delay modes: the sender has everything, the channel still drains

  // Protocol state registers (absolute indices for array indexing)
  let sfAbs = 0, snAbs = 0, rnAbs = 0, lastAck = -1;
  let highest = 0;
  let retransmitting = false;
  let txFree = 0;
  let pumpPending = false;
  let tokenCounter = 0;
  let timer = { active: false, seq: -1, start: 0, dur: TIMEOUT, token: 0 };
  const states   = Array(N).fill('waiting');
  const attempts = Array(N).fill(0);
  const stats    = { delivered: 0, acked: 0, retx: 0, timeouts: 0 };

  const events  = [];
  const packets = [];

  // Priority Queue
  const q = [];
  let order = 0;
  const PRI = { ARRIVE: 0, LOST: 0, CORRUPT: 0, ACK_LOST: 1, ACK_ARRIVE: 1, ACK_CORRUPT: 1, TIMEOUT: 2, PUMP: 3 };
  const schedule = (t, kind, data) => { const e = { t, kind, pri: PRI[kind], n: order++, data }; q.push(e); return e; };
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
    blocking: retransmitting || seqDistance(seqOf(sfAbs, SEQ_SPACE), seqOf(snAbs, SEQ_SPACE), SEQ_SPACE) >= Sw,
  });

  const emit = (type, t, extra) => events.push({ type, t, ...extra, snap: snap() });

  const outstandingCount = () => seqDistance(seqOf(sfAbs, SEQ_SPACE), seqOf(snAbs, SEQ_SPACE), SEQ_SPACE);
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

  function stopTimer() {
    timer = { ...timer, active: false };
  }

  function doSend(t) {
    const frameId = snAbs;
    const seq     = seqOf(frameId, SEQ_SPACE);
    attempts[frameId]++;
    const attempt = attempts[frameId];
    const retx    = frameId < highest;
    highest       = Math.max(highest, frameId + 1);

    const fault = dataFault.get(`${frameId}#${attempt}`);
    if (fault) dataFault.delete(`${frameId}#${attempt}`);
    const lost    = fault === 'lost';
    const delayed = fault === 'delay';
    const corrupt = fault === 'corrupt';

    snAbs++;
    states[frameId] = retx ? 'retx' : 'sent';
    if (retx) stats.retx++;

    let timerStarted = false;
    if (!timer.active) {
      startTimer(t, sfAbs);
      timerStarted = true;
    }

    const pkt = {
      kind: 'data', seq: frameId, wireSeq: seq, retx, lost, delayed, corrupt, discarded: false,
      t0: t, t1: lost ? t + D / 2 : delayed ? t + DELAY.FRAME_FALLBACK : t + D, frac: lost ? 0.5 : 1,
      startEv: events.length, endEv: Infinity, el: null, markerEl: null,
    };
    packets.push(pkt);

    const arrivalKind = lost ? 'LOST' : corrupt ? 'CORRUPT' : 'ARRIVE';
    const entry = schedule(pkt.t1, arrivalKind, { seq: frameId, wireSeq: seq, pkt, retx });
    if (delayed) { pkt.entry = entry; delayedWaiting.push(pkt); }

    emit('SEND', t, { seq: frameId, wireSeq: seq, retx, attempt, timerStarted, delayed, corrupt });
    txFree = t + TX;
  }

  // Initial event pump
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
        emit('LOST', t, { seq, wireSeq: seqOf(seq, SEQ_SPACE) });
        break;
      }

      case 'CORRUPT': {
        // The frame reaches the receiver, but its checksum fails: it is discarded silently (no ACK, Rn unchanged).
        const { seq, pkt } = ev.data;
        states[seq] = 'discarded';
        pkt.endEv = events.length;
        emit('CORRUPT', t, { seq, wireSeq: seqOf(seq, SEQ_SPACE) });
        break;
      }

      case 'ARRIVE': {
        const { seq: frameId, wireSeq, pkt, retx } = ev.data;
        const RnBeforeAbs = rnAbs;
        const RnMod = seqOf(rnAbs, SEQ_SPACE);
        let accepted = false, reason = '';

        if (wireSeq === RnMod) {
          accepted = true;
          rnAbs++;
          stats.delivered = rnAbs;
          states[frameId] = 'received';
        } else if (frameId < rnAbs) {
          reason = 'duplicate';
          if (states[frameId] !== 'acked') states[frameId] = 'received';
        } else {
          reason = 'out-of-order';
          states[frameId] = 'discarded';
        }

        const RnAfterMod = accepted ? nextSeq(RnMod, SEQ_SPACE) : RnMod;
        const RnAfterAbs = rnAbs;
        lastAck = RnAfterMod;
        if (!accepted) pkt.discarded = true;
        pkt.endEv = events.length;

        const ackFaultKind = accepted ? ackFault.get(frameId) : undefined;
        if (ackFaultKind) ackFault.delete(frameId);
        const ackLost    = ackFaultKind === 'lost';
        const ackDelayed = ackFaultKind === 'delay';
        const ackCorrupt = ackFaultKind === 'corrupt';
        if (ackLost || ackDelayed || ackCorrupt) lostAckNums.add(RnAfterAbs);   // numbers the sender will not hear in time

        const ack = {
          kind: 'ack', ackNum: RnAfterMod, confirmedSeq: frameId, dup: !accepted,
          lost: ackLost, delayed: ackDelayed, corrupt: ackCorrupt,
          t0: t, t1: ackLost ? t + A / 2 : ackDelayed ? t + DELAY.ACK_FALLBACK : t + A, frac: ackLost ? 0.5 : 1,
          startEv: events.length, endEv: Infinity, el: null, markerEl: null,
        };
        packets.push(ack);

        const ackKind = ackLost ? 'ACK_LOST' : ackCorrupt ? 'ACK_CORRUPT' : 'ACK_ARRIVE';
        const ackEntry = schedule(ack.t1, ackKind, { ackNum: RnAfterMod, confirmedSeq: frameId, pkt: ack });
        if (ackDelayed) { ack.entry = ackEntry; delayedWaiting.push(ack); }

        emit('ARRIVE', t, {
          seq: frameId, wireSeq, accepted, reason, retx,
          late: !!pkt.delayed, ackDelayed, ackCorrupt,
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
        // The ACK reaches the sender, but its checksum fails: it is ignored (Sf and the timer are untouched).
        const { ackNum, confirmedSeq, pkt } = ev.data;
        pkt.endEv = events.length;
        emit('ACK_CORRUPT', t, { ackNum, confirmedSeq });
        break;
      }

      case 'ACK_ARRIVE': {
        const { ackNum, pkt } = ev.data;
        pkt.endEv = events.length;
        const SfBefore = sfAbs;
        const sfSeq    = seqOf(sfAbs, SEQ_SPACE);
        const snSeq    = seqOf(snAbs, SEQ_SPACE);
        const wasBlocking = retransmitting || seqDistance(sfSeq, snSeq, SEQ_SPACE) >= Sw;
        let slide = false, timerAction = 'continue';

        const outstanding = seqDistance(sfSeq, snSeq, SEQ_SPACE);
        const advance     = seqDistance(sfSeq, ackNum, SEQ_SPACE);

        if (advance > 0 && advance <= outstanding) {
          slide = true;
          retransmitting = false;
          for (let k = sfAbs; k < sfAbs + advance && k < N; k++) states[k] = 'acked';
          sfAbs += advance;
          stats.acked = sfAbs;
          if (snAbs < sfAbs) snAbs = sfAbs;
          if (sfAbs < snAbs) {
            startTimer(t, sfAbs);
            timerAction = 'restart';
          } else {
            stopTimer();
            timerAction = 'stop';
          }
        }

        const nowBlocking = seqDistance(seqOf(sfAbs, SEQ_SPACE), seqOf(snAbs, SEQ_SPACE), SEQ_SPACE) >= Sw;
        const coveredLostAck = slide && [...lostAckNums].some(a => a > SfBefore && a < sfAbs);

        emit('ACK_ARRIVE', t, {
          ackNum, slide, SfBefore, SfAfter: sfAbs, timerAction,
          isDupAck: pkt.dup, coveredLostAck,
          wasBlocking, nowBlocking,
          late: !!pkt.delayed, afterTimeout: !!pkt.retimed,
        });

        if (slide) requestPump(t);
        if (sfAbs >= N) {
          if (isDelay) {
            allAcked = true;          // let slow packets finish crossing before the run is declared complete
          } else {
            emit('COMPLETE', t, {});
            done = true;
          }
        }
        break;
      }

      case 'TIMEOUT': {
        if (!(timer.active && timer.token === ev.data.token)) break;
        stats.timeouts++;
        const SnOld = snAbs;
        const seqs = [];
        for (let k = sfAbs; k < snAbs; k++) seqs.push(k);
        snAbs = sfAbs; // Go back to Sf!
        retransmitting = true;
        startTimer(t, sfAbs);
        emit('TIMEOUT', t, { Sf: sfAbs, SnOld, seqs });
        retransmitting = false;

        // a delayed packet that is still travelling will now arrive just after this timeout
        for (const dp of delayedWaiting) {
          if (dp.retimed || !q.includes(dp.entry)) continue;
          if (dp.kind === 'data' && !(dp.seq >= sfAbs && dp.seq < SnOld)) continue;
          dp.retimed = true;
          dp.entry.t = t + (dp.kind === 'data' ? DELAY.HOLD_FRAME : DELAY.HOLD_ACK);
          dp.t1 = dp.entry.t;
        }
        requestPump(t);
        break;
      }
    }

    if (allAcked && !done && !q.some(e => e.kind !== 'PUMP' && e.kind !== 'TIMEOUT')) {
      emit('COMPLETE', t, {});
      done = true;
    }
  }

  if (!done) {
    emit('COMPLETE', events.length ? events[events.length - 1].t : 0, {});
  }

  return { events, packets };
}

/* ================================================================
   DOM REFERENCES & CACHE
   ================================================================ */
let D = {};

function populateDomRefs() {
  const $ = id => document.getElementById(id);
  D = {
    // Config ribbon
    btnWinMinus: $('btnWinMinus'), btnWinPlus: $('btnWinPlus'), windowSizeDisplay: $('windowSizeDisplay'),
    btnFramesMinus: $('btnFramesMinus'), btnFramesPlus: $('btnFramesPlus'), totalFramesInput: $('totalFramesInput'),
    seqBitsSelect: $('seqBitsSelect'), errorModeSelect: $('errorModeSelect'),
    faultTargetSelect: $('faultTargetSelect'), targetCell: $('targetCell'), speedSelect: $('speedSelect'),

    // Stage
    inContainer: $('in'), stage: $('stage'),
    sndRole: $('sndRole'), senderStateBadge: $('senderStateBadge'),
    tm: $('tm'), timerTrack: $('timerTrack'), tb: $('tb'), timerStatusBadge: $('timerStatusBadge'), timerTarget: $('timerTarget'),
    sS: $('sS'), rS: $('rS'), win: $('win'), winLabel: $('winLabel'),
    tSf: $('tSf'), tSn: $('tSn'), tRn: $('tRn'),
    chan: $('chan'), packetLayer: $('packetLayer'),
    rxExpectedVal: $('rxExpectedVal'), rxLastAckVal: $('rxLastAckVal'),
    chips: $('chips'),
    chanStatus: $('chanStatus'), stageStatus: $('stageStatus'), stageStatusText: $('stageStatusText'),
    maxWNote: $('maxWNote'), targetHint: $('targetHint'), modeHint: $('modeHint'),
  };
}

/* ================================================================
   UI CONFIG & RESET
   ================================================================ */
function populateTargetDropdown() {
  const sel = D.faultTargetSelect;
  const currentVal = parseInt(sel.value, 10);
  sel.innerHTML = '';
  for (let i = 0; i < sim.totalFrames; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Frame ${i} (Seq ${seqOf(i)})`;
    if (i === (Number.isFinite(currentVal) ? Math.min(currentVal, sim.totalFrames - 1) : 1)) {
      opt.selected = true;
    }
    sel.appendChild(opt);
  }
}

function readConfigFromUI() {
  sim.mBits = parseInt(D.seqBitsSelect.value, 10) || 3;
  sim.seqSpace = 1 << sim.mBits;
  sim.maxSw = sim.seqSpace - 1;

  let sw = parseInt(D.windowSizeDisplay.textContent, 10) || 4;
  sw = Math.max(1, Math.min(sim.maxSw, sw));
  sim.windowSize = sw;
  D.windowSizeDisplay.textContent = sw;

  let n = parseInt(D.totalFramesInput.value, 10);
  if (!Number.isFinite(n)) n = 9;
  sim.totalFrames = Math.max(5, Math.min(20, n));
  D.totalFramesInput.value = sim.totalFrames;

  sim.mode = D.errorModeSelect.value || 'normal';
  sim.targetFrame = parseInt(D.faultTargetSelect.value, 10);
  if (isNaN(sim.targetFrame)) sim.targetFrame = 1;

  sim.stepMs = parseInt(D.speedSelect.value, 10) || 1200;

  // Toggle Target selector availability based on Error Mode
  const noFault = sim.mode === 'normal';
  D.targetCell.classList.toggle('is-disabled', noFault);
  D.faultTargetSelect.disabled = noFault;
  const MODE_INFO = {
    normal:     { hint: 'Loss, delay or corruption',  target: 'Available when a fault is selected' },
    loss:       { hint: 'A frame is destroyed in the channel',    target: 'The packet that will be lost' },
    ackloss:    { hint: 'An ACK is destroyed in the channel',     target: 'The ACK that will be lost' },
    framedelay: { hint: "Frame is still travelling. It may arrive after the sender's timeout, causing unnecessary retransmission.",
                  target: 'The frame that will be delayed' },
    ackdelay:   { hint: 'ACK is still travelling toward the sender. The sender may timeout before receiving it.',
                  target: 'The frame whose ACK will be delayed' },
    framecorrupt: { hint: "Frame arrives with flipped bits. The receiver's checksum fails, so it is discarded and never acknowledged.",
                  target: 'The frame that will be corrupted' },
    ackcorrupt: { hint: "ACK arrives with flipped bits. The sender's checksum fails, so the ACK is ignored.",
                  target: 'The frame whose ACK will be corrupted' },
  };
  const info = MODE_INFO[sim.mode] || MODE_INFO.normal;
  D.modeHint.textContent = info.hint;
  D.targetHint.textContent = info.target;
  D.maxWNote.textContent = `Maximum W = 2ᵐ − 1 = ${sim.maxSw}`;
}

function initialView() {
  return {
    Sf: 0, Sn: 0, Rn: 0, lastAck: -1,
    states: Array(sim.totalFrames).fill('waiting'),
    stats:  { delivered: 0, acked: 0, retx: 0, timeouts: 0 },
    timer:  { active: false, seq: -1, start: 0, dur: NET.TIMEOUT, token: 0 },
    blocking: false,
  };
}

let sB = [], rB = [];

/* A packet box shows its sequence number with the frame index underneath (F8 · wrap once the numbers repeat). */
function boxHTML(i) {
  const wrap = (i >= sim.seqSpace && sim.totalFrames <= 12) ? ' · wrap' : '';   // too narrow for the extra word with many frames
  return `<span class="bx-n">${seqOf(i)}</span><span class="bx-f">F${i}${wrap}</span>`;
}

function buildStrips() {
  D.inContainer.style.setProperty('--n', sim.totalFrames);
  D.inContainer.style.setProperty('--pitch', sim.totalFrames > 12 ? '44px' : '56px');   // narrower boxes when there are many
  D.sS.innerHTML = '';
  D.rS.innerHTML = '';
  sB = [];
  rB = [];

  for (let i = 0; i < sim.totalFrames; i++) {
    // Sender box
    const sb = document.createElement('div');
    sb.className = 'box';
    sb.id = `sBox-${i}`;
    sb.innerHTML = boxHTML(i);
    sb.title = `Frame ID ${i} → Protocol Seq ${seqOf(i)}`;
    D.sS.appendChild(sb);
    sB.push(sb);

    // Receiver box
    const rb = document.createElement('div');
    rb.className = 'box';
    rb.id = `rBox-${i}`;
    rb.innerHTML = boxHTML(i);
    rb.title = `Frame ID ${i} → Protocol Seq ${seqOf(i)}`;
    D.rS.appendChild(rb);
    rB.push(rb);
  }
}

function resetSimulation() {
  if (sim.raf) { cancelAnimationFrame(sim.raf); sim.raf = null; }
  sim.lastTs = null;

  sim.autoplay = false;
  sim.advance  = false;
  sim.finished = false;
  sim.vt = 0;
  sim.target = null;
  sim.dwellLeft = 0;
  sim.evIdx = 0;
  sim.lastEvent = null;

  readConfigFromUI();
  populateTargetDropdown();
  sim.targetFrame = Math.min(parseInt(D.faultTargetSelect.value, 10) || 0, sim.totalFrames - 1);
  buildStrips();

  const tl = buildTimeline({
    mBits: sim.mBits,
    totalFrames: sim.totalFrames,
    windowSize: sim.windowSize,
    mode: sim.mode,
    targetFrame: sim.targetFrame,
  });

  sim.events  = tl.events;
  sim.packets = tl.packets;
  sim.view    = initialView();

  D.packetLayer.innerHTML = '';
  updateDisplay();
  renderPackets();
  renderTimer();

  // learn.js restarts the lesson whenever the ribbon (W, N, m, error mode, target) changes
  if (typeof window.__learnReset === 'function') window.__learnReset();
}

/* ================================================================
   PLAYBACK ENGINE (Virtual-Time Clock & Animation Loop)
   ================================================================ */
const unitMs  = () => sim.stepMs / 3;
const dwellMs = () => sim.stepMs * 0.45;

function ensureLoop() {
  if (!sim.raf) { sim.lastTs = null; sim.raf = requestAnimationFrame(tick); }
}

function startPlay() {
  if (sim.finished) return;
  sim.autoplay = true;
  sim.advance  = true;
  ensureLoop();
}

function pauseSimulation() {
  sim.autoplay = false;
  sim.advance  = false;
}

function tick(ts) {
  sim.raf = null;
  const dt = sim.lastTs == null ? 0 : Math.min(ts - sim.lastTs, 80);
  sim.lastTs = ts;

  if (sim.advance) {
    if (sim.dwellLeft > 0) {
      sim.dwellLeft -= dt;
    } else {
      if (sim.target === null && sim.evIdx < sim.events.length) {
        sim.target = sim.events[sim.evIdx].t;
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

  renderPackets();
  renderTimer();

  if (sim.advance) {
    sim.raf = requestAnimationFrame(tick);
  } else {
    sim.lastTs = null;
  }
}

function commitEvent() {
  const ev = sim.events[sim.evIdx++];
  sim.view      = ev.snap;
  sim.lastEvent = ev;
  sim.target    = null;

  updateDisplay();

  // learn.js decides whether this event is a teaching moment worth pausing on
  if (typeof window.__learnEvent === 'function' && window.__learnEvent(ev)) return;

  if (ev.type === 'COMPLETE') {
    sim.finished = true;
    sim.autoplay = false;
    sim.advance  = false;
    return;
  }

  if (sim.autoplay) {
    sim.dwellLeft = dwellMs();
  } else {
    sim.advance = false;
  }
}

/* ================================================================
   VISUAL COORDINATES & RENDERING
   ================================================================ */
/* Packets live inside #packetLayer, so their coordinates are measured from it.
   Floating badges and the window bracket live inside their own strip wrappers,
   so they pass that wrapper as the origin (fixes the ~70px vertical offset). */
const PKT_PAD = 30;   // packets enter / leave the channel panel this far from its top / bottom edge

function getOffsets() {
  return D.packetLayer.getBoundingClientRect();
}

function col(i, origin) {
  const idx = Math.max(0, Math.min(i, sim.totalFrames - 1));
  const el = sB[idx];
  if (!el) return 50;
  const o = origin || getOffsets();
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2 - o.left;
}

function yS() {
  return PKT_PAD;
}

function yR() {
  return (D.packetLayer.clientHeight || 200) - PKT_PAD;
}

function yM() {
  return (yS() + yR()) / 2;
}

function updateDisplay() {
  const V = sim.view;
  const N = sim.totalFrames;
  const Sw = sim.windowSize;

  // 1. Update Sender Packet Boxes
  sB.forEach((b, i) => {
    const isDone = i < V.Sf;
    const isOut  = i >= V.Sf && i < V.Sn;
    const inWin  = i >= V.Sf && i < V.Sf + Sw;
    const isRetx = V.states[i] === 'retx';

    b.className = 'box' +
      (isDone ? ' done' : '') +
      (isOut && !isDone ? (isRetx ? ' retx' : ' out') : '') +
      (inWin && !isOut && !isDone ? ' in-win' : '');
  });

  // 2. Update Receiver Packet Boxes
  rB.forEach((b, i) => {
    b.className = 'box' + (i < V.Rn ? ' got' : '');
  });

  // 3. Sender FSM State Badge
  const blocking = !!V.blocking;
  D.senderStateBadge.textContent = blocking ? 'BLOCKING (FULL)' : 'READY';
  D.senderStateBadge.className = 'fsm-badge ' + (blocking ? 'state-blocking' : 'state-ready');

  // 4. Floating pointer labels (Sf, Sn, Rn) — positioned inside their strip wrappers
  const sWrap = D.sS.parentElement.getBoundingClientRect();
  const rWrap = D.rS.parentElement.getBoundingClientRect();
  const boxW  = sB[0] ? sB[0].getBoundingClientRect().width : 52;
  const boxH  = sB[0] ? sB[0].offsetHeight : 66;

  const sfCol = col(V.Sf, sWrap);
  const snCol = col(V.Sn, sWrap);
  const rnCol = col(V.Rn, rWrap);

  const sameCol = Math.min(V.Sf, N - 1) === Math.min(V.Sn, N - 1);   // would be drawn on the same box
  const same = sameCol;                             // one label instead of two stacked ones
  D.tSf.textContent = V.Sf === V.Sn ? 'Sf, Sn ↓' : 'Sf ↓';
  D.tSf.style.left  = sfCol + 'px';
  D.tSn.style.left  = snCol + 'px';
  D.tSn.style.opacity = same ? '0' : '1';
  D.tRn.style.left  = rnCol + 'px';

  // 5. Sliding Window Bracket (#win), drawn under the boxes
  const wStartCol = col(V.Sf, sWrap);
  const wEndIdx   = Math.min(V.Sf + Sw - 1, N - 1);
  const wEndCol   = col(wEndIdx, sWrap);

  const bracketLeft  = wStartCol - boxW / 2;
  const bracketRight = wEndCol + boxW / 2;

  D.win.style.left    = bracketLeft + 'px';
  D.win.style.width   = Math.max(0, bracketRight - bracketLeft) + 'px';
  D.win.style.top     = (boxH + 12) + 'px';
  D.win.style.opacity = V.Sf >= N ? '0' : '1';
  D.winLabel.textContent = `SEND WINDOW · W = ${Sw}`;
  {
    const lw = D.winLabel.offsetWidth, ww = bracketRight - bracketLeft;
    const want = (ww - lw) / 2;                                   // centred under the bracket…
    const minL = -bracketLeft, maxL = sWrap.width - bracketLeft - lw;   // …but never outside the strip
    D.winLabel.style.transform = 'none';
    D.winLabel.style.left = Math.max(minL, Math.min(maxL, want)) + 'px';
  }

  // 6. Receiver Stats
  D.rxExpectedVal.textContent = `Seq ${seqOf(V.Rn)}`;
  D.rxLastAckVal.textContent  = V.lastAck >= 0 ? V.lastAck : '—';

  // 7. Status cards
  const ev = sim.lastEvent;
  const expired = !!(ev && ev.type === 'TIMEOUT');
  const wrapNote = n => (n >= sim.seqSpace ? ` · F#${n}` : '');
  const card = (k, v, cap, cls) =>
    `<div class="stat"><div class="stat-top"><span class="stat-k">${k}</span>` +
    `<span class="stat-v${cls ? ' ' + cls : ''}">${v}</span></div><div class="stat-cap">${cap}</div></div>`;

  D.chips.innerHTML = [
    card('Sf', seqOf(V.Sf), 'First unacknowledged' + wrapNote(V.Sf)),
    card('Sn', seqOf(V.Sn), 'Next frame to send' + wrapNote(V.Sn)),
    card('Window', V.Sf >= N ? '—' : `[${seqOf(V.Sf)}..${seqOf(Math.min(V.Sf + Sw - 1, N - 1))}]`,
         `Sender range · W = ${Sw}`, 'is-blue'),
    card('Rn', seqOf(V.Rn), 'Next expected sequence' + wrapNote(V.Rn)),
    card('Timer', expired ? 'EXPIRED' : V.timer.active ? 'ON' : 'OFF',
         expired ? 'Going back to Sf' : V.timer.active ? `Watching Sf = ${seqOf(V.timer.seq)}` : 'Watching Sf',
         expired ? 'is-red' : V.timer.active ? 'is-amber' : ''),
  ].join('');

  // 8. Stage status pill
  let label = 'INITIAL STATE', cls = '';
  if (ev) {
    if (ev.type === 'COMPLETE')                          { label = 'COMPLETE';  cls = 'is-done'; }
    else if (ev.type === 'SEND' && ev.delayed)           { label = 'FRAME DELAYED'; cls = 'is-warn'; }
    else if (ev.type === 'CORRUPT')                      { label = 'FRAME CORRUPTED'; cls = 'is-warn'; }
    else if (ev.type === 'ACK_CORRUPT')                  { label = 'ACK CORRUPTED';   cls = 'is-warn'; }
    else if (ev.type === 'ARRIVE' && ev.ackDelayed)      { label = 'ACK DELAYED';   cls = 'is-warn'; }
    else if (ev.type === 'TIMEOUT')                      { label = 'TIMEOUT';   cls = 'is-warn'; }
    else if (ev.type === 'LOST' || ev.type === 'ACK_LOST') { label = ev.type === 'LOST' ? 'PACKET LOST' : 'ACK LOST'; cls = 'is-warn'; }
    else                                                 { label = 'IN PROGRESS'; cls = 'is-run'; }
  }
  D.stageStatusText.textContent = label;
  D.stageStatus.className = 'stage-status' + (cls ? ' ' + cls : '');
}

/* ── PACKET ANIMATION ── */
function makePacketEl(p) {
  const el = document.createElement('div');
  if (p.kind === 'data') {
    el.className = `pkt data${p.retx ? ' retx' : ''}${p.delayed ? ' delayed' : ''}`;
    el.innerHTML = `<span>${p.wireSeq}</span>` +
      (p.delayed ? '<span class="pkt-sub">DELAYED</span>'
        : p.retx ? '<span class="pkt-sub">↻RETX</span>' : '<span class="pkt-sub">DATA</span>');
    el.title = `Frame ID ${p.seq} (Seq ${p.wireSeq})`;
  } else {
    el.className = `pkt ack${p.dup ? ' dup-ack' : ''}${p.delayed ? ' delayed' : ''}`;
    el.innerHTML = `<span>ACK ${p.ackNum}</span>` +
      (p.delayed ? '<span class="pkt-sub">DELAYED</span>'
        : p.dup ? '<span class="pkt-sub">DUP</span>' : '<span class="pkt-sub">CUMULATIVE</span>');
    el.title = `Cumulative ACK for Seq ${p.ackNum}`;
  }
  D.packetLayer.appendChild(el);
  return el;
}

/* A corrupted packet is drawn normally until it is half-way, where "bits flip" and it turns violet. */
function applyCorruptLook(p, prog) {
  const bad = prog >= 0.5;
  if (p._bad === bad) return;
  p._bad = bad;
  p.el.classList.toggle('corrupt', bad);
  const sub = p.el.querySelector('.pkt-sub');
  if (sub) {
    if (p._sub === undefined) p._sub = sub.textContent;
    sub.textContent = bad ? 'CORRUPT' : p._sub;
  }
}

function renderPackets() {
  const startY = yS();
  const endY   = yR();
  const midY   = yM();
  const vt     = sim.vt;
  let liveData = 0, liveAck = 0;

  for (const p of sim.packets) {
    const started = sim.evIdx > p.startEv;
    const ended   = sim.evIdx > p.endEv;
    let alive     = started && !ended;

    let fading = false;
    if (p.kind === 'data' && p.discarded && started && ended && vt < p.t1 + 1.2) {
      alive = true; fading = true;
    }

    if (alive) {
      if (!fading) { if (p.kind === 'data') liveData++; else liveAck++; }
      if (!p.el) p.el = makePacketEl(p);
      const prog = Math.max(0, Math.min(1, (vt - p.t0) / (p.t1 - p.t0)));

      let x, y;
      if (p.kind === 'data') {
        x = col(p.seq);
        y = p.lost
          ? startY + (midY - startY) * prog
          : startY + (endY - startY) * prog;
      } else {
        // ACK travels from receiver (bottom) to sender (top)
        x = col(p.confirmedSeq) + 14;
        y = p.lost
          ? endY + (midY - endY) * prog
          : endY + (startY - endY) * prog;
      }

      p.el.style.left = x + 'px';
      p.el.style.top  = y + 'px';
      p.el.classList.toggle('bad', fading);
      if (p.corrupt) applyCorruptLook(p, prog);
    } else if (p.el) {
      p.el.remove();
      p.el = null;
      p._bad = undefined;
    }

    // Checksum-failure marker where a corrupted packet is rejected (receiver end for frames, sender end for ACKs)
    if (p.corrupt) {
      const markerAlive = started && ended && vt < p.t1 + 3.0;
      if (markerAlive) {
        if (!p.markerEl) {
          const m = document.createElement('div');
          m.className = 'chan-marker corrupt-marker';
          m.innerHTML = p.kind === 'ack' ? '⚡ ACK CORRUPT' : '⚡ CHECKSUM ERROR';
          D.packetLayer.appendChild(m);
          p.markerEl = m;
        }
        const x = p.kind === 'data' ? col(p.seq) : col(p.confirmedSeq) + 14;
        p.markerEl.style.left = x + 'px';
        p.markerEl.style.top  = (p.kind === 'data' ? endY - 8 : startY + 8) + 'px';
      } else if (p.markerEl) {
        p.markerEl.remove();
        p.markerEl = null;
      }
    }

    // Mid-Channel Lost Marker
    if (p.lost) {
      const markerAlive = started && ended && vt < p.t1 + 3.0;
      if (markerAlive) {
        if (!p.markerEl) {
          const m = document.createElement('div');
          m.className = 'chan-marker lost-marker';
          m.innerHTML = `✕ ${p.kind === 'ack' ? 'ACK LOST' : 'PACKET LOST'}`;
          D.packetLayer.appendChild(m);
          p.markerEl = m;
        }
        const x = p.kind === 'data' ? col(p.seq) : col(p.confirmedSeq) + 14;
        p.markerEl.style.left = x + 'px';
        p.markerEl.style.top  = midY + 'px';
      } else if (p.markerEl) {
        p.markerEl.remove();
        p.markerEl = null;
      }
    }

  }

  // channel caption + dim the static arrows while something is in flight
  const parts = [];
  if (liveData) parts.push(`${liveData} data frame${liveData > 1 ? 's' : ''}`);
  if (liveAck)  parts.push(`${liveAck} ACK${liveAck > 1 ? 's' : ''}`);
  D.chanStatus.textContent = parts.length ? `${parts.join(' + ')} in transit` : 'Idle · No packets in transit';
  D.chan.classList.toggle('busy', parts.length > 0);
}

/* ── TIMER RENDERING ── */
function renderTimer() {
  const T = sim.view.timer;
  const isTimeout = sim.lastEvent && sim.lastEvent.type === 'TIMEOUT';

  if (isTimeout) {
    D.timerTarget.textContent = `Sf=${seqOf(sim.lastEvent.Sf)}`;
    D.timerStatusBadge.textContent = 'TIMEOUT!';
    D.timerStatusBadge.className = 'timer-status-badge timeout';
    D.tb.style.transform = 'scaleX(1)';
    D.tb.className = 'timer-bar danger';
  } else if (T.active) {
    const prog = Math.max(0, Math.min(1, (sim.vt - T.start) / T.dur));
    D.timerTarget.textContent = `Sf=${seqOf(T.seq)}`;
    D.timerStatusBadge.textContent = 'RUNNING';
    D.timerStatusBadge.className = 'timer-status-badge running';
    D.tb.style.transform = `scaleX(${(1 - prog).toFixed(3)})`;
    D.tb.className = 'timer-bar' + (prog >= 0.8 ? ' danger' : prog >= 0.5 ? ' warning' : '');
  } else {
    D.timerTarget.textContent = 'Sf';
    D.timerStatusBadge.textContent = 'OFF';
    D.timerStatusBadge.className = 'timer-status-badge';
    D.tb.style.transform = 'scaleX(0)';
    D.tb.className = 'timer-bar';
  }
}

/* ================================================================
   EVENT LISTENERS & BINDINGS
   ================================================================ */
function attachEventListeners() {
  // Config: Window Size
  D.btnWinMinus.addEventListener('click', () => {
    const cur = parseInt(D.windowSizeDisplay.textContent, 10) || 4;
    D.windowSizeDisplay.textContent = Math.max(1, cur - 1);
    resetSimulation();
  });
  D.btnWinPlus.addEventListener('click', () => {
    const cur = parseInt(D.windowSizeDisplay.textContent, 10) || 4;
    D.windowSizeDisplay.textContent = Math.min(sim.maxSw, cur + 1);
    resetSimulation();
  });

  // Config: Total Frames
  D.btnFramesMinus.addEventListener('click', () => {
    const cur = parseInt(D.totalFramesInput.value, 10) || 9;
    D.totalFramesInput.value = Math.max(5, cur - 1);
    resetSimulation();
  });
  D.btnFramesPlus.addEventListener('click', () => {
    const cur = parseInt(D.totalFramesInput.value, 10) || 9;
    D.totalFramesInput.value = Math.min(20, cur + 1);
    resetSimulation();
  });
  D.totalFramesInput.addEventListener('change', resetSimulation);

  // Config: Sequence Bits (m)
  D.seqBitsSelect.addEventListener('change', () => {
    const m = parseInt(D.seqBitsSelect.value, 10) || 3;
    const maxAllowed = (1 << m) - 1;
    let currentW = parseInt(D.windowSizeDisplay.textContent, 10) || 4;
    if (currentW > maxAllowed) {
      D.windowSizeDisplay.textContent = maxAllowed;
    }
    resetSimulation();
  });

  // Config: Error Mode & Target
  D.errorModeSelect.addEventListener('change', resetSimulation);
  D.faultTargetSelect.addEventListener('change', resetSimulation);
  D.speedSelect.addEventListener('change', () => {
    sim.stepMs = parseInt(D.speedSelect.value, 10) || 1200;
  });

  window.addEventListener('resize', () => {
    if (sim.view) {
      updateDisplay();
      renderPackets();
    }
  });
}

/* ================================================================
   INITIALIZATION
   ================================================================ */
function init() {
  populateDomRefs();
  populateTargetDropdown();
  attachEventListeners();
  resetSimulation();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
