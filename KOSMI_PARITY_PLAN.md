# Kosmi-inspired feature parity plan

This project aims to deliver a comparable watch-party experience using original TogetherWatch code and styling. The supplied APK is used to understand broad user-facing feature categories only; proprietary source code, private service endpoints, branding, and bundled assets are not copied.

## Current baseline

- Room creation and joining with invite codes
- Synchronized YouTube, Vimeo and direct MP4/WebM/HLS video sources (provider policies and browser autoplay rules apply)\n- VK Video, OK.ru and Rutube embeds, with platform-native controls where provider APIs do not allow reliable sync
- Room chat, profiles, friends and direct messages
- WebRTC voice/video and screen sharing (HTTPS and browser permissions required)
- Shared browser integration (requires a configured remote Chromium endpoint)
- Shared whiteboard, games, links and file sharing

## Delivery order

1. **UI and navigation** — activity lobby, room tabs, responsive mobile layout, keyboard focus, clear connection and permission states.
2. **Room lifecycle** — create/join/leave, host permissions, room visibility, reconnect and stale-room cleanup.
3. **Media sync** — test YouTube/Vimeo/direct media URLs, late joiners, seek/play/pause drift correction, queue and host handoff.
4. **Social** — account/session security, profiles, friends, DMs, message authorization and persistence.
5. **Live collaboration** — WebRTC call, screen share, whiteboard, games, shared links/files and remote browser.
6. **Deployment and verification** — HTTPS, PostgreSQL migrations/backups, secret handling, rate limits, dependency checks and automated smoke tests.

## Acceptance checks

- Two independent browser sessions can create/join the same room and see consistent room state.
- Unauthorized participants cannot perform host-only actions or read private messages.
- Media state recovers after refresh/reconnect; unsupported embeds show a useful error instead of silently failing.
- Camera, microphone and screen-share denial leave the rest of the app usable.
- Shared browser reports a clear setup error when its remote Chromium endpoint is missing.
- Production deployment uses HTTPS and does not expose database or browser-control ports publicly.

## Known constraints

Visual similarity does not guarantee identical behavior. Some providers block embedding, DRM-protected media cannot be relayed by this app, browser autoplay and screen-capture permissions are platform-controlled, and a shared remote browser needs a separately configured service. VK/OK/Rutube embed playback controls may not synchronize because their cross-origin players do not expose a supported control API to this app. These limitations must be surfaced honestly in the UI.
