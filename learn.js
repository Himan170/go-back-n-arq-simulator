/* ================================================================
   GO-BACK-N ARQ — GUIDED LESSON (learn.js)
   The whole app is one guided run of the simulator. This file plays the
   simulator's own timeline for whatever Window size (W), Total frames (N),
   Sequence bits (m), Error Mode, Target frame and Speed are set in the top
   ribbon, and stops at each teaching moment to explain it in the right-hand
   panel.

   The list of concepts is built from what really happens in that run:
     Normal       – no-error walkthrough
     Packet Loss  – the chosen frame is lost → out-of-order → timeout → go back N
     ACK Loss     – the chosen frame's ACK is lost → rescued by a later
                    cumulative ACK, or timeout → go back N → duplicates

   Everything lives in one function so it cannot clash with script.js.
   Globals borrowed from script.js: sim, D, sB, rB, col, yS, yR, resetSimulation,
   startPlay, pauseSimulation. script.js calls window.__learnEvent(ev) after
   every event and window.__learnReset() after every reset.
   ================================================================ */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const CANCEL = { cancelled: true };   // thrown to abandon work that is no longer current
  const FAST_MS = 30;                   // playback speed used while jumping to a concept
  const FAST_ANIM = 0.02;               // same, for the small intro animations

  // Cancelled runs leave a few un-awaited promises behind; they are expected, so stay quiet.
  window.addEventListener('unhandledrejection', e => { if (e.reason === CANCEL) e.preventDefault(); });

  /* ── lesson parameters, read from the simulator ── */
  let M = 8, MB = 3, N = 9, W = 4;      // sequence space, bits, frames, window

  /* ── lesson state ── */
  let concepts = [], cur = 0, done = [];
  let internal = false, fast = false;
  let epoch = 0;
  let auto = false, autoTimer = null, ready = false;   // autoplay: on/off, pending timer, current concept fully shown
  let waiter = null;                    // { at, resolve, reject } while the simulator is playing towards a concept

  /* ================================================================
     SMALL HELPERS
     ================================================================ */
  const lbl = a => (a < M ? `${a}` : `${a % M} (F#${a})`);       // same style as the simulator
  const lblList = arr => arr.map(lbl).join(', ');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const say = t => { $('lCap').textContent = t; };

  const ICON_NEXT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
  const ICON_RESTART = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  const ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/></svg>';
  const ICON_PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/></svg>';
  const ICON_CHEV = '<svg class="l-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  const pad2 = n => String(n).padStart(2, '0');
  const MODE_NAME = { normal: 'Normal run', loss: 'Packet loss run', ackloss: 'ACK loss run', framedelay: 'Frame delay run', ackdelay: 'ACK delay run', framecorrupt: 'Frame corruption run', ackcorrupt: 'ACK corruption run' };

  const speedFactor = () => (fast ? FAST_ANIM : (sim.stepMs || 1200) / 1200);
  const ms = x => Math.max(1, x * speedFactor());

  // Wrap a promise so it throws CANCEL if the lesson restarted or closed meanwhile.
  const g = p => {
    const e = epoch;
    return p.then(
      v => { if (e !== epoch) throw CANCEL; return v; },
      err => { if (e !== epoch) throw CANCEL; throw err; }
    );
  };
  const wait = x => g(new Promise(r => setTimeout(r, ms(x))));

  function setFast(on) {
    fast = on;
    sim.stepMs = on ? FAST_MS : (parseInt(D.speedSelect.value, 10) || 1200);
  }

  /* ================================================================
     ANIMATION PRIMITIVES (used for the intro animations and for the
     emphasis played when a concept is reached). Packets are the
     simulator's own .pkt elements; pulses use the independent `scale`
     property so they never fight any positioning.
     ================================================================ */
  const mkPkt = (cls, label, sub, x, y) => {
    const e = document.createElement('div');
    e.className = 'pkt ' + cls;
    e.innerHTML = `<span>${label}</span><span class="pkt-sub">${sub}</span>`;
    e._x = x; e._y = y;
    e.style.left = x + 'px'; e.style.top = y + 'px';
    D.packetLayer.appendChild(e);
    return e;
  };

  const mv = (el, x, y, dur = 800) => {
    const a = el.animate(
      [{ left: el._x + 'px', top: el._y + 'px' }, { left: x + 'px', top: y + 'px' }],
      { duration: ms(dur), easing: 'ease-in-out', fill: 'both' }
    );
    el._x = x; el._y = y;
    return g(a.finished);
  };

  const pulse = (el, s = 1.2, dur = 600, delay = 0) =>
    g(el.animate([{ scale: 1 }, { scale: s }, { scale: 1 }], { duration: ms(dur), delay: delay * speedFactor() }).finished);

  const shake = (el, dur = 500) =>
    g(el.animate(
      [{ translate: '0 0' }, { translate: '-8px 0' }, { translate: '8px 0' }, { translate: '-5px 0' }, { translate: '0 0' }],
      { duration: ms(dur) }
    ).finished);

  const glow = (el, color = '#f1bc66', dur = 900, delay = 0) =>
    g(el.animate(
      [{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: `0 0 18px 4px ${color}` }, { boxShadow: '0 0 0 0 transparent' }],
      { duration: ms(dur), delay: delay * speedFactor() }
    ).finished);

  const fade = (el, dur = 400) =>
    g(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(dur), fill: 'forwards' }).finished.then(() => el.remove()));

  /* ================================================================
     BUILD THE CONCEPT LIST FROM THE SIMULATOR'S TIMELINE
     Each concept is tied to an event of the real run (`at`), or to no
     event (-1) for the two intro concepts. Concepts are shown in the
     order things happen; ties keep the teaching order (`prio`).
     ================================================================ */
  function buildConcepts() {
    M = sim.seqSpace; MB = sim.mBits; N = sim.totalFrames; W = sim.windowSize;
    const ev = sim.events, mode = sim.mode;

    const find = (pred, from = 0) => { for (let i = from; i < ev.length; i++) if (pred(ev[i])) return i; return -1; };
    const ix = {
      send:    find(e => e.type === 'SEND'),
      full:    find(e => e.type !== 'TIMEOUT' && e.snap.blocking && e.snap.Sn < N),
      arrive:  find(e => e.type === 'ARRIVE'),
      slide:   find(e => e.type === 'ACK_ARRIVE' && e.slide),
      lost:    find(e => e.type === 'LOST'),
      ooo:     find(e => e.type === 'ARRIVE' && e.reason === 'out-of-order'),
      ackLost: find(e => e.type === 'ACK_LOST'),
      rescue:  find(e => e.type === 'ACK_ARRIVE' && e.coveredLostAck),
      timeout: find(e => e.type === 'TIMEOUT'),
      dup:     find(e => e.type === 'ARRIVE' && e.reason === 'duplicate'),
      done:    find(e => e.type === 'COMPLETE'),
      fDelay:  find(e => e.type === 'SEND' && e.delayed),                 // a frame is held back in the channel
      aDelay:  find(e => e.type === 'ARRIVE' && e.ackDelayed),            // the receiver sends an ACK that will be slow
      lateF:   find(e => e.type === 'ARRIVE' && e.late),                  // the delayed frame finally arrives
      lateA:   find(e => e.type === 'ACK_ARRIVE' && e.late),              // the delayed ACK finally arrives
      badF:    find(e => e.type === 'CORRUPT'),                           // a corrupted frame reaches the receiver
      badA:    find(e => e.type === 'ACK_CORRUPT'),                       // a corrupted ACK reaches the sender
    };
    const delayMode = mode === 'framedelay' || mode === 'ackdelay';
    const corruptMode = mode === 'framecorrupt' || mode === 'ackcorrupt';
    // how the sender's missing ACK is described, per fault
    const ackWhy = { ackloss: ['was lost', 'lost'], ackdelay: ['is still travelling', 'delayed'], ackcorrupt: ['arrived corrupted and was discarded', 'corrupted'] };
    const ackFault = ackWhy[mode] || ackWhy.ackloss;
    ix.retx      = ix.timeout >= 0 ? find(e => e.type === 'SEND' && e.retx, ix.timeout) : -1;
    ix.slideSend = ix.slide >= 0 ? find(e => e.type === 'SEND', ix.slide + 1) : -1;

    const toEv = ix.timeout >= 0 ? ev[ix.timeout] : null;
    const resent = [];                    // frames sent again after the timeout
    if (ix.retx >= 0) {
      for (let k = ix.retx; k < ev.length; k++) {
        if (ev[k].type !== 'SEND') continue;
        if (!ev[k].retx) break;
        resent.push(ev[k].seq);
      }
    }

    const C = [];
    const add = (prio, at, c) => C.push({ prio, at, ...c });

    /* ── 1-2: intro concepts (no simulator event needed) ── */
    add(0, -1, {
      t: 'Introduction',
      lead: 'Go-Back-N (GBN) is an Automatic Repeat reQuest (ARQ) protocol that improves on Stop-and-Wait by allowing multiple packets to be in transit before waiting for acknowledgements.',
      exp: 'The <b>sender</b> transmits data packets; the <b>receiver</b> answers with <b>ACKs</b>. Go-Back-N keeps the line busy by sending several packets before waiting for any ACK.',
      async pre() {
        const c = Math.min(4, N - 1);
        say('Sender → channel → Receiver');
        await pulse(D.sndRole, 1.2);
        await pulse(D.chan, 1.03, 500);
        await pulse($('rcvRole'), 1.2);
        const p = mkPkt('data', c % M, 'DATA', col(c), yS());
        const a = mkPkt('ack', 'ACK', 'CUMULATIVE', col(c) + 14, yR());
        await mv(p, p._x, yR(), 900); await fade(p, 300);
        await mv(a, a._x, yS(), 900); await fade(a, 300);
        say('Data goes down, ACKs come back up.');
      }
    });

    add(1, -1, {
      t: 'Sequence numbers',
      lead: 'Every packet carries a number from a limited range.',
      exp: () => `With <b>m = ${MB}</b> bits the numbers run from <b>0 to 2<sup>m</sup>−1 = ${M - 1}</b>, then wrap around. Frame ${M} reuses number 0` +
        (N > M + 1 ? `, Frame ${M + 1} reuses 1.` : '.') +
        (N > M ? '' : ` With only ${N} frames in this run nothing wraps yet — raise N (or lower m) in the ribbon above to see it.`),
      async pre() {
        say(`Numbers 0 … ${Math.min(M, N) - 1}`);
        await Promise.all(sB.map((b, i) => pulse(b, 1.3, 450, i * 140)));
        if (N > M) {
          const wr = [M, M + 1].filter(a => a < N);
          say(`Wrap-around: Frame ${wr[0]} reuses number 0` + (wr.length > 1 ? ` and Frame ${wr[1]} reuses number 1` : ''));
          await Promise.all(wr.map((a, i) => Promise.all([
            glow(sB[a], '#f1bc66', 900, i * 300), pulse(sB[a], 1.4, 700, i * 300), pulse(sB[a - M], 1.4, 700, i * 300)
          ])));
        } else {
          say(`This run has only ${N} frames, so the numbers do not wrap around yet.`);
        }
      }
    });

    /* ── the window and the timer: the first packet goes out ── */
    if (ix.send >= 0) {
      add(2, ix.send, {
        t: 'The send window',
        lead: 'The sender may have only a few unacknowledged packets outstanding.',
        exp: () => `<b>Sf</b> = first outstanding (un-ACKed) packet. <b>Sn</b> = next packet to send. <b>Ssize</b> = window size (max 2<sup>m</sup>−1 = ${M - 1}; here ${W}). Sending is allowed only while <code>Sn − Sf &lt; Ssize</code>.` +
          (W >= N ? ` This run has only ${N} frames, so the window never fills.` : ''),
        cap: e => `Packet ${lbl(e.seq)} is sent: Sn moves to ${lbl(e.snap.Sn)}. The blue bracket is the send window — the sender may keep sending while Sn − Sf < ${W}.`,
        after: () => Promise.all([pulse(D.win, 1.02, 600), pulse(D.tSn, 1.5, 600)])
      });

      add(3, ix.send, {
        t: 'The Timer',
        lead: 'GBN uses one timer — not one per packet.',
        exp: 'Go-Back-N keeps only <b>ONE timer</b>. It watches the <b>oldest outstanding packet (Sf)</b>. Sf is the oldest outstanding packet, so its timer is the first one that can expire — one timer is all GBN needs. While packets are outstanding the timer runs; if an ACK advances Sf, the timer restarts.',
        cap: () => 'The timer started with the first packet and watches Sf — the oldest un-ACKed packet. It keeps running while any packet is outstanding.',
        after: e => Promise.all([pulse(D.tm, 1.15, 700), pulse(D.tSf, 1.5, 700), glow(sB[e.snap.Sf], '#f1bc66', 900)])
      });
    }

    if (ix.full >= 0) {
      add(4, ix.full, {
        t: 'The window fills up',
        lead: 'The sender has to stop and wait.',
        exp: () => `<code>Sn − Sf</code> has reached <b>Ssize = ${W}</b>, so the window is full. No new packet may be sent until an ACK moves <b>Sf</b> forward and slides the window.`,
        cap: e => `Window full! Sn − Sf = Ssize = ${W}. Packet ${lbl(e.snap.Sn)} must wait until an ACK moves Sf forward.`,
        after: () => Promise.all([shake(D.win, 600), pulse(D.tSn, 1.5, 600)])
      });
    }

    /* ── receiver and cumulative ACKs ── */
    if (ix.arrive >= 0) {
      add(5, ix.arrive, {
        t: 'The receiver and Rn',
        lead: 'The receiver only accepts the one packet it is expecting.',
        exp: '<b>Rn</b> is the number of the next in-order packet. A packet whose number equals Rn is delivered and Rn moves forward. Anything else is discarded.',
        cap: e => e.accepted
          ? `Packet ${lbl(e.seq)} arrives. It equals Rn, so it is accepted and Rn moves to ${lbl(e.snap.Rn)}.`
          : `Packet ${lbl(e.seq)} arrives, but the receiver is waiting for ${lbl(e.snap.Rn)} — it is discarded.`,
        after: () => pulse(D.tRn, 1.5, 600)
      });
    }

    if (ix.slide >= 0) {
      add(6, ix.slide, {
        t: 'Cumulative ACKs',
        lead: 'ACK n means "I expect packet n next".',
        exp: 'An ACK carries <b>Rn</b>, not the number just received. It confirms everything <b>before</b> n, so one ACK can cover many packets, even if earlier ACKs were lost.',
        cap: e => `ACK ${e.ackNum} arrives: Sf slides to ${lbl(e.snap.Sf)}, confirming every packet before it. ` +
          (e.snap.timer.active ? 'Packets are still outstanding, so the timer restarts.' : 'Nothing is outstanding now, so the timer stops.'),
        after: () => pulse(D.tSf, 1.4, 600)
      });
    }

    if (mode === 'normal' && ix.slideSend >= 0) {
      add(7, ix.slideSend, {
        t: 'The window slides',
        lead: 'Every ACK frees space, so new packets keep flowing.',
        exp: 'Each cumulative ACK moves <b>Sf</b> forward and slides the window, so the sender immediately sends the next packet without waiting for the others to be acknowledged. Many packets are in flight at once — that pipelining is what makes Go-Back-N faster than Stop-and-Wait.',
        cap: e => `The window slid, so packet ${lbl(e.seq)} can be sent right away.`,
        after: () => pulse(D.win, 1.03, 600)
      });
    }

    /* ── packet loss ── */
    if (ix.lost >= 0) {
      const le = ev[ix.lost];
      add(10, ix.lost, {
        t: 'Packet loss',
        lead: 'The channel can silently destroy a packet.',
        exp: () => `Nobody is notified. The sender only knows that packet ${lbl(le.seq)} has not been acknowledged. Watch what happens because of it.`,
        cap: e => `Packet ${lbl(e.seq)} is LOST in the channel!`,
        after: e => glow(sB[e.seq], '#f3829a', 900)
      });
    }

    if (ix.ooo >= 0) {
      const oe = ev[ix.ooo];
      add(11, ix.ooo, {
        t: 'Out-of-order packets',
        lead: mode === 'framedelay' ? 'Packets after the delayed one arrive first — too early.'
            : mode === 'framecorrupt' ? 'Packets after the corrupted one still arrive, but too early.'
            : 'Packets after a lost one still arrive, but too early.',
        exp: () => `The receiver expects <b>${lbl(oe.snap.Rn)}</b>. A packet that does not match Rn is <b>discarded</b> — the receiver has no buffer for out-of-order data — and it replies with <b>ACK ${oe.snap.Rn % M}</b> again. These repeated ACKs do not move Sf.`,
        cap: e => `Packet ${lbl(e.seq)} arrives: expected ${lbl(e.snap.Rn)} → discarded, the receiver repeats ACK ${e.snap.Rn % M}.`,
        after: () => pulse(D.tRn, 1.5, 600)
      });
    }

    /* ── frame corruption ── */
    if (ix.badF >= 0) {
      const ce = ev[ix.badF];
      add(10, ix.badF, {
        t: 'Corrupted frame',
        lead: 'The frame arrives — but with flipped bits.',
        exp: () => `Noise in the channel flipped some bits of Frame ${lbl(ce.seq)} (it turned violet half-way). Every frame carries a <b>checksum</b>; the receiver recomputes it on arrival and finds a mismatch. A damaged frame cannot be trusted, so the receiver <b>silently discards it</b>: no ACK is sent and <b>Rn does not move</b> — to the sender it looks exactly like a lost frame.`,
        cap: e => `Frame ${lbl(e.seq)} arrives CORRUPTED — the checksum fails, so the receiver discards it.`,
        after: e => Promise.all([glow(sB[e.seq], '#b794f6', 900), pulse(D.tRn, 1.4, 600)])
      });
    }

    /* ── ACK corruption ── */
    if (ix.badA >= 0) {
      const ae = ev[ix.badA];
      add(10, ix.badA, {
        t: 'Corrupted ACK',
        lead: 'The ACK reaches the sender — but damaged.',
        exp: () => `The receiver did accept packet ${lbl(ae.confirmedSeq)} and sent <b>ACK ${ae.ackNum}</b>, but bits were flipped on the way back (it turned violet half-way). The sender checks the <b>checksum</b>, sees a mismatch and <b>ignores the ACK</b>: Sf does not move and the timer is not restarted — exactly as if the ACK had been lost. ` +
          (ix.rescue >= 0
            ? 'Because ACKs are cumulative, a later ACK can still confirm this packet — watch for it.'
            : 'No later ACK follows to cover it, so the sender will eventually time out.'),
        cap: e => `ACK ${e.ackNum} arrives CORRUPTED — the checksum fails, so the sender ignores it.`,
        after: e => Promise.all([glow(sB[e.confirmedSeq], '#b794f6', 900), pulse(D.tSf, 1.4, 600)])
      });
    }

    /* ── frame delay ── */
    if (ix.fDelay >= 0) {
      const fe = ev[ix.fDelay];
      add(10, ix.fDelay, {
        t: 'Delayed frame',
        lead: 'The frame is not lost — it is just very slow.',
        exp: () => `Frame ${lbl(fe.seq)} is sent, but this time the channel holds it back. It is <b>still travelling</b>, yet the sender cannot tell a slow frame from a lost one: it only sees that no ACK comes back while its timer keeps running.`,
        cap: e => `Frame ${lbl(e.seq)} is sent but DELAYED — it is still travelling (dashed outline).`,
        after: e => glow(sB[e.seq], '#f1bc66', 900)
      });
    }

    if (ix.lateF >= 0) {
      const le = ev[ix.lateF];
      add(12, ix.lateF, {
        t: 'The late frame arrives',
        lead: 'Too late — the sender has already given up on it.',
        exp: () => (le.accepted
          ? `The original Frame ${lbl(le.seq)} finally reaches the receiver. It equals <b>Rn</b>, so it is accepted and Rn moves to ${lbl(le.RnAfter)}. `
          : `The original Frame ${lbl(le.seq)} finally reaches the receiver, but it is not the packet Rn expects, so it is discarded. `) +
          'The sender had already timed out and sent another copy, so that retransmission was <b>unnecessary</b>: the frame was never lost. A longer timeout would have avoided the extra traffic.',
        cap: e => e.accepted
          ? `The delayed Frame ${lbl(e.seq)} finally arrives and is accepted — but the sender already resent it.`
          : `The delayed Frame ${lbl(e.seq)} finally arrives, but the receiver expects ${lbl(e.snap.Rn)} — discarded.`,
        after: () => pulse(D.tRn, 1.5, 600)
      });
    }

    /* ── ACK delay ── */
    if (ix.aDelay >= 0) {
      const de = ev[ix.aDelay];
      add(10, ix.aDelay, {
        t: 'Delayed ACK',
        lead: 'The ACK is not lost — it is just very slow.',
        exp: () => `The receiver accepted Frame ${lbl(de.seq)} and answered with <b>ACK ${de.ackNum}</b>, but that ACK is <b>still travelling</b> toward the sender, who cannot tell it from a lost ACK. ` +
          (ix.rescue >= 0
            ? 'A later ACK may reach the sender first and cover it — watch for that.'
            : 'No later ACK will cover it, so the sender may time out before it arrives.'),
        cap: e => `Frame ${lbl(e.seq)} is accepted. ACK ${e.ackNum} is sent back but DELAYED — it is still travelling (dashed outline).`,
        after: () => pulse(D.tRn, 1.5, 600)
      });
    }

    if (ix.lateA >= 0) {
      const ae = ev[ix.lateA];
      add(12, ix.lateA, {
        t: 'The late ACK arrives',
        lead: ae.slide ? 'Too late — the sender already timed out.' : 'Too late to matter — it is no longer needed.',
        exp: () => ae.slide
          ? `ACK ${ae.ackNum} finally reaches the sender and moves Sf to ${lbl(ae.snap.Sf)}. But the sender had already timed out and sent packets again, so those retransmissions were <b>unnecessary</b>: the data had arrived all along, only its ACK was slow.`
          : `ACK ${ae.ackNum} finally reaches the sender, but Sf is already beyond it — a later cumulative ACK covered it long ago. A stale ACK is simply ignored; the slow ACK cost nothing.`,
        cap: e => e.slide
          ? `The delayed ACK ${e.ackNum} finally arrives: Sf moves to ${lbl(e.snap.Sf)} — after the timeout.`
          : `The delayed ACK ${e.ackNum} finally arrives — Sf is already past it, so it is ignored.`,
        after: () => pulse(D.tSf, 1.4, 600)
      });
    }

    /* ── ACK loss ── */
    if (ix.ackLost >= 0) {
      const ae = ev[ix.ackLost];
      // If the first normal ACK arrives right after the lost one (no timeout in between), explain that ACK first
      const lostAt = (ix.slide > ix.ackLost && (ix.timeout < 0 || ix.slide < ix.timeout)) ? ix.slide : ix.ackLost;
      add(10, lostAt, {
        t: 'Lost ACK',
        lead: 'The ACK for a packet disappears on its way back.',
        exp: () => `The receiver did get packet ${lbl(ae.confirmedSeq)} and answered with ACK ${ae.ackNum}, but that ACK was lost, so the sender never hears it. ` +
          (ix.rescue >= 0
            ? 'Because ACKs are cumulative, a later ACK can still confirm this packet — watch for it.'
            : 'No later ACK follows to cover it, so the sender will eventually time out.'),
        cap: () => `ACK ${ae.ackNum} was LOST on its way back to the sender.`,
        after: () => glow(sB[ae.confirmedSeq], '#f1bc66', 900)
      });
    }

    if (ix.rescue >= 0) {
      const re = ev[ix.rescue];
      add(11, ix.rescue, {
        t: 'A later ACK covers it',
        lead: `Cumulative ACKs make a ${mode === 'ackdelay' ? 'slow' : mode === 'ackcorrupt' ? 'corrupted' : 'lost'} ACK harmless.`,
        exp: () => `ACK ${re.ackNum} confirms everything before ${lbl(re.snap.Sf)}, including the packet whose own ACK ${ackFault[0]}. Sf jumps forward by ${re.SfAfter - re.SfBefore} at once and the timer restarts. No timeout and no retransmission were needed.`,
        cap: e => `ACK ${e.ackNum} arrives and covers the ${ackFault[1]} ACK: Sf jumps to ${lbl(e.snap.Sf)}.`,
        after: () => pulse(D.tSf, 1.4, 600)
      });
    }

    /* ── timeout and go-back-N ── */
    if (toEv) {
      add(12, ix.timeout - 1, {
        t: 'The timer is running out',
        lead: 'Sf is stuck — the timer keeps counting down.',
        exp: () => (mode === 'loss' || mode === 'framecorrupt'
          ? `Packet ${lbl(toEv.Sf)} ${mode === 'loss' ? 'was lost' : 'arrived corrupted and was discarded, so it was never acknowledged'}. ` + (ix.ooo >= 0 ? `The receiver keeps replying with <b>ACK ${ev[ix.ooo].snap.Rn % M}</b> (its Rn never moves), but those ACKs do not advance Sf. ` : 'No ACK can advance Sf. ')
          : mode === 'framedelay'
            ? `Frame ${lbl(toEv.Sf)} is still travelling, so nothing can confirm it and Sf cannot move. ` + (ix.ooo >= 0 ? `Later frames that arrive early are discarded and only trigger repeated <b>ACK ${ev[ix.ooo].snap.Rn % M}</b>s. ` : '')
            : mode === 'ackdelay'
              ? `The ACK for packet ${lbl(toEv.Sf)} is still travelling and no later ACK arrives to cover it. `
              : mode === 'ackcorrupt'
              ? `The ACK for packet ${lbl(toEv.Sf)} arrived corrupted and was discarded, and no later ACK arrives to cover it. `
              : `The ACK that would have confirmed packet ${lbl(toEv.Sf)} was lost and no later ACK arrives to cover it. `) +
          'The timer is never restarted, so it keeps counting toward zero.',
        cap: () => `Sf = ${lbl(toEv.Sf)} is stuck — no ACK can advance it. The timer keeps counting down …`,
        after: () => pulse(D.tm, 1.15, 600)
      });

      add(13, ix.timeout, {
        t: 'Timeout',
        lead: 'The timer reaches zero.',
        exp: () => `On timeout the sender assumes the worst: it does <b>not</b> know which packets were lost, so it restarts the timer and prepares to resend <b>every outstanding packet</b> (here ${lblList(toEv.seqs)}), Sf up to Sn − 1.`,
        cap: () => `TIMEOUT! The timer guarding Sf = ${lbl(toEv.Sf)} expired.`,
        after: () => Promise.all([shake(D.tm, 600), ...toEv.seqs.map((a, k) => glow(sB[a], '#f3829a', 800, k * 150))])
      });
    }

    if (ix.retx >= 0) {
      add(14, ix.retx, {
        t: 'Go back N!',
        lead: 'Resend everything from Sf onwards.',
        exp: () => `Packets ${lblList(resent)} are sent again in order (amber). ` +
          (mode === 'loss' || mode === 'framecorrupt'
            ? 'This time they arrive intact and in sequence, Rn advances, and the ACKs slide the window forward. '
            : mode === 'framedelay'
              ? 'But the first of them was never lost — the original is still on its way — so some of these copies are <b>unnecessary</b>. '
              : mode === 'ackdelay'
                ? 'But the receiver already has them — only an ACK was slow — so these copies are <b>unnecessary</b>. '
                : mode === 'ackcorrupt'
                ? 'The receiver already has some of them — only an ACK was corrupted — so it discards those duplicates and answers with its current ACK, letting the sender finally move on. '
                : 'The receiver already has some of them — only an ACK was lost — so it discards those duplicates and answers with its current ACK, letting the sender finally move on. ') +
          'That is <b>Go-Back-N</b>.',
        cap: e => `Going back to Sf = ${lbl(toEv.Sf)}: packet ${lbl(e.seq)} is sent again.`,
        after: () => pulse(D.win, 1.03, 600)
      });
    }

    if (ix.dup >= 0) {
      add(15, ix.dup, {
        t: 'Duplicate packets',
        lead: 'Resent packets the receiver already has.',
        exp: mode === 'framedelay'
          ? 'The delayed original was already delivered when it finally arrived, so this retransmitted copy is a duplicate. The receiver sees a number below Rn, <b>discards it</b>, and answers with its current ACK.'
          : mode === 'ackcorrupt'
            ? 'This packet had already been delivered — only its ACK was corrupted. The receiver sees a number below Rn, <b>discards the duplicate</b>, and answers with its current ACK so the sender can move on.'
          : mode === 'ackdelay'
            ? 'This packet had already been delivered — only its ACK was slow. The receiver sees a number below Rn, <b>discards the duplicate</b>, and answers with its current ACK.'
            : 'This packet had already been delivered — only its ACK was lost. The receiver sees a number below Rn, <b>discards the duplicate</b>, and answers with its current ACK so the sender can move on.',
        cap: e => `Packet ${lbl(e.seq)} arrives again: already delivered, so it is discarded and the receiver repeats ACK ${e.snap.Rn % M}.`,
        after: () => pulse(D.tRn, 1.5, 600)
      });
    }

    /* ── recap ── */
    if (ix.done >= 0) {
      const st = ev[ix.done].snap.stats;
      add(99, ix.done, {
        t: 'You now know Go-Back-N',
        lead: 'Recap of the whole protocol.',
        exp: () => '<b>Sequence numbers</b> label packets · <b>Sf/Sn/Ssize</b> bound the window · <b>Rn</b> accepts only in-order data · <b>ACK n</b> is cumulative · <b>one timer</b> guards Sf · on timeout <b>all outstanding packets are resent</b>.' +
          `<br><br>This run: ${plural(st.retx, 'retransmission')}, ${plural(st.timeouts, 'timeout')}.` +
          (corruptMode ? '<br><br><b>Corruption is detected, not repaired</b>: a failed checksum makes the receiver (or sender) throw the packet away, so Go-Back-N treats it like a loss and recovers with its timer — there is no negative acknowledgement.' : '') +
          (delayMode ? '<br><br>A <b>delay is not a loss</b>: if the timeout is shorter than the delay, Go-Back-N resends packets that were never lost. A later cumulative ACK, or a longer timeout, avoids that waste.' : ''),
        cap: () => `All ${N} packets delivered, in order.`,
        after: () => Promise.all(rB.map((b, k) => pulse(b, 1.25, 500, k * 100)))
      });
    }

    C.sort((a, b) => a.at - b.at || a.prio - b.prio);
    return C;
  }

  // One short line describing what the simulator just did (shown while it plays between concepts)
  function eventCaption(ev) {
    switch (ev.type) {
      case 'SEND':       return ev.retx ? `Retransmit Frame ${ev.seq} (Seq ${ev.wireSeq})`
                                : ev.delayed ? `Send Frame ${ev.seq} (Seq ${ev.wireSeq}) — the channel delays it`
                                : `Send Frame ${ev.seq} (Seq ${ev.wireSeq})`;
      case 'ARRIVE':     return (ev.late ? 'Delayed ' : '') + (ev.accepted ? `Frame ${ev.seq} accepted — Rn advances` : `Frame ${ev.seq} discarded (${ev.reason})`) +
                                (ev.ackDelayed ? ' — its ACK will be delayed' : '');
      case 'LOST':       return `Frame ${ev.seq} lost in the channel`;
      case 'CORRUPT':    return `Frame ${ev.seq} arrives corrupted — checksum fails, discarded`;
      case 'ACK_CORRUPT':return `ACK ${ev.ackNum} arrives corrupted — checksum fails, ignored`;
      case 'ACK_ARRIVE': return (ev.late ? 'Delayed ' : '') + (ev.slide ? `ACK ${ev.ackNum} arrives — the window slides` : `ACK ${ev.ackNum} arrives — a repeat, ignored`);
      case 'ACK_LOST':   return `ACK ${ev.ackNum} lost in the channel`;
      case 'TIMEOUT':    return `Timeout — go back to Sf = ${lbl(ev.Sf)}`;
      case 'COMPLETE':   return 'All frames delivered';
      default:           return '';
    }
  }

  /* ================================================================
     PLAYING THE SIMULATOR UNTIL A CONCEPT'S EVENT
     ================================================================ */
  function runTo(at) {
    return new Promise((resolve, reject) => {
      waiter = { at, resolve, reject };
      startPlay();
    });
  }

  function cancelRun() {
    if (waiter) { const w = waiter; waiter = null; w.reject(CANCEL); }
    pauseSimulation();
  }

  // Called by script.js after every event the simulator commits.
  window.__learnEvent = ev => {
    if (!fast) say(eventCaption(ev));               // live commentary: what the simulator just did
    const i = sim.evIdx - 1;
    if (waiter && i >= waiter.at) {
      const w = waiter; waiter = null;
      pauseSimulation();
      w.resolve();
      return true;
    }
    if (ev.type === 'COMPLETE') { pauseSimulation(); return true; }
    return false;
  };

  /* ================================================================
     LESSON FLOW
     ================================================================ */
  /* ================================================================
     AUTOPLAY — Play button advances through the concepts by itself
     ================================================================ */
  function clearAuto() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }

  function renderPlay() {
    const b = $('lPlay');
    b.innerHTML = auto ? `${ICON_PAUSE} Pause` : `${ICON_PLAY} Play`;
    b.classList.toggle('is-playing', auto);
    b.setAttribute('aria-pressed', auto ? 'true' : 'false');
    b.title = auto ? 'Pause the automatic lesson' : 'Play the whole lesson automatically';
  }

  // Give the learner time to read the explanation before moving on (longer text, slower speed => longer pause).
  function readDelay() {
    const len = ($('lExp').textContent || '').length + ($('lLead').textContent || '').length;
    return Math.min(14000, Math.max(4500, 2500 + len * 30)) * Math.max(0.6, speedFactor());
  }

  function scheduleAuto() {
    clearAuto();
    if (!auto || !ready) return;
    if (cur >= concepts.length - 1) { setAuto(false); return; }   // finished: stop on the last concept
    autoTimer = setTimeout(() => { autoTimer = null; if (auto && ready) next(); }, readDelay());
  }

  function setAuto(on) {
    auto = on;
    renderPlay();
    if (!on) clearAuto();
    else scheduleAuto();
  }

  function togglePlay() {
    if (auto) { setAuto(false); return; }
    if (ready && cur >= concepts.length - 1) {          // lesson already finished: start again from the top
      auto = true; renderPlay();
      play(0);
      return;
    }
    setAuto(true);
  }

  function buildList() {
    $('lList').innerHTML = concepts.map((c, i) =>
      `<li><button type="button" data-i="${i}"><span class="l-num">${pad2(i + 1)}</span>` +
      `<span class="l-name">${c.t}</span>${ICON_CHEV}</button></li>`
    ).join('');
    $('lProg').innerHTML = concepts.map(() => '<i></i>').join('');
    $('lMode').textContent = MODE_NAME[sim.mode] || 'Normal run';
  }

  function renderList() {
    $('lList').querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('current', i === cur);
      li.classList.toggle('done', !!done[i] && i !== cur);
      li.querySelector('.l-num').textContent = done[i] && i !== cur ? '✓' : pad2(i + 1);
    });
    $('lProg').querySelectorAll('i').forEach((seg, i) => seg.classList.toggle('on', i <= cur));

    // keep the current concept visible when the list scrolls
    const L = $('lList'), li = L.children[cur];
    if (li) {
      const r = li.getBoundingClientRect(), lr = L.getBoundingClientRect();
      if (r.bottom > lr.bottom) L.scrollTop += r.bottom - lr.bottom + 4;
      else if (r.top < lr.top) L.scrollTop -= lr.top - r.top + 4;
    }
  }

  async function show(i, my, jumping) {
    const c = concepts[i];
    cur = i;
    $('lStep').textContent = `CONCEPT ${i + 1} / ${concepts.length}`;
    $('lTtl').textContent = c.t;
    $('lLead').textContent = c.lead;
    $('lExp').innerHTML = '';
    $('lExp').classList.add('l-dim');
    $('lGo').disabled = true;
    $('lPrev').disabled = true;
    ready = false;
    clearAuto();
    renderList();

    try {
      if (c.at >= 0 && sim.evIdx <= c.at) {          // the simulator has not reached this event yet
        if (jumping) { setFast(true); say('Fast-forwarding to this concept …'); }
        try { await runTo(c.at); }
        finally { if (my === epoch) setFast(false); }
      }
      if (my !== epoch) return;
      const e = c.at >= 0 ? sim.events[c.at] : null;
      say(c.cap ? c.cap(e) : '');
      if (c.pre) await c.pre(); else if (c.after) await c.after(e);
    } catch (err) {
      if (err === CANCEL) return;
      throw err;
    }
    if (my !== epoch) return;

    $('lExp').innerHTML = typeof c.exp === 'function' ? c.exp() : c.exp;
    $('lExp').classList.remove('l-dim');
    $('lGo').innerHTML = i === concepts.length - 1 ? `Restart lesson ${ICON_RESTART}` : `Next ${ICON_NEXT}`;
    $('lGo').disabled = false;
    $('lPrev').disabled = i === 0;
    done[i] = true;
    ready = true;
    renderList();
    scheduleAuto();
  }

  // Start (or jump) the lesson at concept k: rebuild the run from the ribbon, then play up to concept k.
  async function play(k) {
    const my = ++epoch;
    ready = false;
    clearAuto();
    cancelRun();
    setFast(false);
    internal = true; resetSimulation(); internal = false;
    concepts = buildConcepts();
    buildList();
    done = concepts.map((_, i) => i < k);
    say('');
    try { await show(Math.min(k, concepts.length - 1), my, k > 0); }
    catch (e) { if (e !== CANCEL) console.error(e); }
  }

  function next() {
    if ($('lGo').disabled) return;
    if (cur >= concepts.length - 1) play(0);
    else show(cur + 1, epoch, false).catch(e => { if (e !== CANCEL) console.error(e); });
  }

  function prev() {
    if ($('lPrev').disabled || cur === 0) return;
    play(cur - 1);
  }

  function init() {
    $('lList').addEventListener('click', e => {
      const b = e.target.closest('button[data-i]');
      if (b) play(parseInt(b.dataset.i, 10));
    });
    $('lGo').addEventListener('click', next);
    $('lPrev').addEventListener('click', prev);
    $('lPlay').addEventListener('click', togglePlay);
    renderPlay();

    // script.js calls this at the end of every resetSimulation: the ribbon (W, N, m, error, target) changed
    window.__learnReset = () => {
      if (internal) return;
      setAuto(false);                                  // configuration changed: stop autoplay
      play(0);
    };

    document.addEventListener('keydown', e => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    });

    play(0);   // the lesson starts as soon as the page loads
  }

  // script.js initialises on DOMContentLoaded (registered first), so D exists by the time this runs
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
