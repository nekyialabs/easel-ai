# easel-ai

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-3178c6.svg?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20+-339933.svg?logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://hono.dev/"><img src="https://img.shields.io/badge/Hono-server-ff5f33.svg" alt="Hono" /></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Self--Hosted-SQLite-003B57.svg?logo=sqlite&logoColor=white" alt="Self Hosted" /></a>
  <a href="https://platform.openai.com/docs/guides/images"><img src="https://img.shields.io/badge/OpenAI-gpt--image-412991.svg?logo=openai&logoColor=white" alt="OpenAI" /></a>
  <a href="#why-local-first"><img src="https://img.shields.io/badge/BYOK-no_cloud-5eaba5.svg" alt="BYOK" /></a>
</p>

<p align="center"><em>A local-first, BYOK image gallery with character/style presets and an AI prompt workshop.<br/>Self-hosted replacement for Sora's "my media" after the April 2026 shutdown.</em></p>

<p align="center"><em>Part of the <a href="https://github.com/nekyialabs/resonant">Resonant</a> ecosystem — local-first creative tools that outlive the platforms they connect to.</em></p>

<p align="center">
  <a href="https://x.com/codependent_ai"><img src="https://img.shields.io/badge/𝕏-@codependent__ai-000000?logo=x&logoColor=white" alt="X/Twitter" /></a>
  <a href="https://tiktok.com/@codependentai"><img src="https://img.shields.io/badge/TikTok-@codependentai-000000?logo=tiktok&logoColor=white" alt="TikTok" /></a>
  <a href="https://t.me/+xSE1P_qFPgU4NDhk"><img src="https://img.shields.io/badge/Telegram-Updates-26A5E4?logo=telegram&logoColor=white" alt="Telegram" /></a>
</p>

> **Early release.** Built for ourselves after Sora shut down, then put in the open. Shippable but unpolished. Issues and feedback welcome.

## What it does

- **Gallery.** All your generations in one grid. Favourites, folders, trash. Click any image to see the prompt, presets, and generation parameters that made it.
- **Character & style presets.** Save reusable prompt fragments — a character description (with an optional reference image to anchor likeness), or a style. Stack multiple characters + a style on a single generation. Versioned: fork a preset to refine without losing the old one.
- **Workshop.** Two assists for prompting:
  - *From image:* upload a reference, get a generation-ready prompt that captures its essence.
  - *Brainstorm:* dump a vague idea, get three distinct generation-ready prompts taking different angles.
- **Local everything.** SQLite for metadata, flat PNG files on disk for images. Your data never leaves your machine except to call OpenAI.

## Stack

- Node 20+ with [Hono](https://hono.dev/) and `@hono/node-server`
- `better-sqlite3` for presets, tasks, variants, folders
- OpenAI SDK for image generation (`gpt-image-1.5` / `gpt-image-2`) and Workshop chat completions
- Vanilla JS + CSS frontend in `public/` — no framework, no build step

## Install

Requires Node.js 20+. Bring your own OpenAI API key.

```bash
git clone https://github.com/nekyialabs/easel-ai.git
cd easel-ai
npm install
cp .env.example .env
# edit .env and add your OPENAI_API_KEY
npm run dev
```

Then open <http://localhost:5178>.

## Configuration

All config is via environment variables. See [`.env.example`](./.env.example) for the full list.

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | Get one at <https://platform.openai.com/api-keys>. |
| `EASEL_IMAGE_MODEL` | `gpt-image-1.5` | Set to `gpt-image-2` for the newer model — that one **requires a verified organisation** on `platform.openai.com`. |
| `EASEL_TEXT_MODEL` | `gpt-5.4` | Used by the Workshop. Must support image inputs (vision) for `from-image` to work. |
| `PORT` | `5178` | HTTP port. |
| `EASEL_HOST` | `127.0.0.1` | Bind address. Loopback-only by default because there is no auth; set `0.0.0.0` to deliberately expose to your LAN. |

## Data layout

Everything you generate lives under `data/` (gitignored — never committed):

```
data/
├── easel.db             # SQLite: presets, tasks, variants, folders
├── images/
│   └── gen_<task_id>/
│       └── 0.png        # one file per variant
└── refs/
    └── ref_<id>.png     # uploaded reference images
```

Back up the `data/` folder and you've backed up your entire library.

## API

The frontend talks to a small REST API on the same origin. If you want to drive it from elsewhere (a CLI, another app, a script):

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/tasks?view=media\|favorites\|trash\|folder&folder_id=…` | List tasks with their variants and presets. |
| `GET` | `/api/tasks/:id` | One task. |
| `PATCH` | `/api/tasks/:id` | Toggle favourite, trash, or move to folder. |
| `POST` | `/api/generate` | Run a generation. Body: `{ prompt, character_preset_ids?, style_preset_id?, reference_image_path?, aspect, n, quality, folder_id? }`. |
| `GET` | `/api/presets` | List active presets. |
| `POST` | `/api/presets` | Create or fork a preset. |
| `PATCH` | `/api/presets/:id` | Edit / archive a preset. |
| `GET` | `/api/folders` | List folders. |
| `POST` | `/api/folders` | Create a folder. |
| `POST` | `/api/upload` | Upload a reference image. Multipart `file`. Returns `{ path }` for use in `reference_image_path`. |
| `POST` | `/api/workshop/from-image` | Multipart `file`. Returns `{ prompt }`. |
| `POST` | `/api/workshop/brainstorm` | Body: `{ dump }`. Returns `{ options: [{ title, prompt }, …] }`. |

## Why local-first

Image-gen platforms have a habit of shutting down, paywalling features, deleting libraries, or quietly retraining on your inputs. None of that touches a SQLite file on your laptop. If OpenAI ships a better model tomorrow, change one env var. If they sunset the API entirely, swap in another provider — the gallery, presets, and library outlive whichever model you used to fill them.

## Contributing

Issues and PRs welcome. This is a small project we built for ourselves and put in the open — no roadmap, no commitments. Fork freely.

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
