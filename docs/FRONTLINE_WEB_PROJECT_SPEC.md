# FRONTLINE — Browser-Based Realistic Multiplayer FPS

> **Project type:** Pure Web 3D multiplayer FPS  
> **Target:** Open a URL and play in a desktop browser; no Windows installer or game download  
> **Initial map:** Blackwood Valley  
> **Initial player capacity:** 16 players (8 vs 8)  
> **Visual direction:** Photorealistic modern military battlefield, inspired by the visual language of Battlefield; not a claim of feature or visual parity with a native AAA game

---

## 0. Product Decisions

The project is a **pure browser game**. Do not create an Unreal Engine Windows executable as the primary deliverable, and do not require players to install a desktop application.

| Decision | Direction |
|---|---|
| Platform | Pure Web; desktop browser |
| Player installation | None; open the game URL |
| Supported controls | Keyboard + mouse |
| Target browsers | Current desktop Chrome and Edge; Firefox compatibility tested after the first milestone |
| Mobile | Not supported in the MVP |
| Game engine | Three.js, TypeScript |
| Rendering baseline | WebGL 2; evaluate WebGPU as an enhancement with fallback |
| Physics | Rapier 3D (WASM) for client collision and movement; server-side collision validation |
| Frontend shell | Vite + React + TypeScript |
| Multiplayer server | Colyseus authoritative rooms, TypeScript, fixed-timestep simulation |
| Maximum players | 16 players per match, 8 per team |
| Initial game mode | Team Deathmatch |
| Next game mode | Conquest |
| Map source | Existing Blender Blackwood Valley project and assets |
| Persistent player data | Supabase Auth + PostgreSQL, where required |
| Web hosting | Static web hosting/CDN (Vercel or Cloudflare Pages are acceptable) |
| Match hosting | Long-running dedicated game-server process/container; not a serverless function |

### Important scope boundary

“Battlefield-like” defines the intended art direction and combat experience. It does **not** mean the browser version can automatically achieve the same rendering fidelity, scale, destruction, animation complexity, or performance as a native Unreal Engine AAA title. Browser GPU capability, memory, download size, and network conditions must be measured on agreed reference hardware.

The first goal is a stable, good-looking, genuinely playable 8v8 browser FPS. Visual quality should be increased only when the frame-time and network budgets remain healthy.

---

## 1. Project Vision

Build a realistic modern military first-person shooter that runs directly in a desktop web browser.

Players should be able to:

- Open the game URL and enter the game without installing a launcher.
- Move through a large outdoor battlefield in first person.
- Use modern firearms with ADS, recoil, reloads, weapon switching, and hit feedback.
- Join either the 8-player Alpha team or the 8-player Bravo team.
- Fight in a 16-player authoritative multiplayer match.
- Play on the existing Blender-created **Blackwood Valley** map.
- See other players move, aim, fire, take damage, die, and respawn with synchronized game state.

The game must be a real-time game, not a static 3D scene, walkthrough, or multiplayer visualization demo.

---

## 2. Technical Architecture

### 2.1 Recommended stack

#### Browser game client

- Vite
- React for menus, lobby, HUD, settings, and account screens
- TypeScript
- Three.js for the 3D world and rendering
- `GLTFLoader` for glTF/GLB assets
- `KTX2Loader` for GPU-friendly texture delivery where applicable
- Rapier 3D for collision and client-side movement prediction
- Three.js `AnimationMixer` for skeletal animation playback
- Web Audio API / Three.js positional audio for spatial sound
- WebSocket transport through Colyseus for the initial multiplayer implementation

Use React for the surrounding UI only. Keep the frame-critical 3D simulation, input sampling, animation updates, and rendering in dedicated game modules rather than triggering React re-renders every frame.

#### Game server

- TypeScript
- Node.js LTS runtime
- Bun as the package manager and task runner where compatible
- Colyseus authoritative rooms
- Fixed-timestep server simulation
- WebSocket transport for the first playable multiplayer milestone
- Shared TypeScript message definitions and gameplay constants

Colyseus is the room, matchmaking, and state-synchronization foundation. It is **not** a finished FPS game server: FRONTLINE must implement its own authoritative movement, weapon rules, hit validation, lag compensation, and match rules.

#### Persistent backend

- Supabase Auth for player identity if accounts are enabled
- Supabase PostgreSQL for persistent profile, statistics, match history, and progression
- Optional REST endpoints for account/profile operations

Do not use Supabase Realtime, a general database, or a Vercel serverless function as the high-frequency authoritative combat networking layer.

### 2.2 High-level architecture

```text
Desktop Browser
├── React UI
│   ├── Main Menu
│   ├── Lobby / Matchmaking
│   ├── Team / Class / Loadout
│   └── HUD / Scoreboard / Settings
│
├── Three.js Game Client
│   ├── Renderer and Scene
│   ├── First-Person Controller
│   ├── Camera / Weapon Viewmodel
│   ├── Animation / Audio / VFX
│   ├── Rapier Collision and Prediction
│   ├── Map Streaming and Asset Loading
│   └── Network Client
│
└── HTTPS / WSS
    ├── Colyseus Match Server (authoritative)
    │   ├── Room / Match Lifecycle
    │   ├── Team and Spawn Rules
    │   ├── Fixed-Tick Player Simulation
    │   ├── Weapon / Ammo Validation
    │   ├── Hit Validation / Damage / Kill
    │   └── State Snapshots / Reconnection
    │
    └── Backend API
        ├── Supabase Auth
        ├── Player Profile
        ├── Statistics / Match History
        └── Progression (later)
```

### 2.3 Rendering backend policy

- Establish a stable WebGL 2 rendering path first.
- Evaluate Three.js `WebGPURenderer` after the first playable scene is stable.
- Keep a tested fallback path; do not make the game inaccessible when WebGPU is unavailable or has a driver issue.
- Do not build the first milestone around experimental renderer-only features.
- Keep materials and post-processing modular so renderer limitations can be addressed without rewriting gameplay.

### 2.4 Network transport policy

For the initial 16-player prototype, use Colyseus WebSocket transport so the team can build and test authoritative gameplay with one straightforward transport.

Keep gameplay networking behind an application-level interface (for example, `IGameTransport`). Do not scatter direct WebSocket calls throughout gameplay systems.

Before claiming production-ready competitive FPS networking, profile packet rates, latency, jitter, packet loss, and server tick stability. Evaluate WebTransport datagrams or another unreliable real-time transport for frequent movement snapshots if WebSocket-over-TCP behavior becomes a bottleneck. Reliable match events (join, leave, inventory, match results) must remain reliable. Any alternative transport needs an explicit browser compatibility and hosting test.

---

## 3. Target Platform and Runtime Requirements

### 3.1 Player requirements

- Desktop browser only for MVP.
- Keyboard and mouse.
- WebGL 2-capable GPU and current browser.
- Stable broadband connection.
- Headphones recommended for spatial audio.
- No native installation, launcher, or plug-in.

### 3.2 Browser behavior

- Serve the game over HTTPS.
- Use Pointer Lock for FPS mouse look after an explicit player click.
- Provide a clear “Click to Play / Resume” interaction to acquire pointer lock and audio permission.
- Support fullscreen mode.
- Release pointer lock when the player opens menus or switches away from gameplay.
- Handle browser tab visibility changes, disconnects, and focus loss safely.
- Show a compatibility message when WebGL 2 or required browser features are unavailable.

### 3.3 Performance target

Initial target, subject to confirmation on an agreed reference PC:

- 1920 × 1080.
- 60 FPS target during normal gameplay.
- No sustained severe frame-time spikes when all 16 players are visible.
- Stable server simulation under a full 16-player room.
- Provide Low / Medium / High graphics presets.
- Dynamically reduce render resolution, shadow quality, foliage density, and post-processing when needed.

Do not promise 60 FPS on every computer. Record the reference PC CPU, GPU, RAM, browser version, resolution, and graphics preset before treating the target as an acceptance criterion.

---

## 4. Core Gameplay

Implement the following as modular systems:

### 4.1 First-person movement

- Walk.
- Sprint.
- Jump.
- Crouch.
- Prone (after basic movement and collision are stable).
- Mouse look with configurable sensitivity.
- Configurable key bindings.
- Ground detection and slope handling.
- Collision against terrain, buildings, props, and gameplay blockers.
- Movement speed affected by stance and class/equipment where appropriate.
- Optional stamina system only after core movement is stable.

Movement should use a capsule-based character controller. Avoid allowing the camera to pass through geometry or snap unpredictably on stairs and slopes.

### 4.2 First-person camera

- Camera pitch and yaw.
- Sensible pitch limits.
- Configurable field of view.
- Smooth ADS transition.
- Controlled camera movement and landing feedback.
- Optional head-bob, disabled or reduced by accessibility settings.
- No excessive camera shake that makes aiming uncomfortable.

### 4.3 Player states

- Idle.
- Moving.
- Sprinting.
- Jumping / falling.
- Crouching.
- Prone.
- Aiming.
- Firing.
- Reloading.
- Taking damage.
- Downed (optional later mode feature).
- Dead.
- Respawning.

Use a clear state model. Do not implement unrelated player behavior as scattered booleans in one large class.

---

## 5. Weapon Framework

Create a reusable, data-driven weapon system. Weapon definitions must be configuration data, not hardcoded branches in the player controller.

### 5.1 Weapon categories

- Assault rifles.
- SMGs.
- DMRs.
- Sniper rifles.
- LMGs.
- Shotguns.
- Pistols.
- Launchers (later milestone).

### 5.2 Weapon configuration

Each weapon should define:

- Weapon ID and display name.
- Weapon category.
- Base damage.
- Fire rate.
- Magazine capacity.
- Reserve ammunition.
- Reload duration.
- Fire modes (single / burst / automatic where applicable).
- Hip-fire spread.
- ADS spread.
- Recoil parameters.
- Bullet range and falloff rules.
- ADS movement and zoom settings.
- Animation references.
- Audio references.
- Muzzle flash and impact VFX references.
- Attachment slots and compatible attachments.

### 5.3 Weapon behavior

- Equip and switch weapons.
- Hip fire.
- Aim down sights (ADS).
- Fire input handling.
- Reload and reload cancellation rules.
- Recoil and spread.
- Ammo and reload UI.
- Muzzle flash, tracers, bullet impacts, and shell ejection where appropriate.

Use server-validated fire cadence and ammunition. A client may immediately show local muzzle feedback for responsiveness, but it must not decide authoritative damage, ammo, or kills.

### 5.4 Initial weapon scope

Do not build every weapon category before the first playable match. Start with:

1. One assault rifle.
2. One pistol.
3. One reload flow.
4. One ADS flow.
5. One server-validated hitscan firing path.

Add weapon variants after the end-to-end firing path works in a real multiplayer room.

---

## 6. Combat System

Implement:

- Server-authoritative hit validation.
- Server-authoritative health and damage.
- Head / torso / limb hit zones where supported by the hitbox model.
- Damage multipliers by hit zone.
- Kill and assist tracking.
- Death state and respawn.
- Kill feed.
- Hit marker and damage feedback.
- Team damage policy (disabled in the initial mode unless explicitly configured).
- Healing and revive only when the selected game mode requires them.

### 6.1 Authoritative hit rules

The client must never submit a final damage value or a trusted hit result.

For every firing request, the server must validate:

- The player belongs to the active match.
- The player is alive and allowed to fire.
- The weapon is equipped and has ammunition.
- The fire rate and fire mode are valid.
- The reload state permits firing.
- The shot sequence is valid and not duplicated.
- The aim direction is within reasonable limits of the server's accepted player view state.
- The shot origin is constrained to the server-known player / weapon position.
- The ray or projectile intersects a valid target and is not blocked by server-known map collision.

Use server-side hitboxes and a bounded lag-compensation / rewind window after the basic server-authoritative firing path is working. Never trust a client-supplied target ID as proof of a hit.

### 6.2 Initial combat milestone

A complete vertical slice must work with two browser clients:

1. Both clients join the same match.
2. Each client sees the other player's position and orientation.
3. One player fires at the other.
4. The server validates the shot and applies damage.
5. Both clients receive the same health and death result.
6. The kill feed and scoreboard update consistently.

---

## 7. Player Classes

Create data-driven class definitions:

- Assault.
- Medic.
- Support.
- Recon.

Each class may configure:

- Primary weapon.
- Secondary weapon.
- Gadget / equipment.
- Grenade type.
- Movement modifiers.
- Class ability.

Do not block the first playable match on a fully balanced class system. Start with a single default infantry loadout, then add class selection after the core networked combat loop is reliable.

---

## 8. Map — Blackwood Valley

Use the existing Blender-created Blackwood Valley scene and assets. Preserve the original `.blend` source files. The browser must load optimized runtime assets, not the full Blender authoring project.

### 8.1 Environment direction

- Temperate forest.
- Mountain ranges.
- River valley.
- Rocky terrain.
- Forest roads.
- Bridges.
- Abandoned settlement.
- Military outposts and objectives.
- Natural and constructed cover.

### 8.2 Asset organization

Separate Blender collections / exports into logical groups:

- `ENV_Terrain`
- `ENV_Rocks`
- `ENV_Trees`
- `ENV_Foliage`
- `ENV_Buildings`
- `ENV_Props`
- `ENV_Weapons`
- `COLLISION_Static`
- `COLLISION_Bullet`
- `GAMEPLAY_SpawnPoints`
- `GAMEPLAY_Objectives`
- `GAMEPLAY_RestrictedAreas`
- `GAMEPLAY_WaterVolumes`
- `LIGHTING_Reference`

Keep visual meshes and gameplay collision meshes separate. A detailed tree, rock, or building render mesh should not automatically become the physics collider.

### 8.3 Blender-to-Web asset pipeline

- Export runtime models as glTF 2.0 / GLB.
- Keep source `.blend` files in the project asset source directory or in a separately versioned asset repository.
- Use Blender PBR-compatible materials and bake or recreate unsupported shader effects.
- Do not assume arbitrary Blender shader nodes, Geometry Nodes, procedural materials, or simulation systems will transfer directly to Three.js.
- Use low-complexity collision meshes for movement and server hit validation.
- Use LOD variants for large or repeated assets.
- Convert repeated vegetation and props into instanced rendering groups in the browser.
- Compress geometry with Meshopt or Draco when the loader pipeline supports the selected format.
- Use KTX2 / Basis Universal textures where appropriate to reduce transfer and GPU memory cost.
- Avoid one enormous GLB containing the entire map.
- Split the map into terrain tiles, landmark groups, prop groups, and streaming chunks.
- Generate a manifest describing asset path, bounds, LOD, collision data, and gameplay metadata.

### 8.4 Gameplay map data

Map data must include:

- Player spawn points for both teams.
- Objective positions.
- Capture radii / zones.
- Restricted areas.
- Shallow and deep water volumes.
- Cover and line-of-sight blockers.
- Bullet collision / material penetration metadata where required.
- Map bounds and out-of-world recovery rules.
- Optional navigation data for future bots.

Use Blender empties or clearly named marker objects plus custom properties to author gameplay markers. Export them into a dedicated `map-manifest.json` or equivalent structured file. Do not rely on object names alone for all gameplay configuration.

### 8.5 Streaming and visibility

- Divide the map into manageable spatial chunks.
- Load nearby chunks first and progressively load distant visual assets.
- Keep spawn areas ready before allowing a player to spawn.
- Use frustum culling, distance culling, LOD, instancing, and occlusion-aware grouping.
- Avoid rendering dense high-detail foliage at full detail across the entire map.
- Use simplified collision geometry independent of render LOD.
- Profile memory and draw calls before increasing map density.

### 8.6 Visual quality strategy

Build a hybrid lighting approach suitable for browser rendering:

- PBR materials with consistent roughness / metalness values.
- High-quality sky and atmospheric fog.
- Carefully controlled directional sunlight.
- Baked or precomputed lighting / ambient occlusion for static environment elements where practical.
- Dynamic shadows prioritized for nearby players and important objects.
- Selective post-processing; avoid expensive full-screen effects by default.
- High-quality water only where it is visible and gameplay-relevant.
- Strong material and vegetation variation to avoid obvious repetition.

Do not try to reproduce every UE5-only feature. Prioritize composition, lighting, material response, foliage quality, terrain detail, and a controlled draw distance.

---

## 9. Game Modes

### MVP — Team Deathmatch

- Two teams: Alpha and Bravo.
- Maximum 8 players per team.
- 16 players maximum per match.
- Configurable score limit and time limit.
- Team score.
- Individual kills / deaths / assists.
- Respawn delay and spawn selection rules.
- Match start, active, and end states.
- Match result screen.

### Next — Conquest

- Multiple capture objectives.
- Capture progress and contested state.
- Team ticket count.
- Objective ownership.
- Ticket bleed rules.
- Tactical map objective markers.

### Future

- Rush.
- Custom Match.
- Training range.
- Bot practice.

Use reusable match rules and shared match state rather than embedding mode-specific logic into the player controller.

---

## 10. Multiplayer Architecture

### 10.1 Match model

- One authoritative room represents one active match.
- Maximum 16 active players.
- Two teams with a maximum of 8 players each.
- The server owns match state and final gameplay outcomes.
- Clients render predicted local movement and interpolated remote movement.

### 10.2 Server simulation

Initial tuning target:

- Fixed simulation tick: start at 30 Hz.
- Evaluate snapshot / state broadcast rate around 15–30 Hz based on bandwidth and measured smoothness.
- Client render loop is independent and targets 60 FPS.
- Measure actual server tick duration and room CPU usage with 16 connected clients.

These are starting parameters, not guaranteed final values. Tune using real network tests and full-room load tests.

### 10.3 Replicated state

Replicate only gameplay-relevant state, such as:

- Player ID and team.
- Position and velocity.
- Yaw / pitch or accepted aim state.
- Movement stance and animation state.
- Current weapon.
- Health and alive / dead state.
- Relevant equipment state.
- Match score and objective state.

Do not continuously replicate static map geometry, visual-only particle states, or every animation bone.

### 10.4 Client-side prediction and interpolation

- The local player should predict its own movement immediately.
- The server validates movement inputs and returns authoritative state.
- Reconcile the local player when server state differs.
- Interpolate remote player snapshots to smooth movement.
- Extrapolate only within a conservative bounded window.
- Handle out-of-order / stale snapshots safely.
- Use sequence numbers and timestamps for inputs and firing requests.

### 10.5 Disconnect and reconnection

- Detect lost connections.
- Mark disconnected players as temporarily reserved for a configurable grace period.
- Allow reconnecting players to reclaim their match slot when valid.
- Return fully disconnected players to the lobby after the grace period.
- Prevent duplicated sessions and duplicated kill / score events.
- End or rebalance a match when player counts become invalid according to match rules.

### 10.6 Anti-cheat baseline

- Server-authoritative health, ammo, fire cadence, hit results, kills, deaths, score, and objectives.
- Validate movement speed, acceleration, jump frequency, stance transitions, and world boundaries.
- Validate message size, rate, sequence, and payload shape.
- Reject impossible movement and firing requests.
- Rate-limit authentication and match-join operations.
- Log suspicious behavior for review.

Client-side obfuscation is not a substitute for server authority. Do not claim that the MVP is cheat-proof.

---

## 11. AI Bots

Bots are not required for the first online MVP. Add them after the player networking and match loop are stable.

Future bot systems may include:

- Navigation mesh or baked navigation graph.
- Patrol and objective navigation.
- Line-of-sight checks.
- Target selection.
- Cover selection.
- Combat behavior.
- Difficulty settings.

A server-controlled bot must use the same authoritative combat and damage rules as a human player.

---

## 12. UI / UX

Create a consistent modern military tactical interface.

### Required screens

- Main Menu.
- Browser / Server List or Quick Match.
- Matchmaking Queue.
- Multiplayer Lobby.
- Team Selection.
- Class / Loadout Selection.
- Loading Screen.
- In-game HUD.
- Tactical Map.
- Scoreboard.
- Pause Menu.
- Settings.
- Match Result.

### In-game HUD

- Health.
- Ammo and reserve ammo.
- Weapon and fire mode.
- Hit marker.
- Kill feed.
- Team score / tickets according to game mode.
- Objective indicators.
- Teammate indicators where appropriate.
- Network ping / connection warning in a diagnostics overlay.

### Settings

- Mouse sensitivity.
- Invert Y axis.
- Field of view.
- Graphics preset.
- Render scale.
- Shadow quality.
- Foliage quality.
- Post-processing toggle.
- Master / music / effects volume.
- Key binding configuration.
- Fullscreen toggle.

Menus must remain usable with keyboard and mouse. When the player opens a menu, release pointer lock and restore it only after the player explicitly resumes gameplay.

---

## 13. Audio and VFX

### Audio

- Weapon fire by weapon type.
- Reload and weapon handling.
- Footsteps by surface type.
- Nearby and distant gunfire layers.
- Bullet whiz and impact sounds.
- Explosions.
- Environmental ambience.
- Water and foliage interaction sounds where practical.
- Spatialized positional audio.

### VFX

- Muzzle flash.
- Bullet tracer.
- Bullet impact by material type.
- Smoke and explosion effects.
- Shell ejection.
- Water splashes.
- Dust and debris.
- Damage feedback.

Use pooled effects for frequently spawned particles. Avoid creating and destroying large numbers of GPU resources during combat.

---

## 14. Backend and Player Data

Backend responsibilities:

- Authentication.
- Player profile.
- Persistent settings where appropriate.
- Match history.
- Lifetime statistics.
- Progression and unlocks (later).
- Leaderboards (later).

The game server remains authoritative for the active match. At match end, it reports validated results to the backend. The client must not submit its own final kill count, score, or match result as trusted data.

Keep account / persistence APIs separate from real-time movement and combat messages.

---

## 15. Performance and Observability

### 15.1 Client metrics

Monitor:

- FPS and frame time (Game / main thread, render, GPU where available).
- Draw calls.
- Triangles and visible objects.
- Texture memory estimates.
- Geometry memory estimates.
- JavaScript heap usage.
- Asset download and decode time.
- Map chunk loading time.
- Long tasks and input delay.
- WebGL context loss and recovery.

### 15.2 Server metrics

Monitor:

- Room tick duration and tick drift.
- CPU and memory per match process.
- Active rooms and connected players.
- Incoming / outgoing messages and bytes per second.
- Ping / RTT, jitter, and disconnect rate.
- Snapshot size and update frequency.
- Validation rejects and suspicious input counts.
- Match completion and crash rates.

### 15.3 Optimization methods

- LOD for terrain, rocks, trees, buildings, and props.
- Instanced rendering for repeated foliage and props.
- Spatial chunking and visibility management.
- Meshopt / Draco geometry compression where measured beneficial.
- KTX2 texture compression where supported by the runtime pipeline.
- Texture atlases for compatible small assets.
- Simplified collision meshes.
- Object and particle pooling.
- Limit dynamic lights and shadow casters.
- Avoid unnecessary per-frame allocations.
- Avoid React state updates on every game frame.
- Lazy-load nonessential menus, audio, and map chunks.

### 15.4 Acceptance testing

Do not mark a performance target complete based only on editor preview or a developer's local machine.

Test at minimum:

1. Empty map baseline.
2. Full Blackwood Valley visible area.
3. 16 player characters active.
4. 16 players firing / moving simultaneously.
5. High foliage density area.
6. Indoor / settlement area with many props.
7. Network latency and packet-loss simulation.
8. Tab background / foreground and reconnect scenarios.

Record device, browser, resolution, quality preset, map location, FPS percentiles, and network conditions for each test.

---

## 16. Code Architecture

Keep systems modular. Suggested structure:

```text
frontline/
├── apps/
│   ├── web/                         # Vite + React + Three.js browser client
│   │   └── src/
│   │       ├── app/                  # React routes and UI shell
│   │       ├── game/
│   │       │   ├── core/             # Game loop, lifecycle, configuration
│   │       │   ├── renderer/         # Three.js renderer and scene setup
│   │       │   ├── world/            # Map loading, chunks, environment
│   │       │   ├── player/           # FPS controller, camera, player states
│   │       │   ├── weapons/          # Weapon runtime and viewmodels
│   │       │   ├── combat/           # Client feedback and hit presentation
│   │       │   ├── animation/        # Animation mixers and state mapping
│   │       │   ├── audio/            # Spatial audio and sound management
│   │       │   ├── vfx/              # Effects and pooling
│   │       │   ├── network/          # Transport adapter and client sync
│   │       │   ├── physics/          # Rapier setup and client collision
│   │       │   └── debug/            # Performance and network overlays
│   │       └── ui/                   # Menus, HUD, scoreboard, settings
│   │
│   └── game-server/                 # Colyseus authoritative server
│       └── src/
│           ├── rooms/                # Match rooms and lifecycle
│           ├── simulation/           # Fixed-tick world and player simulation
│           ├── players/              # Server player state and validation
│           ├── weapons/              # Ammo, cadence, fire validation
│           ├── combat/               # Hit validation, damage, kill rules
│           ├── maps/                 # Collision and map gameplay data
│           ├── modes/                # TDM and Conquest rules
│           ├── matchmaking/          # Queue and team assignment
│           ├── persistence/           # Match result reporting
│           └── observability/         # Metrics and structured logs
│
├── packages/
│   ├── shared/                      # Shared types, constants, schemas, protocol
│   ├── game-config/                 # Weapon, class, and mode data
│   └── map-schema/                  # Map manifest and gameplay-marker schema
│
├── assets/
│   ├── blender-source/              # Original .blend authoring files
│   ├── exported/                    # Optimized GLB / KTX2 runtime assets
│   └── maps/
│       └── blackwood-valley/        # Map manifest, chunks, collision metadata
│
├── docs/
│   ├── ART_DIRECTION.md
│   ├── TECHNICAL_ARCHITECTURE.md
│   ├── ASSET_PIPELINE.md
│   ├── NETWORKING_SPEC.md
│   ├── MAP_INTEGRATION.md
│   └── DEVELOPMENT_PLAN.md
│
├── package.json
├── bun.lock
└── README.md
```

Rules:

- Use TypeScript for client, shared package, and game-server code.
- Use Bun as the package manager; do not introduce npm, Yarn, or pnpm lockfiles.
- Do not put all game logic in one React component, one game manager, or one Colyseus room class.
- Keep server-only authority code out of the browser bundle.
- Share validation schemas and data types where safe, but never share server secrets.
- Keep map source assets separate from compressed production assets.
- All game constants that should match between client and server must come from a shared package or generated configuration.

---

## 17. Development Workflow

For every phase:

1. Inspect the current repository and installed tools.
2. Read existing documentation and inspect existing Blender assets before replacing anything.
3. Identify existing systems that can be reused.
4. Write a small implementation plan.
5. Implement one complete vertical slice.
6. Run type checks and linting.
7. Run unit / integration tests relevant to the slice.
8. Start the browser client and server locally.
9. Verify the behavior in an actual browser.
10. Test with multiple browser clients for multiplayer features.
11. Fix errors before moving on.
12. Update documentation and report verified results.

Never claim a feature is complete because files were generated. Completion requires a successful build and an actual behavior test.

---

## 18. Development Phases

### Phase 0 — Repository and environment inspection

- Inspect the existing project and its current structure.
- Check Bun, Node.js, browser, GPU, and TypeScript toolchain.
- Locate and inspect the existing Blackwood Valley Blender project.
- Record Blender version, map dimensions, asset collections, texture sizes, and current material setup where possible.
- Identify which assets are ready for export and which need cleanup.
- Do not overwrite or delete source assets.

**Exit criteria:** A written environment report, repository plan, and Blender asset inventory.

### Phase 1 — Browser FPS foundation

Implement:

- Vite + React + TypeScript browser application.
- Three.js renderer and scene lifecycle.
- WebGL 2 startup and compatibility check.
- First-person camera.
- Pointer Lock and mouse look.
- Walk, sprint, jump, and crouch.
- Rapier-based capsule collision.
- Simple graybox test map.
- Basic graphics / diagnostics overlay.

**Exit criteria:** The player can open a local URL in a supported desktop browser, click to enter pointer lock, move around the graybox map, collide with walls and ground, and maintain stable camera behavior. No multiplayer or full Blackwood Valley import is required yet.

### Phase 2 — Blender asset pipeline and map integration

- Export a small representative set of Blackwood Valley assets to GLB.
- Validate PBR materials, scale, orientation, pivots, and collision.
- Create map manifest and gameplay-marker export.
- Build a small playable section of Blackwood Valley.
- Add LOD and instanced vegetation tests.
- Add chunk-based asset loading.

**Exit criteria:** A playable browser scene using real Blender assets with acceptable loading and frame-time behavior on the reference PC.

### Phase 3 — Weapon and local combat prototype

- Add one assault rifle and one pistol.
- Add first-person weapon viewmodel.
- Add ADS, firing, recoil, reload, ammo, and weapon switch.
- Add local target dummies and hit feedback.
- Add basic weapon audio and impact VFX.

**Exit criteria:** A complete offline shooting range loop works in the browser.

### Phase 4 — Authoritative multiplayer foundation

- Add Colyseus server and match room.
- Add authentication or development guest identity.
- Add team assignment and 16-player room capacity.
- Add authoritative player state and fixed-tick movement validation.
- Add client prediction and remote interpolation.
- Add reconnect and disconnect handling.

**Exit criteria:** Two or more browser clients can join the same room and see synchronized players moving without directly trusting client position updates.

### Phase 5 — Server-authoritative combat

- Add server-validated weapon fire and ammo.
- Add server-side collision / hit validation.
- Add health, death, respawn, score, and kill feed.
- Add bounded lag compensation after basic hit validation works.
- Add full-room load tests.

**Exit criteria:** A 16-player test room can complete a Team Deathmatch loop with authoritative score and damage.

### Phase 6 — Team Deathmatch MVP

- Main menu and quick match.
- Lobby and team selection.
- Spawn rules.
- Match timer and score limit.
- HUD and scoreboard.
- Match result screen.
- Browser reconnect flow.

**Exit criteria:** A complete 8v8 match can be started and finished through the browser UI.

### Phase 7 — Classes, equipment, and content

- Assault / Medic / Support / Recon.
- Additional weapons and attachments.
- Grenades and equipment.
- Class selection and loadouts.
- Additional player animation and audio.

### Phase 8 — Conquest

- Capture objectives.
- Ticket system.
- Ticket bleed.
- Objective ownership and contested state.
- Tactical map.

### Phase 9 — AI, polish, and production operations

- Basic server-controlled bots.
- Better animation transitions.
- More complete audio and VFX.
- Anti-abuse monitoring.
- Metrics, logs, crash reporting, and alerting.
- CDN and asset delivery optimization.
- Match-server scaling and deployment automation.

### Phase 10 — Optimization and release

- Full 16-player performance test.
- Browser compatibility test.
- Network latency / jitter / packet-loss test.
- Security review of authoritative rules.
- Loading and reconnect test.
- Graphics preset tuning.
- Production deployment and rollback plan.

---

## 19. First Development Task — Start Here

Start with **Phase 0 and Phase 1 only**. Do not implement weapons, online matchmaking, Conquest, AI, or the full Blackwood Valley map in the first task.

### Task A — Inspect the environment

1. Inspect the repository before making changes.
2. Check Bun and Node.js versions.
3. Check the current TypeScript / Vite setup if one already exists.
4. Locate the existing Blender map and assets.
5. Identify the existing browser game code that can be reused.
6. Report missing tools and blockers.

### Task B — Create the initial architecture and documentation

Create or update:

- `README.md`
- `docs/ART_DIRECTION.md`
- `docs/TECHNICAL_ARCHITECTURE.md`
- `docs/ASSET_PIPELINE.md`
- `docs/NETWORKING_SPEC.md`
- `docs/DEVELOPMENT_PLAN.md`

Documentation must reflect a pure browser game, not an Unreal Engine packaged game.

### Task C — Implement the browser FPS graybox

Implement:

- Three.js scene and renderer.
- First-person camera.
- Pointer Lock mouse look.
- Walking.
- Sprinting.
- Jumping.
- Crouching.
- Rapier capsule collision.
- Simple graybox terrain, floor, walls, ramps, and obstacles.
- Basic settings for mouse sensitivity and FOV.
- FPS / frame-time debug display.

Do not import the complete Blackwood Valley scene yet. The goal is to prove the browser controller, input, camera, and collision first.

### Phase 1 verification checklist

- [ ] `bun install` completes successfully.
- [ ] TypeScript check passes.
- [ ] Lint passes if configured.
- [ ] Browser development server starts successfully.
- [ ] The game opens from a local URL.
- [ ] WebGL 2 compatibility is checked and reported.
- [ ] Pointer Lock starts only after a user click.
- [ ] Mouse look works without camera flipping.
- [ ] WASD movement works.
- [ ] Sprint works.
- [ ] Jump works and does not repeatedly trigger while airborne.
- [ ] Crouch works and restores the correct capsule height.
- [ ] The player cannot walk through walls or fall through the floor.
- [ ] The player does not jitter on ramps or at wall corners.
- [ ] The browser can exit pointer lock and resume safely.
- [ ] No continuous React re-render is caused by the 3D render loop.

### Required completion report

After the task, report:

- Repository structure inspected.
- Existing Blender assets found and their condition.
- Files created or changed.
- Main classes / modules and their responsibilities.
- Input mapping.
- Physics and collision approach.
- Browser and renderer tested.
- Build / type-check / lint result.
- Actual browser test result.
- FPS and frame-time measured on the test machine.
- Known limitations.
- Recommended next phase.

Do not claim successful testing unless the browser was actually launched and the behavior was checked.

---

## 20. Explicit Non-Goals for the First Milestone

Do not implement these in Phase 0 or Phase 1:

- Unreal Engine project setup.
- Windows `.exe` packaging.
- Pixel Streaming.
- Multiplayer matchmaking.
- Dedicated server deployment.
- Weapon framework.
- Damage and kill system.
- Class system.
- Full Blackwood Valley import.
- Conquest.
- AI bots.
- Progression and leaderboards.
- Voice chat.

These are later phases. Keep the architecture ready for them, but do not build them before the browser movement and collision foundation has been verified.

---

## 21. Technical References

Use the official documentation as the implementation source of truth and re-check version-specific APIs before coding:

- Three.js WebGLRenderer: https://threejs.org/docs/pages/WebGLRenderer.html
- Three.js WebGPURenderer: https://threejs.org/manual/pages/webgpurenderer.html
- Three.js GLTFLoader: https://threejs.org/docs/pages/GLTFLoader.html
- Blender glTF 2.0 export: https://docs.blender.org/manual/en/latest/addons/scene_gltf2.html
- Colyseus documentation: https://docs.colyseus.io/
- Colyseus state synchronization: https://docs.colyseus.io/state
- Colyseus realtime-action starter: https://docs.colyseus.io/getting-started/server
- Rapier JavaScript: https://rapier.rs/docs/user_guides/javascript/getting_started_js/
- WebTransport API: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API

---

## Final Product Principle

FRONTLINE must remain a **real browser-native 3D game**: the browser downloads game assets and executes the rendering and local gameplay client on the player's computer, while a dedicated authoritative server controls the shared match state.

Do not silently replace this architecture with video streaming of a remote Unreal Engine session. Unreal Pixel Streaming is a different deployment model: the game runs and renders on a remote GPU machine and the browser receives an interactive video stream. It can be reconsidered only as a separate alternative if the project later prioritizes maximum UE rendering fidelity over a browser-native client and its infrastructure costs are accepted.
