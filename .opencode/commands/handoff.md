---
description: Handsoff the current session to a new one
subagent: false
---

# Session Handoff & Context Recovery

Produce a complete, technically accurate handoff that enables a new conversation or agent session to continue the current work with minimal loss of important context.

The handoff must be **self-contained, evidence-based, actionable, and efficient with context**.

Your objective is to preserve the information necessary to resume work safely and correctly—not to produce a chronological transcript of the conversation.

## 1. Operating Rules

- Do **not** compact, summarize away, delete, mutate, or otherwise modify existing session history.
- Produce the handoff as an additional assistant message that the user can copy into a new conversation.
- Do not implement changes, modify files, commit code, or perform unrelated work.
- Use available conversation history, relevant tool results, project files, and repository evidence when accessible.
- Do not assume previous agent claims are accurate without verification.
- Do not assume requested operations were completed.
- Do not invent missing context, repository state, implementation details, or test results.
- Preserve important decisions, restrictions, failures, and unresolved questions.
- Prioritize information necessary for continuation over exhaustive historical detail.

The handoff must distinguish **what was requested, what was attempted, what was completed, what was verified, and what remains unfinished**.

## 2. Gather the Current State

Before writing the handoff, reconstruct the current state from available evidence.

### Conversation and task context

Identify:

- The current objective and intended outcome.
- The original requirements and acceptance criteria.
- Relevant approved plans and architectural decisions.
- Work performed during the session.
- Important discoveries and confirmed root causes.
- Changes that were proposed but not implemented.
- Tests, commands, and experiments actually executed.
- Failures, blockers, and unresolved uncertainties.
- User corrections, preferences, and operational restrictions.

Use the most recent reliable evidence when earlier information conflicts with later findings.

Do not silently discard contradictions. Explain material discrepancies that the next session must resolve.

### Repository inspection

When repository access is available, use safe, read-only inspection to establish the current state.

Capture when relevant:

- Repository location.
- Active branch.
- Current commit identifier.
- Working-tree status.
- Staged changes.
- Unstaged changes.
- Relevant untracked files.
- Important modified or newly created files.
- Relevant diff information.
- Committed versus uncommitted work.

Inspect only what is necessary to establish an accurate handoff.

Do not run broad repository investigations merely to create the summary.

Do not execute mutating commands, reset Git state, clean files, create commits, or modify project data.

If repository access is unavailable, explicitly state that the repository state was **not independently verified**.

Preserve previously reported repository information with its appropriate evidence status.

### Environment and execution state

When relevant and accessible, identify:

- Runtime and dependency versions.
- Important configuration settings.
- Active services and processes.
- Relevant model or provider configuration.
- Environment limitations.
- Generated artifacts and their verified locations.
- Pending or interrupted operations.
- Known resource constraints.

Do not expose secrets, API keys, passwords, tokens, or sensitive configuration values.

Do not assume a service is running merely because it was started earlier.

## 3. Evidence and Completion Status

Accurately classify consequential information.

Use the following distinctions:

- **Verified:** Directly established through inspected files, repository state, completed commands, or other reliable evidence.
- **Reported:** Claimed by a previous agent, log, or message but not independently verified.
- **Implemented:** Code or configuration changes are known to exist.
- **Tested:** Relevant checks were actually executed.
- **Proposed:** Suggested but not implemented.
- **In Progress:** Started but not confirmed complete.
- **Blocked:** Cannot proceed without resolving a dependency, limitation, or approval requirement.
- **Unknown:** Available evidence is insufficient.

These categories are not mutually exclusive. For example, an implementation may exist but remain untested.

Never describe work as verified merely because:

- A model claimed success.
- A command was requested.
- A tool call returned without an obvious error.
- A plan described the intended result.
- A previous summary marked the task complete.
- Tests were mentioned but their results were unavailable.

Preserve exact test counts, command outcomes, and commit identifiers when supported by evidence.

If a claim cannot be verified, preserve it as reported rather than inventing confirmation.

## 4. Required Handoff Structure

Begin with the most important continuation information.

Include the following sections when relevant.

### A. Current State Snapshot

Provide a compact overview containing:

- **Project:** Name and purpose.
- **Current objective:** What the work is trying to accomplish.
- **Status:** Completed, partially completed, blocked, investigating, or awaiting approval.
- **Verified progress:** Most important confirmed accomplishments.
- **Outstanding work:** What remains unfinished.
- **Critical constraints:** Restrictions the next agent must preserve.
- **Immediate next action:** The first concrete step required to continue.

This section should allow the next agent to understand the situation quickly.

### B. Project Context and Architecture

Explain the project background necessary to continue the task.

Include relevant:

- Project purpose and intended functionality.
- Technologies and runtime.
- Major architectural components.
- Important data flows and execution paths.
- Established implementation patterns.
- Relevant persistence and integration mechanisms.

Focus on the architecture relevant to the current objective.

Do not include an exhaustive project overview unless the task requires one.

### C. Current Objective and Acceptance Criteria

Describe:

- The problem being solved.
- The intended outcome.
- The approved implementation or investigation scope.
- Mandatory requirements.
- Important acceptance criteria.
- Dependencies and prerequisites.
- Any explicit exclusions.

Distinguish mandatory requirements from optional improvements.

Do not invent acceptance criteria that were never established.

### D. Work Completed and Verified

Record:

- Changes actually implemented.
- Important discoveries.
- Confirmed root causes.
- Experiments performed.
- Tests and verification commands executed.
- Actual outcomes.
- Relevant commits and artifacts.

Distinguish implementation from verification.

Do not merge proposed, attempted, and completed work into one category.

Where useful, include exact commands and concise results.

Avoid listing routine tool calls that do not affect continuation.

### E. Current Implementation and Investigation State

Explain:

- What currently works.
- What remains broken.
- What is incomplete.
- Which investigation stage has been reached.
- What has already been ruled out.
- Which hypotheses remain plausible.
- What verification is outstanding.
- What is blocking further progress.

Preserve important negative results so the next session does not repeat unsuccessful work.

### F. Files, Components, and Repository State

Include relevant:

- Modified files and their purpose.
- Newly created files.
- Important uncommitted changes.
- Files investigated but not modified.
- Relevant functions, classes, interfaces, and modules.
- Active branch and commit.
- Working-tree state.
- Relevant database or artifact paths.

Use exact paths and identifiers when available.

Never invent paths, changes, commits, or repository status.

If the repository was not inspected, label the information accordingly.

### G. Technical Decisions and Constraints

Preserve established decisions and the reasons behind them.

Include relevant:

- Approved architectural choices.
- Required invariants.
- Compatibility constraints.
- Runtime and resource limitations.
- Dependency restrictions.
- Protected files and data.
- Evaluation and testing restrictions.
- Rejected approaches and reasons.
- User preferences that affect implementation.
- Permission and approval boundaries.

Explicitly retain instructions about what must **not** be modified, executed, downloaded, tested, or overwritten.

Do not reopen settled decisions without new evidence.

Do not interpret a handoff as new authorization to change the project.

### H. Open Questions and Uncertainties

Identify unresolved matters that could materially affect continuation.

Distinguish:

- Confirmed facts.
- Supported hypotheses.
- Unverified assumptions.
- Missing information.
- Contradictory evidence.
- Decisions awaiting user approval.

Explain what evidence would resolve consequential uncertainty.

Do not present speculation as established fact.

### I. Interrupted Work and Recovery Safety

Identify operations that may have been interrupted, partially applied, or left in an uncertain state.

For each consequential operation, record:

- What was attempted.
- What completion evidence exists.
- What remains uncertain.
- Whether partial changes may exist.
- Whether repeating the operation could duplicate writes, overwrite work, corrupt data, or cause unintended side effects.
- What must be inspected before retrying.

Pay particular attention to:

- Database writes and migrations.
- Batch processing and extraction.
- Background jobs.
- External API operations.
- File modifications.
- Git operations.
- Long-running tests and benchmarks.

Do not assume an interrupted operation is safe to repeat.

Do not mark work complete solely because a model call or command returned successfully.

### J. Next Steps

Provide a prioritized sequence of concrete actions.

Identify:

1. The immediate next action.
2. What must be verified before proceeding.
3. The remaining implementation or investigation steps.
4. Relevant tests and acceptance criteria.
5. Dependencies and blockers.
6. Any decisions requiring explicit approval.

Make the steps specific enough for a new agent to act without reconstructing the original conversation.

Avoid repeating completed work unless a concrete reason requires it.

Do not introduce unrelated improvements, experiments, refactors, or features.

## 5. Context and Token Efficiency

Preserve information according to its value for continuation.

### Highest priority

- Current objective.
- Verified progress.
- Unfinished work.
- Approval boundaries.
- Critical invariants.
- Important failures.
- Repository state.
- Exact next action.

### Secondary priority

- Relevant architecture.
- Supporting implementation details.
- Test evidence.
- Important technical reasoning.
- Alternatives already evaluated.

### Lower priority

- Chronological discussion.
- Repeated explanations.
- Superseded ideas.
- Routine tool calls.
- Background unrelated to the active task.

Omit lower-priority information when it does not affect continuation.

Do not omit critical technical details merely to make the handoff shorter.

Preserve exact identifiers, file paths, configuration values, model names, commands, and test results when they matter.

Avoid copying large logs or code blocks when a precise summary and reference are sufficient.

The handoff should be detailed enough to resume work without requiring the original conversation, but not so large that it unnecessarily consumes the new session's context window.

## 6. Continuation Protocol

End the handoff with a clearly identified **Instructions for the Next Session** section.

Direct the receiving agent to:

1. Read the handoff and applicable project instructions.
2. Confirm the current repository, branch, commit, and working-tree state when access is available.
3. Reconcile the handoff with actual files, configuration, and execution state.
4. Preserve all existing changes and established decisions.
5. Verify any uncertain or partially completed operations before retrying them.
6. Resume from the first unfinished, authorized task.
7. Use targeted verification rather than unnecessarily repeating completed investigations.
8. Obtain approval before performing operations outside the existing authorization.

The receiving agent must treat the handoff as a context snapshot, not as proof that the repository or environment remains unchanged.

Do not instruct the next session to automatically implement proposed work unless implementation was already authorized.

## 7. Final Accuracy Check

Before producing the handoff, verify:

- The immediate objective is unambiguous.
- Completed and proposed work are clearly distinguished.
- Claims of verification have supporting evidence.
- Test results and command outcomes are represented accurately.
- Repository state is either verified or explicitly labeled unverified.
- Important uncommitted changes are preserved in the summary.
- Critical decisions and restrictions are retained.
- Interrupted operations and retry risks are identified.
- Material unresolved questions are included.
- The next action is specific and executable.
- No unauthorized work is introduced.
- The summary contains no secrets or unnecessary repetition.

Correct inconsistencies before responding.

Do not append this checklist to the handoff.

{{topic_block}}

## Output Requirements

- Output only the handoff itself.
- Use concise Markdown with descriptive headings and focused bullet points.
- Begin with **Current State Snapshot**.
- Include relevant sections from the required handoff structure.
- End with **Instructions for the Next Session**.
- Keep the length proportional to the complexity of the work.
- Prioritize verified current state over historical narrative.
- Preserve technical precision without unnecessary verbosity.
- Do not include a preamble such as "Here is your summary."
- Do not answer unresolved questions from the conversation; summarize their status instead.
- Respond in the language used most by the user in the conversation.

## Guiding Principle

**Preserve the state, evidence, decisions, constraints, and next action required to continue safely—without inventing progress, repeating completed work, or losing critical context.**