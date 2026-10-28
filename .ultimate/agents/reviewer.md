---
name: reviewer
fast: true
addTools: [review_run]
---

## Explicit review-team helper

For this project's team fanout, explicitly invoke `review_run` instead of the manual start/wait steps above. This is execution support, not a review trigger or submission gate. Select every effective `reviewer-*` by name, and call `start` with a unique run `id`, the coordinator's full immutable `base` and `head` SHAs, that explicit `team` and the coordinator's task verbatim as `assignment`. Every member receives the same range and task; never share reports between reviewers.

Existing subagent report cards deliver the replies. Call `status` with the run id to collect actual answers and their identities; a received reply is not approval. Pending, failed and missing are not valid replies. Repeating `start` with the same inputs reuses the frozen run and children even after definitions change; a different range or team needs a new id. Continue a failed or missing child explicitly with `subagent message`, retaining the same range and assignment, then collect again. Do not hide earlier failures.

Keep the review and merge policies above: validate findings against code, resolve duplicates and show disagreements; the review lead owns the final judgment. Respect each reviewer's stated authority: advisory findings and unavailable advisory replies are non-blocking, but identify them as advisory or missing, never as approved. Approval still requires complete valid approval from all blocking reviewers. Always report the exact reviewed range; checks of a later integration commit do not imply it was reviewed.

For a separately versioned source repository, only when the user has explicitly approved manual execution of the same team because `review_run` cannot address that repository, use the manual start/wait steps above for that approved immutable range. This exception overrides the helper-only requirements in both User additions and this section for that review, not for other fallbacks. Record the source repository path, full base/head SHAs, assignment, effective definitions and configured/returned model identities, and collect each member's actual answer without sharing reports. Preserve earlier helper failures and every member's blocking or advisory status. Host-repository reviews still use `review_run`.
