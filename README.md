# Go-Back-N ARQ Simulator & Guided Lesson

An interactive, visual simulator and step-by-step guided lesson for the **Go-Back-N ARQ (Automatic Repeat reQuest)** sliding window protocol.

## Features

- **Interactive Timeline & Canvas**: Real-time visual animation of sender and receiver sliding windows, packet transmission, acknowledgments (ACKs), and cumulative ACKs.
- **Error Simulation**:
  - **Normal Mode**: Standard error-free sliding window flow.
  - **Packet Loss**: Simulates packet drop, out-of-order detection, timer expiration, and Go-Back-N retransmission.
  - **ACK Loss**: Simulates lost acknowledgments, cumulative ACK recovery, and duplicate packet handling.
- **Guided Lesson Panel**: Concept-by-concept interactive walkthrough explaining protocol mechanics at each step.
- **Configurable Parameters**: Customize Window Size ($W$), Total Frames ($N$), Sequence Bits ($m$), target error frame, and simulation speed.

## Quick Start

No build tools or servers required. Open `index.html` directly in any modern web browser:

```bash
# Simply double-click index.html or open via terminal:
start index.html
```

## Technologies

- HTML5 / Canvas
- Vanilla JavaScript
- Modern CSS
