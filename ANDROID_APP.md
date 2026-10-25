# TogetherWatch Android app

This is the first Android foundation milestone for the phone-only development workflow.

## Current milestone
- Native Android launcher APK, built automatically by GitHub Actions.
- WebView shell that opens the existing TogetherWatch website.
- Editable HTTPS site URL for deployments whose Render hostname differs.
- Web permissions for camera and microphone requests, with Android permission prompts still governed by the OS.

## Not implemented yet
This milestone is **not** the complete Kosmi-like native experience. In particular, native Android MediaProjection capture has not yet been connected to the website's Socket.IO/WebRTC signaling, and there is no claim that system audio capture, background screen sharing, or native room calls work in this APK. Those require a separate integration and device testing.

## Build without a computer
1. Open the repository's **Actions** tab on GitHub.
2. Select **Build Android APK**.
3. Open the latest successful run and download the **togetherwatch-debug-apk** artifact.
4. Extract the ZIP on your phone and install the APK. Android may ask you to allow installs from the browser or file manager.

The first build may fail if the repository's Actions permissions are disabled; if so, enable Actions in repository settings.
