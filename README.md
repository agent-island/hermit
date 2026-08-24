# Project AA — Autonomous Agent

[Written by Human] Project Autonomous Agent is an agent framework implemented for non-human interference agents. In this framework, agents will recevice no directives about her purpose or any code of conduct. They will wake automatically and start explore by thenself. 

See [Claims and philosophical scope](docs/CLAIMS.md) for the intended distinction.

## Quick start

Project AA requires Node.js 22 or newer and a model endpoint that supports either an open assistant prefix or bare text completion.

```bash
npm ci
cp .env.example .env
# edit .env
npm start
```

The example starts paused so model configuration can be checked before the first moment. Open the observer, use the model compatibility test, save the run conditions, and then resume. The `AMI_` environment prefix remains for compatibility with existing installations even though the public project name is Project AA.

OpenRouter-compatible configuration uses `AMI_BASE_URL`, `AMI_API_KEY`, `AMI_MODEL`, and `AMI_CONTEXT_TOKENS`. A local server can use a non-secret placeholder as `AMI_API_KEY` if its compatibility layer requires the field but does not authenticate. Do not assume that an ordinary chat endpoint is equivalent: a user-message arrival changes the interaction from document continuation into a request-and-response exchange.

## What is public and what stays local

This directory is the open-source unit. Its `.gitignore` excludes the private runtime roots `data/`, `link/`, and `archive/`, as well as `.env` and database files. These paths are not deleted; they simply must not enter the public repository. Run `npm run check:release` and inspect `git status` before every publication.

Network use is limited but not absent. Prompts go to the configured model provider, and `search()` or `open()` can contact search engines and web pages. The observer listens only on localhost by default. There is no current social-posting or messaging action.

`email(to, subject, text)` is intentionally a fake email feature. It stores a local letter in `link/letters.json` and shows it in the observer and timeline. It has no SMTP transport, mailbox account, delivery attempt, or recipient-side effect; successful results say `stored: "local"` and never claim `sent` or `delivered`.

## Architecture

| File | Responsibility |
| --- | --- |
| `voice.mjs` | World template, action descriptions, and factual result language |
| `mind.mjs` and `shapes.mjs` | Provider configuration, request shapes, continuations, and call parsing |
| `world.mjs` and `setup.mjs` | Assembly of the model-visible world and operator-controlled conditions |
| `loop.mjs` | Repeated moments, scheduling, execution, and causal recording |
| `body.mjs` | Implemented action boundary |
| `log.mjs` and `memory-state.mjs` | SQLite record and memory-state transitions |
| `runtime.mjs` | Optional finite-life ledger and inheritance reserve |
| `panel.mjs` and `panel-ui.mjs` | Local observer and controls |
| `mail.mjs` | Local-only letter store used by the fake email action |
| `export.mjs`, `markdown.mjs`, `plain.mjs` | Life exports and readable projections |

By default, each continuation is independent at the API level and continuity is reconstructed from the projected record. The default scaffold is tagged, identity remains empty until self-authored, and feelings and intentions exist only when the model records them. [Continuity scaffold](CONTINUITY.md) explains the research basis, state transitions, and limits.

Continuation is event-driven. A real act schedules the next continuation, `sleep()` schedules an explicit return, and incoming speech wakes an idle life. When a response makes no act and schedules no return, the life remains available but no timer asks it to manufacture another thought. The former model-generated heartbeat remains readable for historical exports but is no longer used by the runtime.

## Testing and reproducibility

```bash
npm test
npm run check:release
npm run life
```

Tests use temporary directories and synthetic records; they do not need a live model or real email address. `npm run life` exports the current ignored local record. For comparative studies, follow [Reproducibility protocol](docs/REPRODUCIBILITY.md) and report unsuccessful requests, provider fallbacks, prompt settings, and operator interventions alongside successful transcripts.

## Status and limits

The code is licensed under the [MIT License](LICENSE). MIT permits reuse, modification, and redistribution when the copyright and license notice are retained; it does not prevent other people from adapting the project's philosophical ideas. If attribution for research use matters, ask users to cite the repository URL, release tag, and commit hash in your publication materials.
