# CLAUDE.md — homebridge-nexus21

Handoff notes for the coding agent taking over this project. Read this whole file before changing anything.
Owner: Kiko Lobo. He writes most of his code in Swift/C++, but Homebridge plugins must be Node, so this project is TypeScript (ESM).

---

## 0. TL;DR

- **What:** a Homebridge platform plugin that controls **Nexus 21 motorized TV lifts** through the **Nexus 21 IP Control module ("IPLIN")**.
- **Transport:** plain **HTTP/JSON REST** on port 80. It is **not telnet**; an early draft assumed telnet, and that code was deleted.
- **Default module address: `192.168.5.40`.** Keep this default everywhere (schema, code fallback, docs) until the owner says otherwise.
- **Status:**
  - Version `0.2.2`.
  - Compiles cleanly under TypeScript strict.
  - Ran end-to-end against a simulated lift and loaded in a real **Homebridge 2.4.0** instance.
  - **Not yet tested against the physical lift.** That is the next milestone (§9).
- **HomeKit model:**
  - The lift is a **Window Covering**: 0 = TV hidden, 100 = TV fully visible.
  - Memory presets MEM1–3 are **Switches** that are ON while the lift rests at that memory.

---

## 1. Safety rules for the agent

1. **Never send a motion command** (`UP`, `DOWN`, `MEM1–3`) to the real module at `192.168.5.40` without the owner's explicit OK in the current session. A real TV is mounted on this lift, and a move can collide with objects or people.
2. `GET /api/status` is read-only and always safe to call.
3. A "stop" is itself a motion command (see §3.3). If it is sent to an idle lift, **it starts a move**, so treat it with the same care.
4. Don't change the accessory UUID formula (§5.4) casually. Doing so makes HomeKit treat the lift as a brand-new device, and the owner loses scenes and automations.
5. Don't publish to npm without the owner's go-ahead.

---

## 2. Repository layout

```
homebridge-nexus21/
├── CLAUDE.md               ← this file
├── README.md               ← user-facing docs
├── package.json
├── tsconfig.json
├── config.schema.json      ← drives the Homebridge UI settings form
├── src/
│   ├── index.ts            ← plugin entry; registers the platform
│   ├── settings.ts         ← PLATFORM_NAME, PLUGIN_NAME, DEFAULT_HOST
│   ├── types.ts            ← LiftConfig / MemoryPreset / Orientation
│   ├── platform.ts         ← DynamicPlatformPlugin: config → accessories, SSDP log
│   ├── nexusApi.ts         ← REST client, status normalizer, error table, websocket, SSDP
│   └── liftAccessory.ts    ← HomeKit services + motion/stop/estimation state machine
├── tools/
│   └── probe.mjs           ← standalone CLI for poking the real module (no build needed)
├── test/
│   └── sim.mjs             ← simulated-lift harness (`npm test`), see §6
├── eslint.config.js        ← flat config; `npm run lint` is clean at zero warnings
├── .gitignore
├── LICENSE                 ← MIT
└── CHANGELOG.md
```

`dist/`, `node_modules/` and `*.tgz` are build artifacts and are gitignored.
`package-lock.json` is committed.

---

## 3. The Nexus 21 IPLIN API (v1.0)

Source: the owner's PDF "Nexus21_IP_Module_API.pdf", summarized here. This is the ground truth; don't invent endpoints.

### 3.1 Endpoints

| Purpose | Request | Response |
|---|---|---|
| Status | `GET http://<ip>/api/status` (no body) | JSON: `STATUS`, `VERTICAL`, `HORIZONTAL`, `EXTCMD`, `DESCRIPTION` |
| Command | `POST http://<ip>/api/command`, body `{"COMMAND":"XXXXX"}` | JSON: `STATUS` (`OK`/`ERROR`), `DESCRIPTION` |
| Discovery | SSDP M-SEARCH (see 3.5) | `HTTP/1.1 200 OK` with `ST: urn:Nexus21:service:basicevent:1` |
| Push feedback | Websocket. **The URL/path is NOT given in the sheet.** | Same JSON as status |

Status field values:
- `STATUS`: `"OK"` or `"ERROR"`.
- `VERTICAL`: `"UP"`, `"DOWN"`, `"MOVING"` or `"MEMn"` (n = 1–3).
- `HORIZONTAL`: `"LEFT"`, `"CENTER"`, `"RIGHT"`, `"MOVING"`, `"NA"` or `"MEMn"`. It is present only on 2-actuator (swivel) systems.
- `EXTCMD`: the last command seen on the LIN bus **that did not come from the API**, such as the RF remote or a keypad. Its values are the same as the command list.
- `DESCRIPTION`: a "JSON list of error codes" (see 3.4). The exact shape isn't specified; the parser is tolerant (§5.2).

The sheet's example JSON uses typographic curly quotes; real firmware is assumed to send normal JSON.

### 3.2 Commands

| COMMAND | Meaning |
|---|---|
| `UP` | Move reference 1 up, **or stop any other motion** |
| `DOWN` | Move reference 1 down, **or stop any other motion** |
| `MEM1` | Move to memory position 1 ("HOME") |
| `MEM2` | Move to memory position 2 |
| `MEM3` | Move to memory position 3 |

There are **no** horizontal/swivel commands and **no** STOP command in v1.0.

### 3.3 How stopping works (critical)

The sheet defines STOP as a behavior, not a command:
- Send **`UP`** to stop a running `DOWN`, `MEM1`, `MEM2` or `MEM3`.
- Send **`DOWN`** to stop a running `UP`.
- **Corner case from the sheet:** if the motion has already finished when the "stop" arrives, the command is **executed as a new move**.

Consequences baked into the plugin:
- **Stop:** check `VERTICAL == "MOVING"` first, then send the opposite command.
- **Direction reversal** (e.g. moving UP, user wants DOWN): send the new command **twice**. The first one stops the motion; after `REVERSE_DELAY_MS` (600 ms) the second one starts the new move. The status is checked for `MOVING` before the first send.
- **Re-targeting in the same direction** (moving UP, new target is also up): send nothing. It is *assumed* that `UP` while already moving UP just continues; this is unverified (§9).

### 3.4 Error codes (`DESCRIPTION`)

Control-box codes:

| Code | Meaning |
|---|---|
| 8 | Unexpected reset |
| 9 | LIN error |
| 10 | Power fail |
| 11 | Channel count changed |
| 12 | Position difference |
| 13 | Short circuit |
| 14 | Checksum (**all channels lost position**) |
| 15 | Power limit |
| 16 | Key error |
| 17 | No safety |
| 18 | Missing initialization plug |
| 19 | LIN power |
| 23 / 24 | Channel 1 / 2 missing |
| 29 / 30 | Channel 1 / 2 type |
| 35 / 36 | Channel 1 / 2 pulse |
| 41 / 42 | Channel 1 / 2 overload up |
| 47 / 48 | Channel 1 / 2 overload down |
| 53 / 54 | Channel 1 / 2 anti-collision |
| 59 / 60 | Channel 1 / 2 SLS activation |
| 65 / 66 | Channel 1B / 2B type |
| 71–74 | Channel 1A / 1B / 2A / 2B shorted |
| 84 | DC-out |
| 85 | Radio dead |
| 86 | Master |
| 87 | Slave 1 |

IP-module codes:

| Code | Meaning |
|---|---|
| 500 | REST argument error |
| 501 | Lost communication with the LIN control box |
| 502 | Ref1 position lost |
| 503 | Ref2 position lost |
| 504 | EEPROM failure |

When a position-lost error occurs, the sheet requires the UI to show **"Call Nexus 21 Product Support 480-306-5462"**. The plugin logs that text for codes **14, 502, 503**.

How the plugin maps codes:
- `OBSTRUCTION_CODES` = {41, 42, 47, 48, 53, 54}. These set HomeKit **ObstructionDetected**.
- `POSITION_LOST_CODES` = {14, 502, 503}. These are logged at error level with the support phone number.

### 3.5 SSDP

The M-SEARCH must be sent **exactly in this field order**, because old firmware is strict about it:

```
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 1
ST: urn:Nexus21:service:basicevent:1
```

Lines are CRLF-terminated, followed by a blank line. The response's `SERVER:` header looks like `OS/version UPnP/1.1 Nexus21-IPLIN/version`, and `USN` is `0`. The response contains **no MAC or ID**, so the plugin only uses the sender's IP. The sheet says Savant reserves the module IP in the router rather than using SSDP; the owner should do the same for 192.168.5.40.

---

## 4. Build, install and run commands

### 4.1 Requirements
- **Node.js:**
  - Homebridge 2.x (current is 2.4.0) requires Node **22, 24 or 26**.
  - Homebridge 1.8+ runs on Node 20+.
  - `engines.node` in package.json is `^20.18.0 || ^22.10.0 || ^24.0.0 || ^26.0.0`.
- **Homebridge:** `^1.8.0 || ^2.0.0`. Development is against `homebridge ^2.4.0`, which is a devDependency.

### 4.2 Development

```bash
npm install          # installs ws + dev deps (typescript, homebridge, @types/*, rimraf)
npm run build        # rimraf ./dist && tsc
npm run watch        # tsc -w
npx tsc --noEmit     # type-check only
```

### 4.3 Package and install into a Homebridge server

```bash
npm pack             # runs "prepack" → build; outputs homebridge-nexus21-<version>.tgz
scp homebridge-nexus21-*.tgz pi@<homebridge-host>:/tmp/
# on the Homebridge server:
cd /var/lib/homebridge                       # Raspberry Pi image / Linux hb-service
#   Docker: cd /homebridge      macOS hb-service: cd ~/.homebridge
npm install /tmp/homebridge-nexus21-<version>.tgz
# then restart Homebridge (UI → Restart, or: sudo hb-service restart)
```

`package.json` `files` = `["dist", "tools", "config.schema.json", "README.md"]`, so the tarball ships a prebuilt `dist/`.

### 4.4 Run a throwaway local Homebridge (dev loop)

```bash
npm run build
mkdir -p /tmp/hb && cat > /tmp/hb/config.json <<'EOF'
{
  "bridge": { "name": "HB Dev", "username": "0E:11:22:33:44:57", "port": 51897, "pin": "031-45-154" },
  "platforms": [{ "platform": "Nexus21", "discover": true, "lifts": [{ "name": "TV Lift", "host": "192.168.5.40", "debug": true }] }]
}
EOF
# -P points at the folder CONTAINING the plugin folder; -I = insecure (UI access); -D = debug log
npx homebridge -U /tmp/hb -P .. -I -D
```

If the project folder isn't named `homebridge-nexus21`, Homebridge may not recognize it via `-P ..`. In that case, `npm link` it or install the `.tgz` into `/tmp/hb` and use `-P /tmp/hb/node_modules`.

Homebridge prints a QR code and pairing PIN. Pairing is optional for log-only checks.

### 4.5 probe tool (talks to the real module; no build needed)

```bash
node tools/probe.mjs discover                    # SSDP search, prints raw replies (3 s)
node tools/probe.mjs 192.168.5.40 status         # GET /api/status (safe)
node tools/probe.mjs 192.168.5.40 watch          # polls every 500 ms, prints changes only (safe)
node tools/probe.mjs 192.168.5.40 UP             # ⚠ moves the lift — owner approval required
node tools/probe.mjs 192.168.5.40 DOWN|MEM1|MEM2|MEM3   # ⚠ same
node tools/probe.mjs ws://192.168.5.40/ws        # print websocket pushes (requires npm install for `ws`)
```

`probe.mjs` has no default host; always pass `192.168.5.40` explicitly.

---

## 5. Code walkthrough

### 5.1 `settings.ts`
```ts
export const PLATFORM_NAME = 'Nexus21';          // "platform" key in config.json
export const PLUGIN_NAME = 'homebridge-nexus21'; // npm name (verified free on npm as of 2026-09-15)
export const DEFAULT_HOST = '192.168.5.40';
```

### 5.2 `nexusApi.ts`

**Types and parsing**
- `NexusCommand` = `'UP' | 'DOWN' | 'MEM1' | 'MEM2' | 'MEM3'`. `asCommand(str)` validates a string against that list.
- `normalizeStatus(body)` upper-cases all keys and string values, then returns `{ ok, vertical, horizontal, extCmd, errors[] }`.
  - `ok` is false only when `STATUS === 'ERROR'`; a missing `STATUS` counts as OK.
  - `parseErrors` accepts a number, a string, an array, or objects. It takes the first integer found in each item's JSON.
- `ERROR_TEXT`, `POSITION_LOST_CODES` and `OBSTRUCTION_CODES` are defined here (see §3.4).

**`class NexusApi extends EventEmitter`**
- `status()` and `command(cmd)` use global `fetch`, with `AbortSignal.timeout(requestTimeoutMs)` (default 4000 ms).
  - A non-JSON response throws.
  - An HTTP error status that still has a JSON body is *returned*, not thrown, so `STATUS: ERROR` bodies are readable.
  - Debug logging prints every POST, but a GET only when its body changed (this avoids spamming the log while polling).
- `startWebSocket()` runs only if `websocketUrl` is set (it uses the `ws` package).
  - Handshake timeout is 5 s. A ping every 30 s terminates the socket if no pong or message arrived.
  - Reconnect backoff goes from 1 s up to 60 s.
  - The first failure logs a warning; later failures log at debug level.
  - Each message is emitted as `'status'` with a normalized payload.
- `isWebSocketOpen` is a getter; `close()` tears everything down.

**`discoverModules(timeoutMs = 3000)`**
- Sends the SSDP M-SEARCH twice (at 0 ms and 500 ms) to 239.255.255.250:1900.
- Keeps replies containing "nexus21" (case-insensitive).
- Returns `{ address, server }[]`.

### 5.3 `platform.ts` — `Nexus21Platform`

**Startup**
- On `didFinishLaunching`, it calls `setupLifts()`.
- If `config.discover !== false`, it also calls `logDiscovery()`. That is **log-only**: it prints found IPs and whether they match a configured lift.
- On `shutdown`, it calls `shutdown()` on each lift.

**`liftConfigs()` normalizes the config**
- If `lifts` is empty or missing, it uses **one default lift named "TV Lift"**.
- `name` falls back to "TV Lift" ("TV Lift 2", … for later entries).
- `host` falls back to **`DEFAULT_HOST` (192.168.5.40)**.

**`setupLifts()`**
- Creates or restores one `PlatformAccessory` per lift and stores the config in `accessory.context.config`.
- Unregisters cached accessories that are no longer configured.

### 5.4 Accessory identity
```ts
uuid = api.hap.uuid.generate(`nexus21:${cfg.host}:${cfg.name}`)
```
Changing a lift's **name or host** creates a new HomeKit accessory, and the old one is removed. Warn the owner before doing either.
If stable identity across renames is ever needed, add an optional `id` config field and use it in the UUID seed. Existing installs would then need a migration path.

### 5.5 `liftAccessory.ts` — `LiftAccessory`

**HomeKit services**
- `AccessoryInformation`:
  - Manufacturer "Nexus 21".
  - Model = `cfg.model`, or "Pop-up TV Lift" / "Drop-down TV Lift".
  - SerialNumber = host.
- `WindowCovering` (the main service):
  - `CurrentPosition` (get).
  - `TargetPosition` (get/set → `setTarget`).
  - `PositionState` (get).
  - `HoldPosition` (set true → `stop()`).
  - `ObstructionDetected` (get).
- `Switch` × up to 3, subtypes `mem-1`, `mem-2`, `mem-3`:
  - Named via `ConfiguredName`.
  - `On` reads `vertical === 'MEMn'`.
  - Setting On=true sends `MEMn` (via `startMotion`).
  - Setting On=false does nothing except re-sync the displayed state after 300 ms.
  - Stale switch services are removed when presets are deleted from the config.

**Orientation mapping**

| orientation | extendCmd (→100) | retractCmd (→0) |
|---|---|---|
| `popup` (default) | `UP` | `DOWN` |
| `dropdown` | `DOWN` | `UP` |

Status words map the same way: `VERTICAL === extendCmd` → 100 and `=== retractCmd` → 0. `MEMn` maps to that preset's configured `position`, or to the current estimate if it has none.

**State fields**
- `current`: float, the estimated position 0–100.
- `target`: the target position.
- `state`: `PositionState`.
- `online`: `boolean | undefined`.
- `vertical`: the last `VERTICAL` value seen.
- `lastMotion`: the command believed to be running.
- `graceUntil`: end of the command grace window.
- `activeErrors`: the set of current error codes.
- `motionTarget` / `lastTick`: used for position estimation.
- Timers: `pollTimer`, `motionTimer` (interval), `stopTimer`.
- `accessory.context.position` persists the last settled position across restarts. It is written via `updatePlatformAccessories` only when the value changes.

**Constants**

| Name | Value | Purpose |
|---|---|---|
| `TICK_MS` | 250 | Estimation tick |
| `COMMAND_GRACE_MS` | 2000 | Status readings this soon after a command may predate it |
| `REVERSE_DELAY_MS` | 600 | Pause between the "stop" and "go" sends on a direction change |
| failsafe | 1.5 × travel time | If no status confirms arrival, settle at the estimate |

**Flow: `setTarget(value)`**
1. If offline, throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`. Home shows "No Response".
2. If `partialPositioning` is false, snap values 1–99 to 0 or 100 (≥50 → 100) and push the corrected TargetPosition.
3. If the target equals the rounded current position: call `stop()` if moving; otherwise do nothing.
4. Otherwise call `startMotion(extending ? extendCmd : retractCmd, target, stopAfter)`. `stopAfter` is set only for partial targets, as `|Δ| / 100 × travelMs`.

**Flow: `startMotion(cmd, target?, stopAfterMs?)`**
1. Clear the motion timers.
2. Decide what to send:
   - Moving with the same `lastMotion`: send nothing.
   - Moving in a different direction: GET status. If it says `MOVING`, send `cmd` (which stops the lift) and sleep 600 ms. Then send `cmd`.
   - Not moving: send `cmd` once.
3. On error: log it, settle at the current estimate, and throw a communication failure.
4. Set `lastMotion = cmd`, then call `beginTracking(cmd, target ?? round(current))`.
5. If `stopAfterMs` is set, schedule `stop(true)`.

**Flow: `stop(midTravel = false)`**
1. Call `advanceEstimate()` first, so the stop point is accurate, then clear the timers.
2. If `midTravel` is true and `lastMotion` is known, skip the status check. That is the plugin's own timed partial move, where precision matters.
   Otherwise GET status. Only if `VERTICAL === 'MOVING'` does it continue; the motion comes from `lastMotion ?? EXTCMD`.
3. Send `DOWN` if the motion is `UP`, otherwise `UP`.
4. `settle(round(current))`, then poll after 1.5 s.

**Flow: `send(cmd)`**
- Sets `graceUntil = now + 2000` and POSTs the command.
- If the reply is `STATUS: ERROR`, it throws with the decoded error text.
- Errors from command replies are **not** fed into `activeErrors`. Only status replies are, because command replies may carry a partial error list.

**Polling: `schedulePoll()` / `poll()`**
- Interval while moving (`state !== STOPPED`): `movingPollIntervalMs` (default 1000, min 250).
- Idle interval: `pollIntervalSeconds` (default 10, min 2), or 60 s while the websocket is open.
- On success: `setOnline(true)` and `applyStatus`. On failure: `setOnline(false, err)`.
- Online/offline changes are logged once per transition. Going offline mid-motion settles at the estimate.

**`applyStatus(s)`**
1. Call `handleErrors(s.errors)`: log new codes, log cleared codes, and toggle ObstructionDetected.
2. Update `vertical`. If it changed, refresh the preset switches.
3. If `vertical` is a **rest word** (UP, DOWN or MEMn):
   - During the grace window, while moving, with a rest position different from the target: **ignore** it as a stale pre-command reading.
   - Otherwise `settle(rest)` if anything differs.
4. If `vertical === 'MOVING'`, the grace window is over, the plugin thinks it's STOPPED, and the previous value was a rest word: treat it as **external motion** (RF remote or keypad) → `onExternalMotion(extCmd, prev)`.
   - Direction and target come from `EXTCMD` when it is present.
   - Otherwise they are inferred from `prev`: resting at the retracted end → extending; resting at the extended end → retracting.
   - Tracking then starts from the current estimate.
5. Any other value is logged at debug level as "unhandled VERTICAL".

**Estimation: `animate(target)` / `advanceEstimate()`**
- Linear motion at `100 / travelMs` per ms, clamped at the target.
- `CurrentPosition` is updated on each tick.
- The failsafe settles when the target has been reached and 1.5 × travel time has elapsed.
- Normally a status poll settles the move earlier.

**`settle(pos)`**
- Clears the timers and `lastMotion`.
- Sets current = target = pos and state STOPPED.
- Persists `context.position`.

### 5.6 `types.ts` (config shape)

```ts
type Orientation = 'popup' | 'dropdown';
interface MemoryPreset { slot: 1 | 2 | 3; name: string; position?: number /*0–100*/ }
interface LiftConfig {
  name: string; host: string;              // host default 192.168.5.40 (applied in platform.ts)
  port?: number;                           // 80
  model?: string;
  orientation?: Orientation;               // 'popup'
  travelTimeSeconds?: number;              // 20
  partialPositioning?: boolean;            // false
  pollIntervalSeconds?: number;            // 10 (min 2)
  movingPollIntervalMs?: number;           // 1000 (min 250)
  requestTimeoutMs?: number;               // 4000
  websocketUrl?: string;                   // unset = polling only
  memoryPresets?: MemoryPreset[];          // max 3
  debug?: boolean;                         // false; logs API traffic at info level
}
```
Platform-level option: `discover?: boolean` (default true).

### 5.7 `config.schema.json`
- `pluginAlias: "Nexus21"`, `pluginType: "platform"`, `singular: true`.
- The `host` field has `default` and `placeholder` = **192.168.5.40**.
- `lifts` defaults to `[{ "name": "TV Lift", "host": "192.168.5.40", "orientation": "popup" }]`.
- `orientation` and `memoryPresets[].slot` use `oneOf` dropdowns. `memoryPresets` has `maxItems: 3`.
- **Keep the schema, `types.ts` and README in sync** whenever an option is added or changed.

### 5.8 Minimal and full `config.json` examples

Minimal (resolves to one lift "TV Lift" at 192.168.5.40):
```json
{ "platform": "Nexus21" }
```

Full:
```json
{
  "platform": "Nexus21",
  "discover": true,
  "lifts": [
    {
      "name": "TV Recamara Principal",
      "host": "192.168.5.40",
      "port": 80,
      "model": "L-45m",
      "orientation": "popup",
      "travelTimeSeconds": 22,
      "partialPositioning": false,
      "memoryPresets": [
        { "slot": 1, "name": "TV Home", "position": 0 },
        { "slot": 2, "name": "TV Media Altura", "position": 50 }
      ],
      "websocketUrl": "",
      "pollIntervalSeconds": 10,
      "movingPollIntervalMs": 1000,
      "requestTimeoutMs": 4000,
      "debug": true
    }
  ]
}
```
The owner's home uses Spanish room names (as in the Lutron plugin: Recamara Principal, Cocina, Alberca…). Keep user-facing names in whatever language he configures.

---

## 6. Simulator test harness (`test/sim.mjs`)

This harness validates v0.2.x. It lives at `test/sim.mjs` and runs via `npm test`
(or `npm run test:sim`). It ends with assertions on the command log and exits non-zero
if any fail, so regressions break the run.
- It fakes the IPLIN module on `127.0.0.1:8099` with a 3 s travel time and MEM1 at 40.
- It drives the plugin through Homebridge's real `HomebridgeAPI` and HAP.
- It overrides the host to 127.0.0.1 on purpose, so the default 192.168.5.40 is **not** touched.

The source is `test/sim.mjs` in the repo — read it there rather than from a copy here, so the two can't drift.
Its two `ASSUMPTION:` comments mark the unverified firmware behaviors from §8; update them once the real lift is measured (§9).

**Expected output** (last validated run; ± a few % on the in-motion snapshots is normal):

```
start                              HK cur=0 tgt=0 state=0 | lift pos=0 DOWN
extending (1.5s)                   HK cur=42 tgt=100 state=1 | lift pos=50 UP
extended                           HK cur=100 tgt=100 state=2 | lift pos=100 UP
retracting (1s)                    HK cur=75 tgt=0 state=0 | lift pos=67 DOWN
after HoldPosition                 HK cur=67 tgt=67 state=2 | lift pos=67 STOPPED
partial → 20                       HK cur=20 tgt=20 state=2 | lift pos=20 STOPPED
extending from 20                  HK cur=37 tgt=100 state=1 | lift pos=43 UP
reversed → retracting              HK cur=0 tgt=0 state=2 | lift pos=0 DOWN
retracted                          HK cur=0 tgt=0 state=2 | lift pos=0 DOWN
RF remote UP (1.5s)                HK cur=0 tgt=0 state=2 | lift pos=48 UP      ← detection waits for idle poll (2 s)
  [hb info] [TV] external motion detected (UP)
RF remote done                     HK cur=100 tgt=100 state=2 | lift pos=100 UP
MEM1 (switch on=true)              HK cur=40 tgt=40 state=2 | lift pos=40 MEM1
  [hb error] [TV] error 502: Reference 1 position lost. Call Nexus 21 Product Support 480-306-5462
  [hb info] [TV] error 502 cleared
lift command log: UP@0 | DOWN@100 | UP@67(moving DOWN) | DOWN@67 | UP@20(moving DOWN) | UP@20 | DOWN@43(moving UP) | DOWN@43 | RF UP@0 | MEM1@100
```

Key assertions to keep true, in the command log:
- A **stop** is always `UP` while moving DOWN, or `DOWN` while moving UP.
- A **reversal** is the same command sent twice (`DOWN@43(moving UP) | DOWN@43`).
- **No extra commands** are sent while idle.

PositionState values: 0 = DECREASING, 1 = INCREASING, 2 = STOPPED.
Consider converting these checks into real assertions (e.g. `node:test`) so regressions fail loudly.

---

## 7. Verification history (what has already been proven)

| Check | Result |
|---|---|
| `tsc` strict build (TypeScript 5.6, NodeNext ESM) | ✅ clean |
| Simulator (§6) on Homebridge 1.11.4 and 2.4.0 APIs | ✅ output above |
| `npm pack` → install tgz into a fresh dir → real `homebridge` 2.4.0 binary | ✅ platform registered, lift added, "IP module reachable" against a mock |
| Empty platform config `{ "platform": "Nexus21" }` in real Homebridge 2.4.0 | ✅ logged `Adding lift: TV Lift (192.168.5.40)` |
| Physical Nexus 21 module at 192.168.5.40 | ❌ **not yet** |

---

## 8. Known limitations and assumptions

1. **Position is estimated.** The API only reports UP, DOWN, MOVING or MEMn, so intermediate positions come from `travelTimeSeconds`. Timed partial moves drift slightly.
2. **External-motion detection latency** is up to `pollIntervalSeconds` (10 s by default) unless the websocket works. The estimate starts from the moment of detection, so it lags the real lift until the end-status settles it.
3. **The mid-travel stop status is unknown.** The simulator assumes an unlisted value, which the plugin ignores. If the real firmware reports `UP` or `DOWN` after a mid-stop, the plugin will "settle" at 100 or 0 incorrectly. The workaround is to keep `partialPositioning` off.
4. **Same-command-while-moving** is assumed to continue the motion rather than stop it. This is unverified.
5. **The websocket URL is unknown.** Feedback via websocket is opt-in through `websocketUrl`.
6. **No swivel/horizontal control.** `HORIZONTAL` is parsed but unused, and 2-actuator swivel positions are reachable only through the MEM presets.
7. **The `DESCRIPTION` shape is unknown.** The parser grabs the first integer from each list item.
8. **SSDP is log-only.** It does not auto-assign hosts, because replies carry no unique ID.
9. **No authentication.** The API sheet mentions none; it's plain HTTP on the LAN.
10. **Renaming a lift or changing its host re-creates the HomeKit accessory** (§5.4).
11. ~~No ESLint yet.~~ ESLint (flat config) is in place and clean at zero warnings; keep it that way (`npm run lint`).
12. `rimraf` is only used by the `build` script. It's fine as a devDependency.

---

## 9. Next milestone: validate on the real lift (192.168.5.40)

Do these in order. Read-only steps need no approval; ⚠ steps need the owner present and approving.

1. `node tools/probe.mjs 192.168.5.40 status`. Record the exact JSON: key casing, value casing, `DESCRIPTION` shape, extra fields.
2. `node tools/probe.mjs discover`. Record the `SERVER:` header (firmware version).
3. Run `node tools/probe.mjs 192.168.5.40 watch` in one terminal. The **owner** uses the RF remote to:
   - a. Move fully up. Record the sequence (expect `MOVING` → `UP`) and `EXTCMD`.
   - b. Stop mid-travel. **Record VERTICAL after the stop** (assumption 3).
   - c. Move fully down.
   - d. Go to MEM1, MEM2 and MEM3. Record the values and the physical position of each (for the `position` config).
4. Time a full travel with a stopwatch, both directions, and use the larger value for `travelTimeSeconds`.
5. ⚠ With approval, via probe:
   - `UP`, then `UP` again while moving (assumption 4: continues or stops?).
   - `DOWN` while moving UP (should stop).
   - `UP` while idle at the top (should do nothing / stay UP).
6. Websocket discovery (read-only): try `ws://192.168.5.40/ws`, `ws://192.168.5.40/`, `ws://192.168.5.40/api/ws` and `ws://192.168.5.40:81/`, each with `node tools/probe.mjs <url>`. If one connects and pushes JSON while the remote is used, set `websocketUrl`.
7. Update the code for any finding:
   - VERTICAL after a mid-stop → adjust `applyStatus` / `restPosition`.
   - Casing → `normalizeStatus`.
   - DESCRIPTION shape → `parseErrors`.
   - Continue/stop behavior → `startMotion`.

   Then update the simulator's ASSUMPTION lines to match the real device, and re-run §6.
8. Install on the owner's Homebridge (§4.3). Configure it with `debug: true`, pair as a **child bridge**, and test from the Home app and Siri. Then set `debug: false`.

---

## 10. Backlog (after validation)

- [x] Add `test/sim.mjs` and the `test:sim` script. ~~optionally convert it to `node:test` assertions~~ — it now asserts on the command log and exits non-zero on failure; converting to `node:test` is still optional.
- [x] ESLint (flat config, `typescript-eslint`) plus an `npm run lint` script — clean at zero warnings.
- [x] `.gitignore` (`node_modules/`, `dist/`, `*.tgz`), `LICENSE` (MIT), `CHANGELOG.md`.
- [x] `package.json` metadata: `repository`, `bugs`, `homepage`, `author` — all point at `github.com/kikolobo/homebridge-nexus21`. `funding` is still optional.
- [ ] Optional `id` config field for stable accessory identity (§5.4).
- [ ] Optional platform-level `defaultHost` override (currently the constant `DEFAULT_HOST = '192.168.5.40'`).
- [ ] If swivel commands appear in a future API version, add a second service (e.g. horizontal tilt or switches).
- [ ] Publish to npm (the name `homebridge-nexus21` was free on 2026-09-15). Then apply for the Homebridge "Verified" badge at homebridge.io. Owner approval is required.

---

## 11. Changelog so far

- **0.1.0:** a telnet-based draft, written before the API sheet was available. Superseded; do not revive it.
- **0.2.0:** rewritten for the IPLIN REST API.
  - Adds the stop/reversal semantics, external-motion detection, error decoding, SSDP logging and optional websocket feedback.
  - Memory switches reflect the lift's state.
  - Offline requests return "No Response".
- **0.2.1:** targets Homebridge 2.x (dev against 2.4.0); `engines` updated; `files` and `prepack` added; the timed stop skips the status check and advances the estimate first (precise partial stops).
- **0.2.2:** **default host 192.168.5.40.**
  - The schema pre-fills the address field.
  - An empty `host` falls back to 192.168.5.40.
  - An empty `lifts` list yields one "TV Lift" at 192.168.5.40.
