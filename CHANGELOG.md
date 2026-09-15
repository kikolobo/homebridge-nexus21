# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-09-15

### Changed
- Default IP module address is now **192.168.5.40** everywhere:
  - `config.schema.json` pre-fills and placeholders the address field.
  - An empty `host` falls back to `DEFAULT_HOST`.
  - An empty (or missing) `lifts` list yields one lift named "TV Lift" at that address.

### Added
- `test/sim.mjs` harness (`npm run test:sim`) — fakes the IPLIN module on
  `127.0.0.1:8099` and drives the plugin through Homebridge's real API and HAP.
- Repository hygiene: `.gitignore`, `LICENSE` (MIT), this changelog.

## [0.2.1] - 2026-09-15

### Changed
- Targets Homebridge 2.x (developed against 2.4.0); `engines` updated accordingly.
- `files` and a `prepack` script added so `npm pack` ships a prebuilt `dist/`.
- Timed partial stops skip the status check and advance the position estimate
  first, so mid-travel stops land precisely.

## [0.2.0] - 2026-09-15

Rewritten for the Nexus 21 IPLIN REST API (the telnet draft is gone).

### Added
- Window Covering service: 0 % = TV hidden, 100 % = TV fully visible, for pop-up
  and drop-down orientations alike.
- Stop and direction-reversal semantics for an API that has no STOP command:
  any command other than the running one stops the motion, so a reversal sends
  the new command twice with a 600 ms pause.
- External-motion detection — moves started by the RF remote or a keypad are
  picked up from `VERTICAL` + `EXTCMD` and mirrored in HomeKit.
- Error-code decoding: overload and anti-collision codes set
  *Obstruction Detected*; position-lost codes (14, 502, 503) log the Nexus 21
  support number.
- MEM1–MEM3 as switches that read ON while the lift rests at that memory.
- SSDP discovery, logged only (replies carry no unique ID).
- Optional websocket push feedback via `websocketUrl`.
- Unreachable modules return "No Response" in the Home app.

## [0.1.0] - 2026-09-15

- Telnet-based draft, written before the API sheet was available. Superseded by
  0.2.0; do not revive it.
