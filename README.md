# Soundboard (Tauri + Vanilla JS)

A desktop theater soundboard and sequence editor built with Tauri v2, vanilla JavaScript, and Howler.js.

## What It Is

This app is designed for live cueing and playback during shows, rehearsals, and events.
It gives you:

- A pad-based soundboard for one-shot or looping cues
- A sequence editor for chaining sounds with per-step timing and crossfades
- Fast drag-and-drop workflow between the soundboard and sequencer
- Persistent autosave for project state and UI layout

## Core Features

- Sound pads with per-pad volume, fade in, fade out, loop, and retrigger controls
- Live playback progress and status indicators
- Drag-and-drop pad reordering
- Sequence editor with step duration and crossfade controls
- Drag pads into sequences and reorder sequence steps
- Local autosave for pads, sequences, and sequencer UI state

## Tech Stack

- Frontend: HTML, CSS, JavaScript (vanilla)
- Desktop shell: Tauri v2
- Audio engine: Howler.js
- Backend: Rust (Tauri commands)

## Prerequisites

- Node.js 18+
- Rust toolchain (stable)
- Platform dependencies required by Tauri

For Tauri system requirements, see:
https://v2.tauri.app/start/prerequisites/

## Development

Install dependencies:

```bash
npm install
```

Run in development mode:

```bash
npm run tauri dev
```

Create a production build:

```bash
npm run tauri build
```

## How To Use

### 1. Add Sounds

- Click Add Sound (or the + tile in the grid)
- Choose an audio file
- Set label, color, volume, fade in/out, loop, and retrigger

Supported audio formats depend on platform codecs and Howler/browser decoding support.

### 2. Play From Pads

- Click a pad to play
- Click again to stop (or retrigger if retrigger is enabled)
- Use Stop All in the header to immediately stop everything

### 3. Build Sequences

- Create a sequence from the sequencer panel
- Drag sounds from the pad grid into:
	- the sequence list (append)
	- specific step positions in the active sequence (insert)
- Open Edit to modify sequence name, default crossfade, and steps

### 4. Edit Step Behavior

For each step:

- Duration:
	- 0/Full means use the clip's natural duration
	- Set a value to force step length
- Crossfade:
	- Default uses the sequence default crossfade
	- Set a value to override for that step

### 5. Run Sequence Transport

- Play starts the selected sequence
- Stop halts playback
- Next forces transition to the next step using current crossfade behavior

## Soundboard Controls Explained

- Volume: playback level for that pad
- Fade In: time to ramp from silence to target level
- Fade Out: time to ramp down before stop/end
- Loop: repeats the clip continuously
- Retrigger: when already playing, a new trigger restarts playback instead of acting as toggle-stop

## Saving and Persistence

- The app autosaves pads, sequences, and key UI state locally
- You can also save and open project files manually from the top bar
- Existing projects are normalized on load for backward compatibility

## Project Structure

```text
src/            Frontend app (HTML/CSS/JS)
src-tauri/      Rust/Tauri app, config, and capabilities
```

## Notes

- This project intentionally tracks source files and configuration, but ignores generated build artifacts.
- Keep `Cargo.lock` committed for reproducible desktop app builds.
