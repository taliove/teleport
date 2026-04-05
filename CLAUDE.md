# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleport is a bastion host / jump server system supporting SSH, Telnet, and RDP protocols. It consists of a C++ core server, embedded web UI, and several client helper apps and players.

## Repository Structure

| Path | Language | Description |
|------|----------|-------------|
| `server/tp_core/` | C++11 | Core server: protocol handlers (SSH, Telnet, RDP), HTTP RPC, crypto |
| `server/tp_web/` | C++ | Web server component |
| `client/tp_assist_macos/` | ObjC/C++ | macOS menu-bar helper app, launches SSH/RDP sessions |
| `client/tp_assist_win/` | C++ | Windows equivalent of tp_assist_macos |
| `client/tp-player/` | Qt/C++ | Desktop RDP recording player |
| `client/tp-player-extension/` | JS | Chrome extension for browser-based RDP playback |
| `client/tp-player-web/` | JS | Web-based player |
| `common/libex/` | C++ | Internal utility library (strings, paths, logging, threads) |
| `common/teleport/` | C++ | Shared protocol constants |
| `external/` | — | Pre-built third-party libs (mongoose, jsoncpp, mbed TLS, pako) |

## Build System

The build uses Python scripts invoked via `make.sh`. Config files are platform-specific:

```bash
# First-time setup: copy the config template for your platform
cp config.json.in config.linux.json   # or config.macos.json / config.windows.json
# Edit the config to set paths (e.g., pyexec on Windows)

# Build (auto-detects platform)
./make.sh

# CMake (core C++ only, no Python build system)
mkdir _build && cd _build
cmake .. && make
```

## Subproject Guides

Each client subproject has its own `CLAUDE.md`:
- `client/tp_assist_macos/CLAUDE.md` — macOS app build, architecture, API endpoints
- `client/tp-player-extension/CLAUDE.md` — Chrome extension architecture and conventions

## Key Architectural Notes

- **Server protocol flow**: Core C++ process handles protocol proxying; `tp_core/core/` contains the central orchestration, `tp_core/protocol/` has per-protocol subdirs (ssh, telnet, rdp).
- **Embedded HTTP server**: Mongoose (single `.c` file in `external/mongoose/`) is used in both `tp_core` and `tp_assist_macos` — JSON API served at `localhost:50022/50023`.
- **RDP recording format**: Custom binary format decoded by `rle.c` (RLE bitmaps) + zlib. Shared across `tp-player` (Qt), `tp-player-extension` (Chrome), and `tp-player-web`.
- **Build prerequisites**: Server builds target Linux (CentOS 7+ / Ubuntu 14.04+). macOS builds are for client apps only. Windows uses MSYS2 shell.
- **External deps are pre-built**: Do not modify files under `external/` — they are vendored binaries/sources.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
