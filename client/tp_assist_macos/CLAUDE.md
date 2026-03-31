# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TP-Assist is the macOS client helper app for Teleport (a bastion host / jump server system). It runs as a menu bar agent (`LSUIElement`) with no Dock icon, providing a local HTTP/HTTPS server that the Teleport web UI calls to launch SSH, SFTP, RDP, and Telnet sessions on the user's machine.

## Build Commands

```bash
# Build via Xcode CLI
xcodebuild -project TP-Assist.xcodeproj -scheme TP-Assist -configuration Release build

# Recompile AppleScripts (run before build if .applescript files changed)
./apple-scripts/compile.sh
```

No test suite, linter, or package manager exists in this project.

## Architecture

**Language mix:** Objective-C/C++ UI shell → C-style bridge → C++11 core logic.

**Initialization chain:**
`main.m` → `NSApplicationMain` → `AppDelegate -awakeFromNib` → `cpp_main()` → `TsEnv::init()` → `TsCfg::init()` → `http_rpc_start()` (spawns HTTP on port 50022, HTTPS on port 50023)

**Key modules:**

| Module | File(s) | Role |
|--------|---------|------|
| AppDelegate | `src/AppDelegate.mm` | Menu bar UI, AppleScript dispatch |
| C bridge | `src/AppDelegate-C-Interface.cpp` | `cpp_main()`, `AppDelegate_start_ssh_client()` — bridges ObjC ↔ C++ |
| HTTP server | `src/csrc/ts_http_rpc.cpp` | Embedded Mongoose server, serves web UI and JSON API |
| Config | `src/csrc/ts_cfg.cpp` | Loads/saves `~/.tp-assist.json` via JsonCpp |
| Environment | `src/csrc/ts_env.cpp` | Resolves bundle paths, resource paths |
| Constants | `src/csrc/ts_const.h`, `ts_ver.h` | Ports (50022/50023), version (3.5.6) |
| Web UI | `site/` | HTML/JS config and status pages served by the embedded server |
| AppleScripts | `apple-scripts/scripts/` | Terminal.app and iTerm2 automation for SSH sessions |

**API endpoints** (served by `TsHttpRpc`):
- `GET /api/get_version` — version string
- `GET /api/get_config` — full JSON config
- `GET /api/set_config/<url_encoded_json>` — save config
- `GET /api/run/<params>` — launch SSH/SFTP/RDP/Telnet client
- `GET /api/rdp_play/<params>` — launch RDP playback

## Monorepo Context

This project lives inside the Teleport monorepo and **cannot build in isolation**. It depends on sibling directories via relative paths:

- `../../external/macos/release/lib/` — pre-built mbed TLS static libraries
- `../../../../external/mongoose/` — embedded HTTP server (single C file)
- `../../../../external/jsoncpp/` — JSON parser (compiled into the app)
- `../../../../common/libex/` — internal utility library (strings, paths, logging, threads)
- `../../../../common/teleport/` — shared protocol constants

## Configuration

Runtime config file: `~/.tp-assist.json` (copied from `../../cfg/tp-assist.macos.json` on first launch). Contains SSH/SFTP/RDP client app selections and paths.

TLS: self-signed certs at `../../cfg/localhost.pem` and `localhost.key`, bundled into the app resources.
