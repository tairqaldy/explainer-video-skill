---
name: explainer-video
description: Record a narrated, subtitled screen-recording video of a web app with a scripted cursor (MP4), optionally embedded in a one-file HTML report with screenshots. Use when the user asks for a demo video, explainer video, product walkthrough, feature tour, screencast, video for a PR or release, or a "video report" of a web page or app they can run locally or reach by URL. macOS only (uses `say`, Swift and Google Chrome); no npm packages, no ffmpeg.
---

# Explainer video

Turns a scenes file into a narrated MP4: headless Chrome plays scripted actions with a visible cursor, each scene
gets one voice clip and its subtitles, and the scene is fitted to its clip. Optionally builds a single HTML report
with the video, chapters, screenshots and free-form sections.

`SKILL_DIR` below means the directory this file is in. All scripts run with plain `node` and `/usr/bin/swift`.

## Requirements

macOS, Node 22+, Google Chrome, Xcode command line tools (`/usr/bin/swift`). First time in a session, check with:

```bash
node SKILL_DIR/examples/quickstart/run.mjs --plan
```

If that prints a timing table, the setup works. The full example (`run.mjs` without `--plan`) records a 30 s video
in about a minute.

## Workflow

1. **Agree on the story.** What the viewer should understand, in 3 to 8 scenes, 20 to 90 seconds total. One idea per
   scene. Ask for the language and the voice if it is not obvious (Russian → `Milena`, English → `Samantha`).
2. **Get the app running** and know its base URL. If pages need a login, find out how the app authenticates
   (session cookie, bearer header, localStorage token) and have the user put the value in an environment variable.
   Never write a token, password or API key into the scenes file, the repo, or chat: reference it as `${VAR_NAME}`.
3. **Read the UI before writing actions.** Open the pages (browser tool or source code) and note the exact visible
   texts of the buttons, links, field labels and headings you will use as targets. Prefer visible text over CSS
   selectors; use `within` when the same text appears several times (a "Delete" button in every row).
4. **Write the scenes file** (format below). Put it where the user wants it; outside the user's repo or in an ignored
   folder if they do not want it committed. Output goes to `out/` next to the scenes file by default.
5. **Check the timing:** `node SKILL_DIR/scripts/record.mjs scenes.json --plan` makes the voice clips and prints how
   long each scene will be. Adjust the narration if the total is off.
6. **Record:** `node SKILL_DIR/scripts/record.mjs scenes.json`. On a failed action it prints the scene, the action,
   what is visible on the page, and saves `out/failed-<scene>.jpg`: read that screenshot, fix the target, run again.
7. **Check the result yourself before reporting it done:**
   - Read the timing table. `plays ×1.8 faster` means the actions took longer than the narration: add words, remove
     actions or split the scene (above ×1.6 the cursor looks hurried). `holds the last frame` is fine.
   - Read every `out/check/NN-<scene>.jpg` (one frame per scene, mid-subtitle): the right screen, the cursor visible,
     the subtitle readable and not covering the thing being shown.
   - The `audio:` line must show sound (`sound in 60–90% of the time`); `looks silent` or `audio: none` means the
     voice failed.
8. **Report (optional):** write `report.json` and run `node SKILL_DIR/scripts/report.mjs report.json`. The video,
   poster and stills are embedded, so `out/report.html` is one file the user can send. Keep the video ≤ 12 MB
   (`maxMb`) so the report stays small.
9. **Hand over** the paths (video, poster, report) and the length. Do not commit generated videos unless asked.

## Scenes file

JSON (or an `.mjs` module whose default export is the same object or an async function returning it). Paths are
relative to the scenes file.

```json
{
  "baseUrl": "http://localhost:3000",
  "viewport": { "width": 1440, "height": 900 },
  "lang": "en",
  "voice": { "engine": "say", "name": "Samantha", "rate": 180 },
  "output": "out/demo.mp4",
  "maxMb": 12,
  "auth": {
    "cookies": [{ "name": "session", "value": "${APP_SESSION}" }],
    "headers": { "Authorization": "Bearer ${APP_TOKEN}" },
    "localStorage": { "token": "${APP_TOKEN}" }
  },
  "scenes": [
    {
      "name": "invite",
      "say": "To invite a teammate, open Members and click Invite.",
      "caps": ["Members → Invite"],
      "actions": [
        { "goto": "/settings/members", "waitFor": "Members" },
        { "click": "Invite", "waitFor": "Send invite" },
        { "type": "ada@example.com", "into": "Email" },
        { "click": { "text": "Admin", "within": { "selector": "[role=radiogroup]" } } },
        { "still": "invite-dialog" },
        { "click": "Send invite", "waitFor": "Invitation sent" }
      ]
    }
  ]
}
```

Settings (all optional except `scenes`):

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:3000` | `goto` paths are appended to it; `--base` overrides |
| `viewport` | 1440×900 | page size = video size |
| `lang` | `en` | browser language (Accept-Language) and default voice |
| `voice.engine` | `say` | `say` (macOS, offline), `openai` (needs `OPENAI_API_KEY` in the environment), `none` (silent video) |
| `voice.name` | Samantha / Milena by `lang` | macOS voice (`say -v '?'` lists them) or an OpenAI voice (`alloy`, `nova`, `onyx`, …) |
| `voice.rate` | 180 | `say` words per minute |
| `voice.model`, `voice.speed`, `voice.instructions` | `gpt-4o-mini-tts`, 1 | OpenAI only; `instructions` sets the tone |
| `output` | `out/demo.mp4` | also writes `<name>-poster.jpg`, `<name>.timeline.json`, `stills/`, `check/` next to it |
| `maxMb` | 12 | size cap of the MP4 |
| `fps` | 24 | |
| `timing.lead`, `timing.tail` | 300, 600 | ms of silence before and after each voice clip |
| `cutLoads` | `true` | cut page loads out of the video |
| `cursor.color` | `#2563eb` | halo and click ripple color |
| `auth.cookies` / `headers` / `localStorage` / `sessionStorage` | | `${VAR}` is replaced from the environment at run time |

Scene keys: `name`, `say` (what the voice reads), `caps` (subtitle lines shown in order, each on screen for a share of
the scene proportional to its length; default: the sentences of `say`; `[]` for none), `hold` (extra ms at the end),
`actions`.

Actions (one verb per object; extra keys are its options):

| Action | Example | Notes |
|---|---|---|
| `goto` | `{ "goto": "/billing", "waitFor": "Invoices" }` | path or full URL; the load is cut from the video |
| `click` | `{ "click": "Save", "waitFor": "Saved" }` | moves the cursor, clicks with a ripple; `waitFor` after |
| `hover` | `{ "hover": "Pro plan" }` | point at something while the voice talks about it |
| `glide` | `{ "glide": { "selector": "h1" } }` | slide the cursor along an element, like underlining it |
| `type` | `{ "type": "Ada", "into": "Name", "clear": true, "enter": true }` | types character by character (`cps`, default 18); `into` finds a field by label, placeholder or aria-label |
| `press` | `{ "press": "Enter" }` | Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, or one character |
| `scroll` | `{ "scroll": "Pricing" }`, `{ "scroll": { "by": 600 } }`, `{ "scroll": { "y": "top" } }` | smooth; a target is scrolled to the top of the view (`block: "center"` to center) |
| `waitFor` | `{ "waitFor": "Report ready", "timeout": 60000, "cut": true }` | text or `{ "selector": … }`; `cut: true` removes a long wait from the video |
| `wait` | `{ "wait": 800 }` | ms, recorded |
| `still` | `{ "still": "settings" }` | screenshot without the cursor → `stills/settings.jpg`; `poster` also becomes the video poster |
| `zoom` | `{ "zoom": 1.6 }` … `{ "zoom": 1 }` | camera zooms in and follows the cursor until `zoom: 1`; subtitles stay full size |
| `card` | `{ "card": { "title": "Invites", "subtitle": "in 40 seconds" } }` | full-screen title card (intro or outro), `theme: "light"` |
| `js` | `{ "js": "localStorage.clear()" }` | run code in the page (reset demo state) |

Targets (for `click`, `hover`, `glide`, `scroll`, `into`):

- `"Save"`: an element whose visible text, label, placeholder, aria-label or title equals or contains it (exact
  matches win; the innermost element wins; for `click`, buttons and links first).
- `{ "text": "Edit", "within": "Ada Lovelace" }`: the `Edit` inside the smallest element that contains "Ada Lovelace".
- `{ "text": "Edit", "within": { "selector": "tr", "text": "Ada" } }`, `{ "selector": "#save" }`, `"nth": 1`
  (0-based, among the matches), `"exact": true`.

## Writing good narration

- 1 to 2 short sentences per scene; about 2.5 words per second. The scene lasts as long as its voice clip plus
  0.9 s, so the narration sets the pace.
- Say what the viewer should notice, not what the cursor does ("Unpaid invoices are flagged in red", not "Now I
  click the invoices tab").
- `say` is for the ear, `caps` is for the eye: in `say` write numbers, dates and acronyms the way they should sound
  ("двести тридцать девять", "пи-ар", "API" → "эй-пи-ай" for Russian voices); keep `caps` short (≤ 60 characters,
  2 lines at most) and in normal spelling.
- Start with a `card` or a strong first screen; end on the result, not on a loading state.

## Report file

```json
{
  "title": "Invites: what changed",
  "subtitle": "One sentence on what this is.",
  "meta": ["Project", "2026-11-09"],
  "badge": { "text": "Ready for review", "tone": "ok" },
  "video": { "src": "out/demo.mp4", "chapters": true },
  "sections": [
    { "heading": "What changed", "md": "- **bold**, `code`, [links](https://example.com)\n- lists and paragraphs" },
    { "heading": "Screenshots", "stills": [{ "src": "out/stills/invite-dialog.jpg", "caption": "The invite dialog." }] },
    { "heading": "Checks", "checks": ["Tests pass", "Works on mobile"] },
    { "heading": "Open question", "tone": "warn", "md": "…" },
    { "heading": "Raw HTML", "html": "<table>…</table>" }
  ]
}
```

`chapters: true` lists the scenes (first subtitle of each) as clickable timestamps. `"stills": "out/stills"` takes
every image in the folder. `--no-embed` links the files instead of embedding them.

## Troubleshooting

- `not found: "…"` lists what is visible on the page: pick one of those texts, add `within`, or wait for the element
  with `waitFor` first. Elements inside iframes are not reachable.
- `timed out waiting for …`: the text never appeared. Check `out/failed-<scene>.jpg`; the app may need auth or data.
- `voice "X" is not installed`: System Settings → Accessibility → Spoken Content → System voice → Manage Voices.
- A login wall in the frames: the cookie name, domain or value is wrong; cookies without `domain` are set for `baseUrl`.
- `swift` errors about the SDK: run `xcode-select --install`.
- Re-runs reuse voice clips from `~/.cache/explainer-video/voice` (`--no-cache` to redo them).
- Flags: `--base`, `--out`, `--engine`, `--voice`, `--plan`, `--show` (visible Chrome window), `--keep` (keep raw
  frames), `--no-check`, `--no-cache`.
