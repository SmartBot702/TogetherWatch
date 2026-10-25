# TogetherWatch

A real-time watch-party web app: create rooms, invite friends with a six-character code or URL, chat live, and synchronize YouTube, Vimeo, or direct MP4/WebM video links, and share a site URL for each participant to open locally. Screen sharing remains optional, not required for supported synchronized video sources.

## Run locally
Requires Node.js 18+.

\`\`\`bash
npm install
npm start
\`\`\`

Open http://localhost:3000. Test with two browser tabs or devices. Use a YouTube or Vimeo video that permits embedding, or a direct HTTPS/HTTP MP4/WebM file URL. Vimeo privacy and embedding settings still apply.

## Deploy to Render
1. Push this repository to GitHub.
2. In Render, choose **New + → Blueprint** and select this repository.
3. Render reads \`render.yaml\` and deploys the web service. After deployment, open the service URL.

## Accounts and profiles
- Username/password registration and login with scrypt password hashing and HTTP-only session cookies
- Editable display name, bio, and HTTPS avatar URL
- Search other registered users by username or display name
- Account data is stored in `.data/accounts.json` by default; set `DATA_DIR` to a persistent mounted directory in deployment.
- For durable production accounts, create a PostgreSQL database and set `DATABASE_URL` to its connection string in the web service environment. The app creates its table automatically and migrates existing `accounts.json` data once when the database is empty. Set `DATABASE_SSL=disable` only for a local PostgreSQL instance without TLS. If `DATABASE_URL` is not set, the JSON store remains active.

## Included
- Responsive Uzbek UI
- Room creation/joining, 6-character invite codes and shareable links
- Synchronized playback for YouTube, Vimeo, direct MP4/WebM, and HLS URLs (best effort; embedding rules still apply)
- Explicit source selector so users know which kind of link they are adding
- Shared site URLs, with best-effort direct MP4/WebM/HLS extraction for synchronized playback
- Optional screen sharing over WebRTC for sites that cannot be embedded or synchronized
- Optional room voice/video calls with microphone and camera permissions
- Empty rooms, current video, queue, and the last 100 chat messages remain in server memory for up to six hours after everyone leaves
- Room member list and real-time chat
- \`/health\` health endpoint

## MVP limitations
Watch rooms, video queue, shared site, and room chat can be persisted in PostgreSQL using `DATABASE_URL`; rooms are kept for up to six hours after becoming empty. Without PostgreSQL, room state is in memory and disappears on server restart. Accounts, friend lists, and private messages also use PostgreSQL when configured. This is an initial MVP, not a production-ready service: add persistent storage, authentication, rate limiting, and monitoring before public launch. Shared-page URLs are opened independently in each participant's browser. The app attempts to extract public direct MP4/WebM/HLS streams for synchronized playback; it cannot synchronize interactions, login sessions, or DRM-protected playback on arbitrary external sites. Screen sharing is optional. Playback sync depends on YouTube embed permissions, browser autoplay rules and network latency. Voice/video calls and screen sharing require browser permissions and is best supported in desktop browsers; system audio capture depends on the browser and selected tab. Screen-sharing and calls use peer-to-peer WebRTC. By default they use public STUN servers; some NAT/firewall networks require TURN configuration. Set `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL` in the service environment to enable a TURN relay. For production, use a TURN provider that supports temporary credentials rather than a permanent shared secret. Empty rooms and chat remain in memory only and are lost if the server restarts. This app does not host or redistribute video files; respect copyright and platform terms.
