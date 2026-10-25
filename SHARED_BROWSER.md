## Shared remote browser (self-hosted)

The room's **Umumiy brauzer** is a single remote Chromium page shared by every participant. Clicks, typing, scrolling, back/forward, and navigation operate on the same page; everyone receives periodic screenshots. This is different from an iframe and can display sites that refuse embedding, subject to the site's own login, DRM, bot-protection, and terms.

### Run the full stack locally or on a VPS

Requires Docker Compose and enough memory for Chromium (start with 2 GB RAM for light use).

```sh
docker compose up --build -d
```

Open `http://localhost:3000`. In a hosted deployment, use a VPS or container platform that supports Docker Compose/private networking and set `BROWSER_WS_ENDPOINT` to a private Browserless/Playwright-compatible Chromium endpoint. Do not expose the browser service publicly. Replace the example `local-dev-token` before exposing the app to the internet. Keep the browser endpoint and token private.

The existing Node-only Render service does not automatically run the browserless container; deploy both services or leave `BROWSER_WS_ENDPOINT` unset (the ordinary video, iframe, and screen-share features continue to work). Browser sessions are temporary and are closed when the last participant leaves the room. Remote page data is not stored in room snapshots.

### Security notes

Navigation is restricted to public HTTP/HTTPS destinations and requests to private/local IP ranges are blocked as a basic SSRF defense. The remote browser must still run in an isolated container/network with no access to internal services or secrets. Do not use this shared session to enter passwords or private account data: all participants can see the same page and can interact with it.
