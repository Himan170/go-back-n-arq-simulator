/* ================================================================
   GO-BACK-N ARQ — THEORY MODAL (theory.js)
   Builds the "Theory" overlay from the sections below and wires the
   header button, close controls, Esc key and contents highlighting.
   ================================================================ */
(function () {
  'use strict';

  const SECTIONS = [
    {
      id: 'intro', title: 'Introduction',
      html: `
        <p><b>Go-Back-N ARQ</b> (Automatic Repeat reQuest) is a <b>sliding window</b> protocol of the data link and transport layers. It lets a sender transmit several frames <b>without waiting for an acknowledgement for each one</b>, while still guaranteeing that every frame is delivered <b>correctly, in order, and without duplicates</b> over an unreliable channel.</p>
        <p>The name describes its recovery rule: when a frame is lost or damaged, the sender "goes back" to the first unacknowledged frame and retransmits it <b>and every frame sent after it</b>, even those that may have arrived safely.</p>
        <h4>Problems the channel can cause</h4>
        <ul>
          <li><b>Frame loss</b> &ndash; a data frame never reaches the receiver.</li>
          <li><b>ACK loss</b> &ndash; the acknowledgement never reaches the sender.</li>
          <li><b>Corruption</b> &ndash; bits are flipped; the CRC/checksum fails and the frame is discarded.</li>
          <li><b>Delay</b> &ndash; a frame or ACK arrives so late that the sender's timer has already expired.</li>
        </ul>
        <p>Go-Back-N solves all of these using <b>sequence numbers, cumulative acknowledgements, a retransmission timer and a bounded sender window</b>.</p>`
    },
    {
      id: 'arq', title: 'ARQ Family',
      html: `
        <p>ARQ protocols turn an unreliable link into a reliable one by retransmitting. All of them use error detection (CRC / checksum), acknowledgements and timeouts. They differ in how many frames may be outstanding and how errors are repaired.</p>
        <div class="tm-table-wrap"><table>
          <tr><th>Protocol</th><th>Sender window</th><th>Receiver window</th><th>On an error</th></tr>
          <tr><td>Stop-and-Wait</td><td>1</td><td>1</td><td>Resend the single frame after timeout</td></tr>
          <tr><td>Go-Back-N</td><td>up to 2<sup>m</sup> &minus; 1</td><td>1</td><td>Resend the lost frame <b>and all after it</b></td></tr>
          <tr><td>Selective Repeat</td><td>up to 2<sup>m&minus;1</sup></td><td>up to 2<sup>m&minus;1</sup></td><td>Resend <b>only</b> the lost frame</td></tr>
        </table></div>
        <p>Go-Back-N sits in the middle: it pipelines transmissions like Selective Repeat, but keeps the receiver as simple as Stop-and-Wait.</p>`
    },
    {
      id: 'why', title: 'Why Go-Back-N?',
      html: `
        <h4>The weakness of Stop-and-Wait</h4>
        <p>Stop-and-Wait sends one frame, then idles until its ACK returns. On a link with a large <b>round-trip time</b>, the sender spends almost all of its time waiting, so the link is badly under-used.</p>
        <div class="tm-formula">Stop-and-Wait utilisation = 1 / (1 + 2a)        where a = T<sub>prop</sub> / T<sub>frame</sub></div>
        <h4>The Go-Back-N idea</h4>
        <p>Keep the pipe full. The sender keeps transmitting up to <code>W</code> frames before it must stop and wait for acknowledgements. While the first ACK is still travelling back, the next frames are already on the wire.</p>
        <div class="tm-note"><b>Pipelining:</b> sending several frames before the earlier ones are acknowledged is what raises efficiency. Window size is the pipeline's capacity.</div>`
    },
    {
      id: 'terms', title: 'Key Terms',
      html: `
        <div class="tm-table-wrap"><table>
          <tr><th>Term</th><th>Meaning</th></tr>
          <tr><td>Frame / packet</td><td>The unit of data sent; carries a sequence number in its header.</td></tr>
          <tr><td>Sequence number</td><td>A number in the range 0 to 2<sup>m</sup> &minus; 1 that identifies each frame (m bits in the header field).</td></tr>
          <tr><td>ACK n</td><td>"I have received everything up to n &minus; 1 and I expect frame n next."</td></tr>
          <tr><td>Cumulative ACK</td><td>One ACK that confirms <b>all</b> earlier frames at once.</td></tr>
          <tr><td>Window (W / S<sub>w</sub>)</td><td>The maximum number of frames the sender may have sent but not yet had acknowledged.</td></tr>
          <tr><td>Timeout</td><td>The time the sender waits for an ACK before assuming loss.</td></tr>
          <tr><td>Retransmission</td><td>Sending a frame again after a timeout.</td></tr>
          <tr><td>Discard</td><td>Dropping a frame without acknowledging it (out-of-order or corrupted).</td></tr>
          <tr><td>RTT</td><td>Round-trip time: frame transmission + propagation both ways + processing.</td></tr>
        </table></div>`
    },
    {
      id: 'seq', title: 'Sequence Numbers',
      html: `
        <p>Each frame carries an <b>m-bit</b> sequence number, so numbers run from <code>0</code> to <code>2<sup>m</sup> &minus; 1</code> and then <b>wrap around</b> (modulo 2<sup>m</sup>).</p>
        <div class="tm-formula">Sequence space = 2<sup>m</sup>
Sequence numbers = 0, 1, 2, &hellip;, 2<sup>m</sup> &minus; 1, 0, 1, &hellip;
next(seq) = (seq + 1) mod 2<sup>m</sup></div>
        <div class="tm-table-wrap"><table>
          <tr><th>m (bits)</th><th>Sequence numbers</th><th>Max window (2<sup>m</sup> &minus; 1)</th></tr>
          <tr><td>2</td><td>0 &ndash; 3</td><td>3</td></tr>
          <tr><td>3</td><td>0 &ndash; 7</td><td>7</td></tr>
          <tr><td>4</td><td>0 &ndash; 15</td><td>15</td></tr>
        </table></div>
        <p>These three settings are exactly what the <b>Sequence bits (m)</b> option in the simulator configuration offers. When the total number of frames exceeds the sequence space, the numbers are reused, shown in the simulator as <code>Seq 1 (F#9)</code>.</p>`
    },
    {
      id: 'window', title: 'Window Size Rule',
      html: `
        <p>In Go-Back-N the sender window must satisfy:</p>
        <div class="tm-formula">W &le; 2<sup>m</sup> &minus; 1</div>
        <p>The receiver window is always <b>1</b>.</p>
        <h4>Why not 2<sup>m</sup>?</h4>
        <p>Take m = 2 (numbers 0&ndash;3) and suppose W = 4. The sender sends frames 0, 1, 2, 3 and all arrive. The receiver now expects frame 0 of the <i>next</i> cycle, and sends <code>ACK 0</code>. If that single ACK is <b>lost</b>:</p>
        <ul>
          <li>The sender times out and retransmits the old frame <b>0</b>.</li>
          <li>The receiver is expecting a <i>new</i> frame 0, so it accepts the old one as new data.</li>
          <li><b>Result: duplicate data is accepted as if it were new.</b> The protocol fails.</li>
        </ul>
        <p>With W = 2<sup>m</sup> &minus; 1 = 3, a retransmitted frame 0 can always be told apart from the next new frame 0, because only 3 of the 4 numbers are ever outstanding.</p>
        <div class="tm-warn"><b>Exam tip:</b> Go-Back-N window &le; 2<sup>m</sup> &minus; 1. Selective Repeat window &le; 2<sup>m&minus;1</sup>. Stop-and-Wait window = 1.</div>
        <p>The simulator enforces this: the window stepper can't go above <b>2<sup>m</sup> &minus; 1</b> (shown as "Maximum W" in the configuration card).</p>`
    },
    {
      id: 'sender', title: 'Sender Side',
      html: `
        <h4>Variables kept by the sender</h4>
        <div class="tm-table-wrap"><table>
          <tr><th>Variable</th><th>Meaning</th></tr>
          <tr><td>S<sub>f</sub></td><td>Sequence number of the <b>first outstanding</b> frame (oldest, not yet acknowledged). Left edge of the window.</td></tr>
          <tr><td>S<sub>n</sub></td><td>Sequence number of the <b>next frame to send</b>. Right edge of the sent region.</td></tr>
          <tr><td>S<sub>w</sub></td><td>Window size (maximum number of outstanding frames).</td></tr>
          <tr><td>Timer</td><td>One timer, running for the <b>oldest</b> outstanding frame (S<sub>f</sub>).</td></tr>
          <tr><td>Buffer</td><td>Copies of all sent-but-unacknowledged frames, kept for possible retransmission.</td></tr>
        </table></div>
        <div class="tm-formula">Outstanding frames = (S<sub>n</sub> &minus; S<sub>f</sub>) mod 2<sup>m</sup>
Sender may send only while  outstanding &lt; S<sub>w</sub></div>
        <h4>Window regions</h4>
        <ul>
          <li><b>Acknowledged</b> &ndash; frames before S<sub>f</sub>; done, can be forgotten.</li>
          <li><b>Sent, not yet acknowledged</b> &ndash; from S<sub>f</sub> up to S<sub>n</sub> &minus; 1; must be buffered.</li>
          <li><b>Can be sent</b> &ndash; from S<sub>n</sub> to S<sub>f</sub> + S<sub>w</sub> &minus; 1; window has room for them.</li>
          <li><b>Cannot be sent</b> &ndash; beyond the window; the sender must wait.</li>
        </ul>
        <h4>Sender algorithm</h4>
        <ol>
          <li>Initialise S<sub>f</sub> = 0, S<sub>n</sub> = 0.</li>
          <li><b>Send:</b> while data is available and S<sub>n</sub> &minus; S<sub>f</sub> &lt; S<sub>w</sub>, build frame S<sub>n</sub>, keep a copy, transmit it, set S<sub>n</sub> = S<sub>n</sub> + 1. Start the timer if it is not already running.</li>
          <li><b>ACK arrives</b> (not corrupted, with ackNo in the valid range): slide the window: S<sub>f</sub> = ackNo. Delete the buffered copies before ackNo. If all frames are now acknowledged, stop the timer; otherwise restart it for the new S<sub>f</sub>.</li>
          <li><b>Timeout:</b> restart the timer and retransmit <b>every</b> outstanding frame from S<sub>f</sub> to S<sub>n</sub> &minus; 1.</li>
          <li><b>Corrupted ACK:</b> ignore it; no action.</li>
        </ol>
        <div class="tm-diagram"><span class="h">sender state machine</span>
READY  <span class="h">--[ data ready & window not full ]--&gt;</span>  send frame Sn, Sn++ , start timer if idle
READY  <span class="h">--[ valid ACK n ]-----------------------&gt;</span>  Sf = n, restart / stop timer
READY  <span class="h">--[ timeout ]--------------------------&gt;</span>  restart timer, resend Sf ... Sn-1
BLOCKED <span class="h">(window full)</span> waits for an ACK or a timeout</div>`
    },
    {
      id: 'receiver', title: 'Receiver Side',
      html: `
        <p>The receiver is deliberately simple. It has <b>window size 1</b> and <b>no buffer</b> for out-of-order frames.</p>
        <h4>Variable kept by the receiver</h4>
        <div class="tm-table-wrap"><table>
          <tr><th>Variable</th><th>Meaning</th></tr>
          <tr><td>R<sub>n</sub></td><td>Sequence number of the <b>next frame expected</b> in order. Initially 0.</td></tr>
        </table></div>
        <h4>Receiver algorithm</h4>
        <ol>
          <li><b>Corrupted frame</b> (CRC fails) &rarr; discard silently. No ACK is sent.</li>
          <li><b>Frame seqNo = R<sub>n</sub></b> (the expected one) &rarr; accept it, deliver it to the upper layer, set R<sub>n</sub> = (R<sub>n</sub> + 1) mod 2<sup>m</sup>, send <code>ACK R<sub>n</sub></code>.</li>
          <li><b>Frame seqNo &ne; R<sub>n</sub></b> (out of order or duplicate) &rarr; <b>discard</b> it and re-send the last ACK (<code>ACK R<sub>n</sub></code>).</li>
        </ol>
        <div class="tm-diagram"><span class="h">receiver state machine</span>
READY  <span class="h">--[ good frame, seq == Rn ]--&gt;</span>  deliver, Rn++, send ACK Rn
READY  <span class="h">--[ good frame, seq != Rn ]--&gt;</span>  discard, (optionally) resend ACK Rn
READY  <span class="h">--[ corrupted frame ]-------&gt;</span>  discard</div>
        <div class="tm-note"><b>Why discard out-of-order frames?</b> Because the receiver has no buffer to hold them. This keeps it trivial, but it is exactly why the sender must resend everything after the missing frame.</div>`
    },
    {
      id: 'ack', title: 'Acknowledgements',
      html: `
        <h4>ACK numbering</h4>
        <p>In this simulator and in most textbooks, <code>ACK n</code> carries the number of the <b>next expected frame</b>. So <code>ACK 4</code> means "frames 0, 1, 2 and 3 are all received; send 4 next."</p>
        <h4>Cumulative acknowledgement</h4>
        <p>One ACK covers every earlier frame. This makes the protocol <b>tolerant of lost ACKs</b>: if ACK 2 is lost but ACK 3 arrives, the sender learns that frames 0, 1 and 2 are all safe.</p>
        <div class="tm-formula">On receiving ACK n:   S<sub>f</sub> &larr; n      (all frames with seq &lt; n are acknowledged)</div>
        <h4>Valid ACK</h4>
        <p>An ACK is only acted on if it falls inside the current window, that is <code>S<sub>f</sub> &lt; ackNo &le; S<sub>n</sub></code> (modulo 2<sup>m</sup>). A stale or duplicate ACK is ignored.</p>
        <h4>No NAK</h4>
        <p>Classic Go-Back-N uses <b>no negative acknowledgements</b>. The sender learns about errors only by <b>timeout</b>. (Some variants add a NAK to trigger an earlier retransmission.)</p>
        <h4>Piggybacking</h4>
        <p>In full-duplex links, an ACK can ride inside a data frame travelling the other way, saving bandwidth. Here ACKs are shown as separate packets for clarity.</p>`
    },
    {
      id: 'timer', title: 'Timer & Timeout',
      html: `
        <p>The sender runs <b>one timer</b>, tied to the oldest unacknowledged frame (S<sub>f</sub>).</p>
        <ul>
          <li><b>Start</b> when a frame is sent and the timer is not running.</li>
          <li><b>Restart</b> when a valid ACK advances S<sub>f</sub> but some frames remain outstanding.</li>
          <li><b>Stop</b> when every outstanding frame has been acknowledged.</li>
          <li><b>Expire</b> &rarr; go back and resend all outstanding frames, then restart.</li>
        </ul>
        <h4>Choosing the timeout value</h4>
        <div class="tm-formula">Timeout &gt; RTT = T<sub>frame</sub> + 2 &times; T<sub>prop</sub> + T<sub>ack</sub> + processing</div>
        <ul>
          <li><b>Too short</b> &rarr; premature timeouts and needless retransmissions, since the ACK was still on its way.</li>
          <li><b>Too long</b> &rarr; slow recovery from real losses, with the link sitting idle.</li>
        </ul>
        <p>The simulator shows this timer as the bar in the sender card, labelled with the frame it is watching (<code>Timer (Sf)</code>).</p>`
    },
    {
      id: 'steps', title: 'Step-by-Step Operation',
      html: `
        <h4>Error-free example: W = 4, N = 8</h4>
        <div class="tm-diagram"><span class="h">Sender                                  Receiver</span>
<span class="d">send F0 ------------------------------&gt;</span>
<span class="d">send F1 ------------------------------&gt;</span>   <span class="h">F0 ok, Rn=1</span>
<span class="d">send F2 ------------------------------&gt;</span>   <span class="a">&lt;---- ACK 1</span>
<span class="d">send F3 ------------------------------&gt;</span>   <span class="h">F1 ok, Rn=2</span>
<span class="h">window full (Sn - Sf = 4), wait</span>         <span class="a">&lt;---- ACK 2</span>
<span class="a">ACK 1 arrives: Sf = 1, window slides</span>
<span class="d">send F4 ------------------------------&gt;</span>   <span class="h">... and so on</span></div>
        <ol>
          <li>The sender fills its window with F0&ndash;F3 without waiting.</li>
          <li>The receiver accepts each frame in order and returns a cumulative ACK.</li>
          <li>Each ACK slides the window forward, freeing room for a new frame.</li>
          <li>The window keeps sliding until all N frames are acknowledged.</li>
        </ol>`
    },
    {
      id: 'loss', title: 'Scenario: Frame Loss',
      html: `
        <p>Suppose W = 4 and <b>frame 1 is lost</b>.</p>
        <div class="tm-diagram"><span class="d">F0 ---&gt;</span>  <span class="h">received, Rn=1</span>   <span class="a">&lt;--- ACK 1</span>
<span class="d">F1 ---X</span>  <span class="x">lost in the channel</span>
<span class="d">F2 ---&gt;</span>  <span class="h">seq 2 != Rn(1): DISCARD</span>   <span class="a">&lt;--- ACK 1</span> <span class="h">(re-sent)</span>
<span class="d">F3 ---&gt;</span>  <span class="h">seq 3 != Rn(1): DISCARD</span>   <span class="a">&lt;--- ACK 1</span> <span class="h">(re-sent)</span>
<span class="r">timer for F1 expires</span>
<span class="r">retransmit F1, F2, F3 ---&gt;</span>  <span class="h">now all in order, Rn advances to 4</span></div>
        <ol>
          <li>F1 is lost, so the receiver keeps waiting for it (R<sub>n</sub> = 1).</li>
          <li>F2 and F3 arrive, but they are out of order, so they are <b>discarded</b>.</li>
          <li>The sender's timer for F1 times out.</li>
          <li>The sender <b>goes back to F1</b> and resends F1, F2, F3, even though F2 and F3 had arrived once.</li>
        </ol>
        <div class="tm-note"><b>Cost:</b> losing one frame wastes the transmission of every frame sent after it within the window.</div>`
    },
    {
      id: 'ackloss', title: 'Scenario: ACK Loss',
      html: `
        <p>Suppose the receiver gets F0, F1, F2 correctly but <b>ACK 1 is lost</b>.</p>
        <div class="tm-diagram"><span class="d">F0 ---&gt;</span>  <span class="h">ok</span>   <span class="x">&lt;--- ACK 1 (lost)</span>
<span class="d">F1 ---&gt;</span>  <span class="h">ok</span>   <span class="a">&lt;--- ACK 2</span>   <span class="h">arrives!</span>
<span class="a">ACK 2 is cumulative: Sf = 2, F0 and F1 both confirmed</span></div>
        <ul>
          <li>If a <b>later ACK</b> arrives before the timer expires, the lost ACK is harmless thanks to cumulative acknowledgement.</li>
          <li>If <b>no later ACK</b> arrives (for example, the last frames of the transfer), the timer expires and the sender retransmits from S<sub>f</sub>. The receiver sees duplicates (seq &ne; R<sub>n</sub>), <b>discards them</b>, and re-sends its ACK, which finally recovers the sender.</li>
        </ul>`
    },
    {
      id: 'delay', title: 'Scenario: Delay & Corruption',
      html: `
        <h4>Frame delay</h4>
        <p>A delayed frame may arrive after the sender has already timed out and retransmitted it. The receiver gets the late original (accepted if in order) and then the retransmitted copy (a duplicate, discarded). Data is delivered once, though bandwidth was wasted.</p>
        <h4>ACK delay</h4>
        <p>If an ACK arrives after the timeout, the sender has already resent the window. The late ACK may still advance S<sub>f</sub> if it is valid, and the extra copies are discarded at the receiver as duplicates.</p>
        <h4>Frame corruption</h4>
        <p>The receiver's CRC check fails and the frame is <b>discarded without any ACK</b>. To the sender this looks identical to frame loss: the timer expires and Go-Back-N resends from the damaged frame.</p>
        <h4>ACK corruption</h4>
        <p>The sender detects the bad checksum and <b>ignores</b> the ACK. This behaves exactly like ACK loss: a later cumulative ACK repairs it, or the timer fires.</p>
        <div class="tm-table-wrap"><table>
          <tr><th>Fault</th><th>Who notices</th><th>Recovery</th></tr>
          <tr><td>Frame lost</td><td>Nobody directly</td><td>Sender timeout &rarr; go back</td></tr>
          <tr><td>Frame corrupted</td><td>Receiver (CRC)</td><td>Discard; sender timeout &rarr; go back</td></tr>
          <tr><td>Frame delayed</td><td>Sender (timeout)</td><td>Go back; late duplicate discarded</td></tr>
          <tr><td>ACK lost</td><td>Nobody directly</td><td>Next cumulative ACK, else timeout</td></tr>
          <tr><td>ACK corrupted</td><td>Sender (checksum)</td><td>Ignored; same as ACK loss</td></tr>
          <tr><td>ACK delayed</td><td>Sender (timeout)</td><td>Go back; duplicates discarded</td></tr>
        </table></div>`
    },
    {
      id: 'eff', title: 'Efficiency & Throughput',
      html: `
        <h4>Useful quantities</h4>
        <div class="tm-formula">T<sub>frame</sub> = frame size / bandwidth
a = T<sub>prop</sub> / T<sub>frame</sub>
RTT &asymp; T<sub>frame</sub> + 2 &times; T<sub>prop</sub>   (ACK size neglected)</div>
        <h4>Link utilisation (no errors)</h4>
        <div class="tm-formula">Utilisation = W / (1 + 2a)             if W &lt; 1 + 2a
Utilisation = 1  (100%)                 if W &ge; 1 + 2a</div>
        <p>The sender needs a window of at least <code>1 + 2a</code> frames to keep the pipe completely full.</p>
        <h4>Optimal window</h4>
        <div class="tm-formula">W<sub>optimal</sub> = 1 + 2a = (T<sub>frame</sub> + 2 &times; T<sub>prop</sub>) / T<sub>frame</sub></div>
        <h4>With errors</h4>
        <p>Let <code>p</code> be the probability that a frame is lost or damaged, and let <code>K = min(W, 1 + 2a)</code>. Each error costs about K transmissions, because the window is resent.</p>
        <div class="tm-formula">Average transmissions per frame = (1 &minus; p + K p) / (1 &minus; p)
Utilisation = (1 &minus; p) / (1 + 2a p)                 if W &ge; 1 + 2a
Utilisation = W (1 &minus; p) / [ (1 + 2a)(1 &minus; p + W p) ]   if W &lt; 1 + 2a</div>
        <p>Compare with Selective Repeat, which resends only the bad frame, so its error penalty is far smaller.</p>
        <h4>Worked example</h4>
        <p>Bandwidth 1 Mbps, frame 1000 bits, one-way propagation 20 ms.</p>
        <div class="tm-formula">T<sub>frame</sub> = 1000 / 10<sup>6</sup> = 1 ms
a = 20 / 1 = 20          &rArr;  1 + 2a = 41
Optimal window = 41 frames
With W = 7:  utilisation = 7 / 41 &asymp; 17.1 %
Stop-and-Wait: 1 / 41 &asymp; 2.4 %</div>
        <p>Even a modest window of 7 gives roughly 7&times; the throughput of Stop-and-Wait on this link.</p>`
    },
    {
      id: 'compare', title: 'Comparison with Other Protocols',
      html: `
        <div class="tm-table-wrap"><table>
          <tr><th>Feature</th><th>Stop-and-Wait</th><th>Go-Back-N</th><th>Selective Repeat</th></tr>
          <tr><td>Sender window</td><td>1</td><td>2<sup>m</sup> &minus; 1</td><td>2<sup>m&minus;1</sup></td></tr>
          <tr><td>Receiver window</td><td>1</td><td>1</td><td>2<sup>m&minus;1</sup></td></tr>
          <tr><td>Receiver buffering</td><td>None</td><td>None</td><td>Required (reorders frames)</td></tr>
          <tr><td>Out-of-order frame</td><td>Not applicable</td><td>Discarded</td><td>Buffered</td></tr>
          <tr><td>Retransmission on loss</td><td>1 frame</td><td>Whole window from the lost frame</td><td>Only the lost frame</td></tr>
          <tr><td>ACK type</td><td>Individual</td><td>Cumulative</td><td>Individual (selective)</td></tr>
          <tr><td>Timers at sender</td><td>1</td><td>1</td><td>One per frame</td></tr>
          <tr><td>Complexity</td><td>Lowest</td><td>Low</td><td>Highest</td></tr>
          <tr><td>Bandwidth efficiency</td><td>Poor on long links</td><td>Good; wastes bandwidth on errors</td><td>Best on noisy links</td></tr>
        </table></div>`
    },
    {
      id: 'pros', title: 'Advantages & Disadvantages',
      html: `
        <h4>Advantages</h4>
        <ul>
          <li>Far better link utilisation than Stop-and-Wait on high-latency links.</li>
          <li>Very simple receiver: one variable (R<sub>n</sub>), no buffer, no reordering logic.</li>
          <li>Only one timer needed at the sender.</li>
          <li>Cumulative ACKs tolerate lost ACKs and reduce ACK traffic.</li>
          <li>Guarantees in-order delivery with no duplicates.</li>
        </ul>
        <h4>Disadvantages</h4>
        <ul>
          <li><b>Wasteful retransmission:</b> one bad frame causes a whole window to be resent.</li>
          <li>Performs poorly on noisy or high-loss links, especially with large windows.</li>
          <li>Window is limited to 2<sup>m</sup> &minus; 1; a small m restricts throughput.</li>
          <li>Sender must buffer all unacknowledged frames.</li>
          <li>Timeout tuning matters: a bad value hurts either speed or efficiency.</li>
        </ul>`
    },
    {
      id: 'use', title: 'Real-World Use',
      html: `
        <ul>
          <li><b>Data link layer:</b> HDLC and its relatives use Go-Back-N-style sliding windows (with 3-bit or 7-bit sequence numbers).</li>
          <li><b>Early TCP:</b> TCP's cumulative acknowledgements and retransmit-from-lost-segment behaviour resemble Go-Back-N, though modern TCP adds selective acknowledgements (SACK) to avoid resending data already received.</li>
          <li><b>Satellite and point-to-point links:</b> where the receiver must stay simple.</li>
          <li><b>Teaching:</b> the clearest introduction to sliding-window reliability.</li>
        </ul>`
    },
    {
      id: 'sim', title: 'Using This Simulator',
      html: `
        <div class="tm-table-wrap"><table>
          <tr><th>Control / display</th><th>What it does</th></tr>
          <tr><td>Window size (W)</td><td>Sets the sender window, limited to 2<sup>m</sup> &minus; 1.</td></tr>
          <tr><td>Total frames (N)</td><td>How many frames the sender must deliver (5&ndash;20).</td></tr>
          <tr><td>Sequence bits (m)</td><td>2, 3 or 4 bits; sets the sequence space and maximum window.</td></tr>
          <tr><td>Error mode</td><td>Normal, packet loss, ACK loss, frame/ACK delay, frame/ACK corruption.</td></tr>
          <tr><td>Target packet / ACK</td><td>Chooses exactly which frame or ACK is affected by the fault.</td></tr>
          <tr><td>Speed</td><td>Slow (0.5&times;), Normal (1&times;) or Fast (2&times;) playback.</td></tr>
          <tr><td>S<sub>f</sub>, S<sub>n</sub> tags</td><td>Show the left edge of the window and the next frame to send.</td></tr>
          <tr><td>R<sub>n</sub> tag</td><td>Shows the next frame the receiver expects.</td></tr>
          <tr><td>Timer bar</td><td>Counts down the timeout for the oldest outstanding frame.</td></tr>
          <tr><td>Guided lesson panel</td><td>Walks through each concept with Back / Continue.</td></tr>
        </table></div>
        <div class="tm-note"><b>Try this:</b> set W = 4, choose <b>Packet Loss</b>, target frame 1, and watch the receiver discard frames 2 and 3 before the sender goes back to resend from frame 1.</div>`
    },
    {
      id: 'faq', title: 'Quick Revision & FAQs',
      html: `
        <h4>One-minute summary</h4>
        <ul>
          <li>Sender window = <b>2<sup>m</sup> &minus; 1</b> at most; receiver window = <b>1</b>.</li>
          <li>Receiver accepts <b>only</b> the expected frame (R<sub>n</sub>) and discards anything else.</li>
          <li>ACKs are <b>cumulative</b>: ACK n confirms everything before n.</li>
          <li>One timer, for the oldest outstanding frame. On timeout, resend <b>all</b> outstanding frames.</li>
          <li>Utilisation = W / (1 + 2a), capped at 1.</li>
        </ul>
        <h4>Common questions</h4>
        <p><b>Why is the receiver window 1?</b> It cannot store out-of-order frames, so it can only ever accept the next in-sequence one.</p>
        <p><b>Does the receiver ACK a discarded frame?</b> A good frame with the wrong sequence number is discarded and the last ACK is re-sent. A <i>corrupted</i> frame is discarded silently with no ACK.</p>
        <p><b>Why resend frames that already arrived?</b> Because the receiver threw them away; with no buffer they were never kept.</p>
        <p><b>How many frames are resent after a timeout?</b> Up to W: every frame from S<sub>f</sub> to S<sub>n</sub> &minus; 1.</p>
        <p><b>What happens if W = 1?</b> Go-Back-N degenerates into Stop-and-Wait.</p>
        <p><b>Is Go-Back-N better than Selective Repeat?</b> Only when errors are rare and receiver simplicity matters. On noisy links Selective Repeat wastes far less bandwidth.</p>`
    }
  ];

  /* ── build DOM ── */
  const overlay = document.createElement('div');
  overlay.className = 'tm-overlay';
  overlay.id = 'theoryOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'theoryTitle');

  const toc = SECTIONS.map((s, i) =>
    `<a href="#tm-${s.id}" data-id="${s.id}"><span>${i + 1}</span>${s.title}</a>`).join('');
  const content = SECTIONS.map((s, i) =>
    `<section id="tm-${s.id}"><h3><em>${i + 1}</em>${s.title}</h3>${s.html}</section>`).join('');

  overlay.innerHTML = `
    <div class="tm-box">
      <div class="tm-head">
        <div>
          <h2 id="theoryTitle">Go-Back-N ARQ &mdash; Complete Theory</h2>
          <p>Everything you need to know about the protocol, in one place</p>
        </div>
        <button class="tm-close" id="theoryClose" aria-label="Close theory">&#10005;</button>
      </div>
      <div class="tm-body">
        <nav class="tm-toc" aria-label="Theory contents"><h3>CONTENTS</h3>${toc}</nav>
        <div class="tm-content" id="theoryContent">${content}</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const content$ = overlay.querySelector('#theoryContent');
  const links = Array.from(overlay.querySelectorAll('.tm-toc a'));
  const btn = document.getElementById('theoryBtn');
  let lastFocus = null;

  function setActive(id) {
    links.forEach(a => {
      const on = a.dataset.id === id;
      a.classList.toggle('active', on);
      if (on) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function open() {
    lastFocus = document.activeElement;
    overlay.classList.add('open');
    document.body.classList.add('tm-lock');
    content$.scrollTop = 0;
    setActive(SECTIONS[0].id);
    overlay.querySelector('#theoryClose').focus();
  }

  function close() {
    overlay.classList.remove('open');
    document.body.classList.remove('tm-lock');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  btn.addEventListener('click', open);
  overlay.querySelector('#theoryClose').addEventListener('click', close);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  /* contents links scroll inside the modal only */
  links.forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const sec = overlay.querySelector('#tm-' + a.dataset.id);
    content$.scrollTo({ top: sec.offsetTop, behavior: 'smooth' });
    setActive(a.dataset.id);
  }));

  /* highlight current section while scrolling */
  content$.addEventListener('scroll', () => {
    const y = content$.scrollTop + 60;
    let cur = SECTIONS[0].id;
    SECTIONS.forEach(s => {
      const el = overlay.querySelector('#tm-' + s.id);
      if (el.offsetTop <= y) cur = s.id;
    });
    setActive(cur);
  }, { passive: true });
})();
