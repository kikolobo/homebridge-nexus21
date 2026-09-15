# homebridge-nexus21

Homebridge plugin for **Nexus 21 TV lifts** through the **Nexus 21 IP Control module (IPLIN)**, using its REST API v1.0.

- The lift is a HomeKit **Window Covering**: 0 % = TV hidden, 100 % = TV visible (pop-up or drop-down).
  "Hey Siri, open the TV lift."
- Stop (HoldPosition) and optional timed partial positions.
- MEM1–MEM3 as switches that are **on while the lift sits at that memory**.
- Motion from the RF remote / keypad is detected (`VERTICAL` + `EXTCMD`) and mirrored in HomeKit.
- Error codes are logged by name; overload / anti-collision set *Obstruction Detected*;
  position-lost errors (14, 502, 503) log the Nexus support number.
- Status polling (fast while moving), optional websocket push, SSDP discovery in the log.

## How the API is used

| Action | Request |
|---|---|
| Status | `GET /api/status` → `STATUS`, `VERTICAL`, `HORIZONTAL`, `EXTCMD`, `DESCRIPTION` |
| Move | `POST /api/command` `{"COMMAND":"UP"\|"DOWN"\|"MEM1"\|"MEM2"\|"MEM3"}` |
| Stop | No STOP command. Any command other than the running one stops the motion: `DOWN` stops `UP`, `UP` stops everything else. |
| Reverse | Send the new direction twice: the first stops the motion, the second starts the new one. |

The plugin confirms `VERTICAL == MOVING` before sending a "stop". A stop sent to an idle lift would start a new move,
which is the corner case the API sheet warns about. The one exception is its own timed partial moves, which skip the
check so they stop precisely.

## Install

```bash
npm install
npm run build
npm link                      # then in ~/.homebridge: npm link homebridge-nexus21
```

## Develop

```bash
npm run build      # rimraf ./dist && tsc
npm run watch      # tsc -w
npm run lint       # eslint, zero warnings
npm test           # build, then the simulated-lift harness in test/sim.mjs
```

`npm test` fakes an IPLIN module on `127.0.0.1:8099` and drives the plugin through
Homebridge's real API and HAP, asserting the stop and reversal semantics. It never
touches the real module at 192.168.5.40.

## Try the module first

```bash
node tools/probe.mjs discover
node tools/probe.mjs 192.168.5.40 status
node tools/probe.mjs 192.168.5.40 watch     # press the RF remote, stop mid-travel, etc.
node tools/probe.mjs 192.168.5.40 UP
```

Things worth checking with `watch`:
1. **What `VERTICAL` reports after a mid-travel stop.** The sheet only lists UP/DOWN/MOVING/MEMn.
   If it reports `UP` or `DOWN` there, partial positions will snap to the end in HomeKit; keep `partialPositioning` off.
2. **Which direction `EXTCMD` shows** for RF-remote moves.
3. **The websocket path.** The sheet says feedback is pushed over websockets but doesn't give the URL.
   Try `node tools/probe.mjs ws://192.168.5.40/ws` (or `/`, `/api/ws`). If one works, put it in `websocketUrl`.
   Otherwise polling works fine.

## Defaults

The module address defaults to **192.168.5.40**. If `host` is left empty, or no lifts are configured at all,
the plugin uses that address.

## Example config

```json
{
  "platform": "Nexus21",
  "discover": true,
  "lifts": [
    {
      "name": "TV Recamara Principal",
      "host": "192.168.5.40",
      "orientation": "popup",
      "travelTimeSeconds": 22,
      "partialPositioning": false,
      "memoryPresets": [
        { "slot": 1, "name": "TV Home", "position": 0 },
        { "slot": 2, "name": "TV Media Altura", "position": 50 }
      ],
      "debug": true
    }
  ]
}
```

- Measure `travelTimeSeconds` with a stopwatch; position between the ends is time-estimated.
- Set each preset's `position` to where that memory physically sits, so HomeKit shows the right percentage.
- Reserve the module's IP in your router (DHCP reservation by MAC).
- API v1.0 has no horizontal/swivel commands. On 2-actuator lifts, swivel positions are reachable through MEM presets.
