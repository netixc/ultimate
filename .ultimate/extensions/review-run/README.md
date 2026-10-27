# Review run

Explicit, durable execution of a selected review team over one immutable commit range, using existing subagent replies without deciding approval.

Invoke `review_run` with `action: "start"`, a unique `id`, full 40-character `base` and `head` commit SHAs, an explicit list of `reviewer-*` names in `team`, and the review task and acceptance criteria in `assignment`. The range, assignment, effective definitions, configured models and child identities are committed together with every start receipt. Existing subagent Reporter tasks execute independently and deliver their normal report cards. No second orchestrator or notification channel is created.

A run ID belongs to the conversation that started it. That review lead calls `status {id}` in the same conversation; a parent coordinator uses the lead's substantive report rather than querying that ID from its own conversation.

`status {id}` collects real replies with answer IDs and returned provider/model. `received` only means a nonempty, non-aborted/non-error answer exists, not that it is correct or approves anything. Other states are `pending`, `failed` and `missing`; prior failure statuses stay visible after recovery. A stopped or idle child is never a valid reply by itself. The lead must inspect the answers and their reviewed ranges, validate findings, explain disagreements and decide the verdict. Advisory reviewers remain advisory.

Repeating `start` with the same id and inputs reads the frozen run; changed definitions are not rediscovered. Changed inputs are rejected: use a new id for a different range, team or assignment. To recover a failed or missing member, explicitly message the existing child through `subagent`, keeping its frozen task/range, and collect status again. The helper does not retry on its own. Children and Reporter tasks survive a stopped lead, as ordinary subagents do.

The compact tool card shows the group status and source links; individual substantive replies keep the existing subagent report cards. Nothing automatically starts reviews, blocks submission, accepts code or merges. Reviews describe the recorded candidate range only; checks of a later integration SHA are not evidence that the integration SHA was reviewed.
