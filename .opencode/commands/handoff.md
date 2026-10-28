---
description: Handsoff the current session to a new one
subagent: false
---

Produce a technical handoff summary that enables a new conversation to continue this work with minimal loss of context.

Do NOT compact, mutate, or otherwise modify session history. Your output is an additional assistant message that the user may copy into a new conversation.

Use the available conversation history and relevant tool results to establish the current state of the work. Do not assume that proposed changes were implemented or that commands succeeded simply because they were requested.

## Handoff Contents

Include the following sections when relevant:

### 1. Project Context
- What the project is intended to accomplish.
- Relevant architecture, technologies, and established implementation patterns.
- Background information necessary to understand the current task.

### 2. Current Objective
- The immediate goal being worked toward.
- The problem being solved and the intended outcome.
- Any requirements that define successful completion.

### 3. Work Completed
- Changes actually implemented and their purpose.
- Important discoveries and confirmed root causes.
- Tests, commands, and verification steps actually performed, including their results.
- Distinguish completed work from proposed, planned, or unverified work.

### 4. Current State
- What currently works, what remains broken, and what is incomplete.
- The current implementation or investigation stage.
- Any errors, blockers, or outstanding concerns necessary to resume work.

### 5. Files and Components
- List relevant files that were modified or created, with a brief explanation of what changed and why.
- Include important uncommitted changes when known.
- Identify relevant files that were investigated but not modified when they are necessary for understanding the implementation.
- Never invent file paths, changes, or repository state.

### 6. Technical Decisions and Constraints
- Record important decisions and the reasoning behind them.
- Preserve established architectural choices unless the user explicitly approved changing them.
- Include required behavior, dependencies, compatibility constraints, protected files, and approaches that were rejected.
- Explicitly retain instructions about what must not be modified, executed, downloaded, or tested.
- Preserve relevant user preferences and corrections that affect how the work should proceed.

### 7. Open Questions and Uncertainties
- Identify unresolved questions, assumptions, and findings that still require verification.
- Clearly distinguish confirmed facts from hypotheses.
- Record missing information that could materially affect the implementation.
- Do not present guesses as established facts.

### 8. Next Steps
- Provide a prioritized, actionable sequence for continuing the work.
- Identify the immediate next action, not just the overall goal.
- Include relevant tests and acceptance criteria.
- Note any prerequisites or decisions requiring user approval.
- Avoid repeating completed steps unless they need to be repeated for a specific reason.

## Accuracy Requirements

- Prioritize information necessary to continue the work over a chronological transcript.
- Preserve exact identifiers, file paths, configuration values, model names, commands, and other technical details when they matter.
- Report test results and command outcomes only when supported by available evidence.
- Do not claim to have inspected files, run commands, or verified behavior without evidence.
- Do not invent implementation details to fill gaps.
- Preserve important failures, limitations, and rejected approaches so the next conversation does not repeat unsuccessful work.
- If the current conversation contains no evidence that a change was implemented, describe it as planned or proposed.
- Include only relevant context; omit unrelated discussion and repetitive details.
- Do not recommend additional features, refactors, or experiments unless they are necessary to complete the stated objective.

{{topic_block}}

## Formatting

- Use concise Markdown with short, descriptive headings and bullet points.
- Keep the handoff proportional to the complexity and duration of the work.
- Be thorough enough to resume the work without relying on the original conversation, but do not pad the summary.
- Put the most important current state, constraints, and next action first when practical.
- Do not include a preamble such as "Here is your summary."
- Do not answer questions from the conversation; summarize the relevant context and decisions instead.
- Respond in the same language the user used most in the conversation.