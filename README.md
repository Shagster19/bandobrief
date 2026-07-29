# BandoBrief

BandoBrief is a privacy-first drone preflight briefing and pilot community prototype. The project uses Vite for the web build and Capacitor for native iOS and Android packaging.

> Live-data beta: BandoBrief is an informational aid, not flight authorization. Always complete an official FAA preflight review and use an approved LAANC provider where required.

## Live information

The Brief view now uses:

- FAA UAS Facility Map data for the grid cell beneath the proposed launch pin.
- FAA airport and heliport records for nearby facilities.
- National Weather Service observations and active weather alerts.
- Location-aware sunrise and sunset calculations.
- Direct links to the official FAA TFR map and NOTAM search.

Facility Map ceilings show altitudes the FAA may authorize without further coordination; they are not authorization themselves. A missing Facility Map cell does not mean the airspace is unrestricted. Social posts, nearby pilot markers, likes, and comments remain sample content until accounts and a backend are added.

The local sign-up, login, and pilot-account screens are an interface prototype. A pilot handle is the public username shown to the community. First name, last name, and email are treated as private account information. The prototype keeps these details, aircraft, home area, and privacy preferences only in the current browser session and deliberately never stores or transmits the entered password. Production accounts still require a secure authentication backend, handle-availability checks, verified email, password recovery, and account-deletion support.

## Run in the browser

Capacitor 8 requires Node.js 22 or newer.

On this computer, a portable Node 22 runtime is already stored in `.tools/node`. You can simply double-click `Start BandoBrief.cmd` to start the development server and open the app.

For a normal system-wide Node installation:

```powershell
npm install
npm run dev
```

Then open `http://localhost:5173`.

## Build the web app

```powershell
npm run build
npm run preview
```

The production bundle is written to `dist/`.

## Native development

After dependencies are installed and the platform folders exist:

```powershell
npm run native:sync
npm run native:android
```

The Android project requires Android Studio and its SDK. A physical Android device is optional because Android Studio includes an emulator.

iOS builds require macOS and Xcode:

```bash
npm run native:ios
```

The same web bundle is copied into each native project, so most interface work remains shared.

If you do not own a Mac, continue building and testing the shared app on Windows. When it is time to distribute the iOS app, connect this repository to a hosted macOS build service or macOS CI runner. Apple still requires an Apple Developer account, signing credentials, and a macOS/Xcode build environment for App Store submission.

### Current native status

- Android project generated and synced successfully.
- iOS project generated and synced successfully.
- Native foreground-location permissions configured on both platforms.
- BandoBrief icons and light/dark splash screens generated.
- Android compilation awaits Android Studio and an SDK.
- iOS compilation awaits a Mac with Xcode.

## Project structure

- `index.html`, `styles.css`, `app.js` — shared app interface
- `public/` — manifest, service worker, and app icon
- `capacitor.config.ts` — native application identity and settings
- `android/` and `ios/` — generated native projects
- `dist/` — generated production web bundle

## Before public beta

- Add a production data proxy/cache with monitoring for FAA and NWS outages and rate limits.
- Integrate an approved LAANC provider workflow; BandoBrief does not issue authorizations.
- Add authentication, persistent posts, reporting, blocking, and moderation.
- Add privacy policy, terms, account deletion, and data-retention controls.
- Keep exact pilot locations private by default.
- Test permissions, offline behavior, and degraded-data warnings on real devices.
