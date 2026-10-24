# TogetherWatch

A real-time watch-party web app: create rooms, invite friends with a six-character code or URL, chat live, and synchronize a YouTube video.

## Run locally
Requires Node.js 18+.

\`\`\`bash
npm install
npm start
\`\`\`

Open http://localhost:3000. Test with two browser tabs or devices. Choose a YouTube video that permits embedding.

## Deploy to Render
1. Push this repository to GitHub.
2. In Render, choose **New + → Blueprint** and select this repository.
3. Render reads \`render.yaml\` and deploys the web service. After deployment, open the service URL.

## Included
- Responsive Uzbek UI
- Room creation/joining, 6-character invite codes and shareable links
- Host-controlled YouTube playback and best-effort sync
- Room member list and real-time chat
- \`/health\` health endpoint

## MVP limitations
Rooms and messages are stored in memory and disappear on server restart. This is an initial MVP, not a production-ready service: add persistent storage, authentication, rate limiting, and monitoring before public launch. Playback sync depends on YouTube embed permissions, browser autoplay rules and network latency. This app does not host or redistribute video files; respect copyright and platform terms.
