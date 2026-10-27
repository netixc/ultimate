---
name: ultimate-provider-smoke
description: Check a change whose behaviour depends on the provider or model itself (latency, streaming of tool arguments, a pinned agent model, login or fallback, prompt caching) on the model it is meant for, with one short real turn on a supervised scratch server. Use when a preview cannot show it because `instance start` forces every agent onto `instance.model`.
---

# Smoke-test the real provider

A preview (`instance start`) runs every agent on `instance.model` through `ULTIMATE_MODEL`, which overrides the
agent pins, the root model and `summaryModel`. Whatever depends on the model itself stays invisible there. This
recipe runs the branch's checkout as a supervised scratch server without `ULTIMATE_MODEL`, so the configured models
run, and spends one or two short turns on them. Use it only when the requested verification needs a real provider
turn; documentation-only changes do not warrant paid probes.

This project uses the `openai` provider only, never `openai-codex` or another provider as a fallback. Preserve the
project's Sol/Luna/Astra assignments, Sol/Luna `fast: true` definitions and model-wide fast settings. Check the
effective definitions and inherited root model on the scratch server before sending: a configured pin alone is not
runtime evidence. If the intended OpenAI model is unavailable, stop and report it; do not enable another provider.

## Start it

From the branch's worktree. This is the scratch-server command from `docs/running.md`, run in the background:

```bash
H=$(mktemp -d /tmp/ultimate-smoke-XXXX)
env $(env | grep -o '^ULTIMATE_[A-Z_]*' | sed 's/^/-u /') ULTIMATE_HOME="$H" \
  pnpm start --port 0 --no-open > "$H.log" 2>&1 &
echo "supervisor pid $!"
```

- Unset every inherited `ULTIMATE_*`: an agent's shell carries the live server's `ULTIMATE_HOME`, `ULTIMATE_PROJECT`
  and the rest. Use its own home and port, never the project's default home.
- This also clears the preview's `ULTIMATE_MODEL` override from `instance.model`.
- OpenAI authentication is read in place through Pi's `~/.pi/agent`. Never read, print or copy authentication files,
  credentials or secrets into the scratch home. Do not probe other providers' login or config directories.
- `--port 0` asks the OS for an available port. Read the scratch URL from `$H.log` and set `URL` to that exact URL
  (without a trailing slash); use it below, not a guessed port or the live host. Wait until
  `curl -s -o /dev/null -w '%{http_code}' "$URL/"` returns `200` and the log
  says `supervisor: ready`.
- To try a different model, set it the way a user would: an agent definition or a project setting in the checkout,
  or the composer's model picker on the scratch server. Do not use `ULTIMATE_MODEL`.

## Drive one turn

Screenshot the scratch URL. Its header shows @ultimate's `#<id>` and its composer shows the model. Then send
to that conversation explicitly. A send without `conversation` targets conversation 1, the root.

```json
{"url": "<scratch-url>/?conversation=<id>", "steps": [
  {"send": "Reply with exactly the word: pong. Do not call any tools.", "conversation": <id>},
  {"until": "idle", "conversation": <id>, "timeoutMs": 180000}
], "screenshot": true}
```

Use a prompt that exercises only the behaviour under test: one tool call to watch streaming arguments, or two sends
to see the cache read on the second one. Stop after one or two turns.

## Read the evidence

The scratch server is not in the host's project list. Inspect its actual `pi.agent` and `pi.usage` in that server's
codemode (`ultimate.doc('pi.agent', <id>)` and `ultimate.doc('pi.usage', <id>)`), or use the model-call trace below.
Do not mistake the shared host's documents or effective definitions for the scratch server's.

Read the scratch home's active chapter directly, read-only (the first chapter lives at `$H`; later ones live under
`$H/chapters/<name>`; see `lib/chapters.ts`):

```bash
C=$(node --input-type=module -e 'import { activeChapter } from "./lib/chapters.ts"; console.log((await activeChapter(process.argv[1])).dir)' "$H")
# every model call: conversation, provider/model, wall time in ms, usage and stop reason
sqlite3 -readonly "$C/trace.sqlite" \
  "select conversation, name, round(ms), result from calls where kind='model' order by at"
```

`pi.agent.model` is the conversation's current model; confirm the measured turn's provider/model in its trace.
`pi.usage` has cumulative tokens, cache reads and writes, and cost; use the measured call's trace for per-turn numbers.
The trace also lists background calls such as titles and summaries on `summaryModel`. Keep those apart from the turn
you measured.

## Clean up

```bash
kill <supervisor pid>    # not pkill -f: the pattern matches your own shell and kills it
curl -s -o /dev/null -w '%{http_code}\n' "$URL/"   # 000 once it is down
rm -rf "$H" "$H.log"
```

## Report

State the model that ran, taken from `pi.agent` or the trace, not the configured one. Give the measured numbers: the
model call's milliseconds, its input, output and cache tokens, and the cost. Name what you could not reach as
unverified. Leave out machine names and addresses.
