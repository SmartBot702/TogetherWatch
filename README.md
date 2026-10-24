# TogetherWatch

A real-time watch-party web app: create rooms, invite friends with a six-character code or URL, chat live, and synchronize YouTube, Vimeo, or direct MP4/WebM video links, and share a host's screen for other streaming sites.

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

## Included
- Responsive Uzbek UI
- Room creation/joining, 6-character invite codes and shareable links
- Host-controlled synchronized playback for YouTube, Vimeo, and direct MP4/WebM URLs (best effort)
- Explicit source selector so users know which kind of link they are adding
- Host screen sharing over WebRTC for other video sites or local playback (browser support varies)
- Empty rooms remain joinable in server memory for up to six hours after everyone leaves
- Room member list and real-time chat
- \`/health\` health endpoint

## MVP limitations
Rooms and messages are stored in memory and disappear on server restart. This is an initial MVP, not a production-ready service: add persistent storage, authentication, rate limiting, and monitoring before public launch. Playback sync depends on YouTube embed permissions, browser autoplay rules and network latency. Screen sharing requires browser permission and is best supported in desktop browsers; system audio capture depends on the browser and selected tab. Screen-sharing relay uses peer-to-peer WebRTC and may be limited by NAT/firewall conditions. Empty rooms and chat remain in memory only and are lost if the server restarts. This app does not host or redistribute video files; respect copyright and platform terms.
