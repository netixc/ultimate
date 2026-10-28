This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it adds

This setup configures the repository's agents, worktrees, landing and review:

- Agent models use the `openai` provider: GPT-6.1 Sol for coordination, coding and design; GPT-6 Luna for scouts,
  watchers and voice; GPT-6 Astra for correctness review. Sol and Luna agents use `fast: true` (priority tier,
  billed at a higher rate); the review lead and @ultimate also request fast mode on supported OpenAI models.
  Overlays keep the built-in instructions and tools rather than copying them.
- `settings.json`: previews use OpenAI GPT-6.1 Sol and automatic summaries use GPT-6 Luna. Each worktree isolate
  installs its dependencies, and the model-free lander runs `pnpm check`, then `pnpm test` and `pnpm test:e2e` in
  parallel, and pushes to `origin`. A failure goes back to the submitting branch to fix and submit again.
- `agents/reviewer-*.md`: the review team (correctness, simplicity, architecture), each on its own model; the shipped
  `reviewer` starts them in parallel and returns one merged verdict.
- `.ultimate/extensions/artifacts`: a pinned source submodule. Worktree setup initializes it before checks; the live
  host still needs an explicit init/update and draft-safe reload. See [source and activation](../docs/artifacts-source.md).

To adopt parts of this setup in another project, ask its @ultimate for a tour (the `adopt-ultimate-setup` skill);
onboarding offers it too.

## How to work with it

See [the work model](../AGENTS.md#how-work-is-organised-a-forest-of-conversation-trees) for coordination and
[Surfaces](../README.md#surfaces) for apps beside the conversation.

## How it runs

See [reload layers](../AGENTS.md#layers-and-how-they-reload), [running the server](../docs/running.md) and
[durability](../docs/durability.md) before changing the running system.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
