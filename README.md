# Soundboard (Tauri + Vanilla JS)

A desktop theater soundboard and sequence editor built with Tauri v2, vanilla JavaScript, and Howler.js.

## Features

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

## Project Structure

```text
src/            Frontend app (HTML/CSS/JS)
src-tauri/      Rust/Tauri app, config, and capabilities
```

## Repository Initialization

If this directory is not yet a git repository:

```bash
git init
git add .
git commit -m "Initial commit"
```

Optional: connect to GitHub after creating an empty remote repository:

```bash
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

## Notes

- This project intentionally tracks source files and configuration, but ignores generated build artifacts.
- Keep `Cargo.lock` committed for reproducible desktop app builds.
