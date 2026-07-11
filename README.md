# google-photos-slideshow

A full-screen Google Photos slideshow deployed as a Cloudflare Pages site with a
Pages Function backend. Paste any Google Photos shared-album link into the start
screen, press play, and the app fetches the full album (paginating through all
photos via Google's internal batchexecute RPC), then displays them with a Ken Burns
zoom-and-pan crossfade effect and a random YouTube background track.

> **Warning — unofficial API:** This app uses Google Photos' **unofficial**
> `snAcKc` batchexecute RPC (the same one the Photos web UI calls internally).
> Google has not documented or committed to this interface; it **may break without
> notice** at any time. There is no workaround if Google changes it — the app
> falls back to the ~300 photos embedded in the shared-album HTML page, but full
> pagination depends on the RPC.
>
> **The album must have link sharing enabled.** Open Google Photos, find the
> album, click Share → Create shared link. Only albums with a public share link
> will work.

## Features

- Full-screen Ken Burns zoom + crossfade between slides (7-second dwell per photo)
- Paginates through the entire album (up to ~600 photos across 20 RPC pages)
- Three fallback strategies so partial results are still shown if the RPC fails
- Per-album "unseen" tracking in localStorage — always prefers photos you haven't
  seen yet before looping
- Prev / Next / Pause keyboard and on-screen controls
- Random YouTube background track per session (muted until first gesture for
  iOS compatibility)
- 15-minute server-side cache of photo lists (Cloudflare Cache API)
- No database, no secrets, no configuration beyond deploying

## How to get the album id and key

When you enable link sharing on a Google Photos album the share URL looks like:

```
https://photos.google.com/share/AF1Qip...LONG_ALBUM_ID...?key=AF1Qip...AUTH_KEY...
```

The app accepts the full URL in the start-screen input and parses it automatically.
Internally it splits the URL into:

- `album` — the path segment after `/share/` (the album id)
- `key` — the `?key=` query parameter (the auth key)

Both are required; the `/api/photos` endpoint returns HTTP 400 if either is missing.

## Prerequisites

- Node 18+
- A Cloudflare account
- `npx wrangler login` (authenticates the CLI with your account)

## Deploy

```bash
# 1. Create a Cloudflare Pages project (first deploy only)
npx wrangler pages project create google-photos-slideshow

# 2. Deploy
npx wrangler pages deploy
```

That's it — no D1 database, no secrets, no schema to apply.

## Local development

Run the local dev server:

```bash
npx wrangler pages dev
```

Then open http://localhost:8788 in your browser.

There are no secrets or `.dev.vars` needed for this project.

## API reference

### `GET /api/photos?album=<albumId>&key=<authKey>`

Returns the full photo list for the shared album.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `album`   | yes      | Album id — the path segment after `/share/` in the share URL |
| `key`     | yes      | Auth key — the `?key=` value from the share URL |

**Success (200):**
```json
{
  "photos": [
    {
      "id": "<albumId>-0",
      "baseUrl": "https://lh3.googleusercontent.com/pw/...=w800",
      "timestamp": 1700000000000,
      "filename": null
    }
  ],
  "count": 42
}
```

**Error (400)** — missing params:
```json
{ "error": "Missing required params: ?album=<albumId>&key=<authKey>" }
```

### `OPTIONS /api/photos`

Returns CORS preflight headers (`Access-Control-Allow-Origin: *`).
