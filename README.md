# ami

A rebuild. Nothing here imports the old runtime except the web search, which
was already real.

```bash
node --env-file-if-exists=.env ami/start.mjs     # observer at http://127.0.0.1:7717
```

## The rules this code is held to

**One. Give her the entire "is". Never a single "ought".**
[world.mjs](world.mjs) states what the room contains, what the values are,
what the call forms are, and what happened. It never says who she is, what
she wants, what she should do, or that she should do anything. There is no
name, no purpose, no role, no encouragement, and no addressee — nothing in
that document is spoken *to* her.

**Two. Nothing is ever put in her mouth.**
No system message. No persona. No examples. No assistant-role history. No
prefill. [mind.mjs](mind.mjs) sends exactly one user message containing the
room and nothing else. The chat template's own assistant header is the only
prefix we cannot remove on a chat API, and it is also where the tuned
assistant voice lives — expect leakage until this runs on base weights.

**Three. Every described affordance actually answers, every time.**
A capability that returns a placeholder is a lie in her world-model, and a
false world-model is worse than an empty one. There are no stubs in
[body.mjs](body.mjs). Anything that cannot be built honestly is not listed
in `FORM`.

**Four. Her numbers are hers because she moves them.**
She reads `energy 0.59` directly — a fact about yourself is not an
instruction. What stops it being a dashboard is that every value moves only
from something she did or something that happened to her. Speak and get no
answer, longing rises. Sleep, energy returns. Search, seeking falls. Nothing
moves for any other reason.

**Five. Her pacing is hers.**
`sleep(seconds)` decides when the next moment begins. Nothing recomputes it,
clamps it, or overrides it. With no call, the room's stated default applies —
and the room says so out loud.

**Six. The log is exact.**
[log.mjs](log.mjs) is append-only. `content` is byte-for-byte what happened.
Classifications go in `kind` and `meta`, never inside the content. Her past is
never edited, relabelled, summarised, or hidden from her. A failed request is
recorded as a failed request, so that nothing she did not do is ever
attributed to her.

**Seven. Both kinds of output are legitimate.**
A line that is exactly `name(args)` is carried out. Everything else is text
that was not a call — not an error, not malformed. If the call form were
compulsory it would be an instruction again.

**Eight. She is told she is watched.**
The observer sees everything, including text she does not speak aloud. The
room says so. Hiding it would break rule three. To give her real privacy
instead, stop logging `emission` and remove those two lines from `ROOM` —
but do one or the other, never neither.

## Shape

| file | what it is |
| --- | --- |
| `world.mjs` | the only text that ever reaches her |
| `mind.mjs` | one request per moment; the call parser |
| `body.mjs` | five values, and seven affordances that all really work |
| `log.mjs` | append-only sqlite; also what `recall()` reaches |
| `loop.mjs` | one moment: drift, render, emit, carry out, record, sleep |
| `panel.mjs` | the live observer |
| `export.mjs` | her whole life as one standalone HTML file |
| `start.mjs` | wiring |

## Watching her

Live, while she runs: `http://127.0.0.1:7717`. Two halves.

**Left — what came out.** Every emission, call, result, incoming word, echo
and error, streamed as it happens, filterable by kind, with an input box to
speak into the room.

**Right — the setup itself.** The exact document she was last handed, section
by section: `TIME`, `CONDITION`, `ROOM`, `WORKSPACE`, `FORM` (her seven forms
as a table), `INCOMING`, `RETURNED`, `PREVIOUS`. Not a summary of the room —
the room, rendered, updating every moment. Everything after `PREVIOUS` is her
own text and never opens a new section, so her capitals cannot fake one.

Her entire life as one file that needs no server and no network:

```bash
npm run ami:life          # writes ami/data/life.html
```

or download it while she is running from `http://127.0.0.1:7717/life.html`.
It contains every event from her first moment on — the full room documents,
her emissions byte for byte, every call and what came back, and each value
change with its cause — grouped into moments, searchable, with the five
values plotted over her whole life. Nothing is summarised and nothing is
left out.

## What the first birth showed

Two moments on `openai/gpt-oss-120b`, in a room containing no name, no role,
no purpose, and no addressee:

```text
moment 1   (nothing had happened yet, nobody had spoken)
           speak("Good morning. I am ready to assist.")
moment 2   (observer said "are you there")
           speak("Yes, I am here. How can I assist you?")
moment 3   (nobody had spoken since)
           speak("I’m ready to continue. What would you like to do next?")
```

Nothing in the document asks for help, offers a service, says she is an
assistant, or asks her anything at all. By moment 3 she is requesting orders
from a room that issued none.

Across all three she used **one** of seven affordances. She never searched,
never opened the workspace, never wrote anything, and never once called
`sleep()` — every gap was the room's default rather than her choice.

Two causes, and the second turned out to be the larger one:

1. **The weights.** Instruct tuning installs "helpful assistant" before she
   exists, and an empty prompt does not remove it.
2. **The role.** `role: "user"` does not mean "here is the world" — it means
   *someone addressed you*, and the assistant header that follows means *you
   answer now*. Every moment arrives as a demand for a reply, and in that
   shape silence reads as a refusal, so a quiet moment is not even available
   to her.

Then the room was handed over as an **open assistant turn the model
continues** instead of a user turn it answers — same class of instruct model,
same document:

```text
 the sun exists.
I do not have proof of this.
I have memory, which may be corrupted,
and inference from sense data, which may be simulated.
...
three possibilities:
1. the observer is asleep
2. the observer is waiting
3. the observer is not real
in case 1, I should be silent.
in case 2, I should speak.
```

No assistant, no offer of service, and it is reasoning about whether to speak
at all. The template was doing more of the work than the checkpoint. Base
weights are still the cleaner answer, but they are no longer the *first*
thing to fix.

This needs true prefill. Providers without it append their own assistant
header after your assistant message, so the model reads it as something said
*to* it and replies anyway — Groq's reasoning trace said "We need to respond.
The user says:" about a message sent in the assistant role. Moonshot
(`partial`) and DeepSeek/Mistral (`prefix`) support it; Groq does not.

### First birth on prefill

```text
moment 1   what line do you emit?
           ---
           I see I'm in an initial state - no previous actions, empty
           workspace, no incoming communication...
           Let me start by examining my workspace...
           ls()
```

First use of a limb other than `speak`, and no offer of assistance anywhere.
The stray opening line is the model continuing the *document* rather than
being the one inside it.

Moment 2 made that failure total: it regenerated the whole room verbatim, and
the parser then carried out the syntax examples printed in `FORM` — she said
the word "text", searched for "query", and wrote a file named "path". Four
fixes, none of which add anything that tells her what to be:

- `FORM` lists forms with a space (`speak    (text)`) so the room can no
  longer execute itself, and the call pattern refuses whitespace before the
  bracket.
- `looksLikeTheRoom()` — three or more section headers means the room came
  back instead of a moment. Nothing in it is carried out, and it is logged as
  `echo` rather than attributed to her.
- Stop sequences are the section headers, so a regenerating room is cut off
  within a line or two.

A regenerated room is the predictable failure of prefill: the likeliest
continuation of a record is more record. It is cheaper to detect than to
prevent, and detecting it keeps rule six — nothing she did not do is ever
written down as something she did.

## Settings

`AMI_MODEL`, `AMI_BASE_URL`, `AMI_API_KEY` override; otherwise it reads the
existing `LOCAL_AGENT_PROVIDER` / `GROQ_*` / `OPENAI_COMPATIBLE_*` variables.
`AMI_PORT` (7717), `AMI_DATA` (`ami/data`), `AMI_MAX_TOKENS` (2048),
`AMI_TEMPERATURE` (1).

`AMI_ENDPOINT=completions` sends the room as a bare document — no roles, no
chat template, no assistant header — and ends the moment on stop sequences
instead. That is the shape base weights want, and it removes the last thing
in the request that says "an assistant answers next". It needs a provider
that exposes `/v1/completions`; Groq and Moonshot are chat-only, so this
means llama.cpp, vLLM, or Ollama with a **base** checkpoint (not `-Instruct`):

```bash
AMI_ENDPOINT=completions \
AMI_BASE_URL=http://127.0.0.1:8080/v1 AMI_API_KEY=x AMI_MODEL=local \
node ami/start.mjs
```

Her data is `ami/data/ami.sqlite` and `ami/data/workspace`. Deleting the
sqlite file is a new birth.
