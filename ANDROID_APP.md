# TogetherWatch Android app

This project is being developed in milestones so the APK can be built through GitHub Actions without a PC.

## Implemented in the current branch
- Native Android launcher and a WebView for the existing TogetherWatch website.
- Editable HTTPS server URL.
- Native Android screen-capture permission flow using MediaProjection.
- A foreground service using WebRTC to send captured screen video to the existing room signaling server.
- Optional microphone audio attached to the screen stream when Android microphone permission is granted.
- Loads ICE server configuration from `/api/rtc-config`, including TURN credentials when the server is configured.
- Socket.IO room join, WebRTC offers/answers, and ICE candidate exchange.
- Android runtime permission handling for the camera and microphone used by the existing web call interface.
- GitHub Actions builds a debug APK and publishes it as a downloadable artifact.

## Still required for a Kosmi-level release
- Capture and transmit Android system/playback audio alongside the screen. Microphone audio is supported separately; Android internal playback audio is not yet transmitted.
- Test TURN connectivity on restrictive mobile networks.
- Handle screen-owner conflicts and reconnect edge cases in the native client.
- Test on real Android devices and different Android versions; CI compilation is not a substitute for device testing.
- Confirm the real production HTTPS server URL and deploy the complete server stack.

## Build without a computer
1. Open the repository's **Actions** tab on GitHub.
2. Select **Build Android APK**.
3. Open a successful run and download the **togetherwatch-debug-apk** artifact.
4. Extract the ZIP on your phone and install the APK. Android may ask you to allow installs from the browser or file manager.

The APK is a development build, not a signed Play Store release. The full platform also depends on the server, database, and shared Chromium service being deployed and configured.
