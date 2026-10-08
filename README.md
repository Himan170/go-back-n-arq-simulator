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

## Code Structure & Key Functions

The project is modularized into three main JavaScript files, each handling a specific part of the application:

### 1. `script.js` (Core Simulator)
Handles the interactive simulation, canvas rendering, and the core Go-Back-N protocol logic.
- **`buildTimeline(cfg)`**: Pre-calculates the sequence of events (transmissions, timeouts, ACKs, errors) based on the user's configuration.
- **`resetSimulation()`**: Resets all state variables and the timeline, preparing the simulation for a fresh run.
- **`tick(ts)`**: The main animation loop (using `requestAnimationFrame`) that smoothly interpolates positions for packets and the timer.
- **`commitEvent()`**: Advances the simulation by popping the next event from the timeline and updating the sender/receiver state (e.g., sliding the window, discarding packets).
- **`renderPackets()`** & **`renderTimer()`**: Canvas drawing functions that visually represent the packets, ACKs, and the sender's timeout bar.
- **`readConfigFromUI()`**: Reads user inputs (window size, sequence bits, error mode) to feed into the simulation.

### 2. `learn.js` (Guided Lesson)
Manages the step-by-step interactive tutorial mode.
- Orchestrates a sequence of predefined states and animations to explain core concepts.
- Independently manages DOM/canvas elements tailored for the step-by-step educational flow.

### 3. `theory.js` (Theory Modal)
Constructs and manages the "Theory" overlay.
- Dynamically generates the HTML for the comprehensive theory sections (Introduction, ARQ Family, Scenarios, Efficiency, etc.).
- Manages the modal's interactivity, including the synchronized table of contents during scrolling.

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
