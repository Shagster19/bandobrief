# BandoBrief project memory

## Live app

- Site: https://shagster19.github.io/bandobrief/
- Repository: https://github.com/Shagster19/bandobrief
- Deployment: GitHub Pages via `.github/workflows/deploy-pages.yml`; every push to `main` deploys.
- Supabase project: configured through the GitHub Actions secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Local development needs a `.env` containing those two Vite variables. The production deployment already has them.

## Completed Supabase work

Production tables currently include:

- `profiles`, `posts`, `reports`
- `post_likes`, `comments`, `comment_likes`
- `follows`

`profiles` includes `avatar_url`, `activity_lat`, `activity_lng`, and `activity_updated_at`.

Applied production migrations:

- Engagement (post likes, comments, and comment likes)
- Pilot network (persistent approximate map areas and follows)

The local reference SQL files are:

- `supabase-schema.sql`
- `supabase-engagement-migration.sql`
- `supabase-comment-likes-migration.sql`
- `supabase-profile-migration.sql`
- `supabase-pilot-network-migration.sql`
- `supabase-followers-read-migration.sql`

## Current features

- Supabase authentication, pilot profiles, profile avatars, community posts, media uploads, likes, comments, and comment likes.
- Follow/unfollow controls appear on other pilots' live community posts.
- A pilot's saved **Home area** is geocoded with Nominatim, rounded to two decimal places, and shown as a persistent map marker when **Show nearby activity status** is enabled.
- Clearing Home area or disabling that preference removes the marker. Markers are approximate only; exact locations are not shown.
- Posting with an attached spot also refreshes the pilot's approximate map area.
- Activity markers use a pilot's profile photo when available, falling back to their handle initial. They remain approximate map areas, not exact live locations.
- The brief requests a current location when the page opens or resumes, keeps the Locate button as a manual refresh, draws an accuracy circle, and redraws map tiles after restore.
- Pilot identity is persisted locally between browser visits; the login screen no longer opens automatically. Signing out clears the saved local profile.
- The pilot account shows a follower count and the profiles of pilots who follow that account. This needs the follower-read SQL migration applied in Supabase.
- The preflight checklist uses in-layout toggle controls to avoid browser scroll jumps.
- The briefing now includes device-local saved launch spots, flight logs (duration, batteries, notes), flight-alert preferences, and first-visit safety onboarding.

## Recent commits

- `fccc586` — Show pilot avatars on activity map
- `2e57fdb` — Add pilot planning tools and onboarding
- `5c2d74b` — Persist pilot sessions and stop auto-opening login
- `ee43a92` — Refresh current location when returning to app
- `c7812bb` — Redraw map after location updates and app restore

- `a9dc65b` — Add likes for community comments
- `626fc03` — Add pilot activity map and follows
- `74af367` — Show nearby pilots for all map visitors
- `357b1dd` — Keep saved pilot areas visible on map

## Known follow-ups / testing focus

- Test sign-up, login, profile editing, home-area marker persistence, privacy toggle behavior, follow/unfollow, posts, comments, likes, and media upload on desktop and mobile.
- Existing pilots need to save their Home area once before receiving a persistent pin.
- Saved launch spots, flight logs, alert preferences, and onboarding state are intentionally local to each browser/device; they are not Supabase-synced yet.
- Browser geolocation requires the visitor to grant site location permission. Location accuracy varies by device/browser.
- Supabase security advisor warnings still need deliberate follow-up:
  - `create_profile_for_user()` is a `SECURITY DEFINER` function callable by `anon` and `authenticated`; revoke execute access unless intentionally public.
  - Enable leaked-password protection in Supabase Auth.
  - The public `post-media` bucket's broad read policy permits listing files; review if that is acceptable.

## Working style

When continuing, inspect `MEMORY.md`, then check `git status`, latest commits, the GitHub Pages workflow, and live Supabase endpoints before making changes.
