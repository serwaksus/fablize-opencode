# fablize-opencode

An [opencode](https://opencode.ai) plugin that enforces execution discipline — ported from [fivetaku/fablize](https://github.com/fivetaku/fablize) (originally built for Claude Code).

Makes any LLM (tested with GLM-5.2) **reach its own ceiling** by enforcing verification, preventing premature completion, and tracking evidence — without raising the model's reasoning capability.

## What it does

Forces the model to verify its work through **5 plugin hooks** and **10 enforced rules**:

- **Verification grounding** — every "done" claim must be backed by a real verification command (test/lint/typecheck), not just `echo` or `pwd`
- **Completion gate** — write/edit without a relevant verification command after it → BLOCKED. Empty ledger + "done" in work modes → BLOCKED
- **Evidence ledger** — tracks every tool call with exit codes, test results, file paths, and verification status
- **Compaction memory** — preserves task state (goal, files changed, verifications, pending gates) across context compression
- **Conditional mechanisms** — zero overhead on simple tasks, activate only when triggered

## Architecture

```
5 hooks:
├── experimental.chat.system.transform  — 10 rules + task prompts + conditional gates
├── chat.params                         — temperature/effort (non-destructive, respects existing)
├── experimental.chat.messages.transform — completion gate + diff review evidence check
├── tool.execute.after                  — evidence ledger (exit codes, test results, verification)
└── experimental.session.compacting     — continuation state across context compression

Conditional mechanisms (zero overhead when not triggered):
├── Blind-spot gate        — risky keywords (migration, auth, API, money, schema) only
├── Plan contract           — complex modes (audit, debug, coding) only
├── Project invariants      — if .opencode/fablize-invariants.md exists
├── Diff review             — 3+ unique files or risky file patterns
└── Completion gate         — work modes (coding, debug, audit, financial) only
```

## The 10 Rules (base prompt)

| Rule | What it enforces |
|------|-----------------|
| R1 | Verification grounding — run code, show output before "done" |
| R2 | Completion gate — programmatic check: write → must verify (relevant command) |
| R3 | Systematic investigation — reproduce → 2+ hypotheses → causal chain |
| R4 | No unsupported claims — "this should work" is forbidden |
| R5 | Journal update — log non-trivial tasks to agent-journal.md |
| R6 | No mental math — financial calculations >100 require Python (financial modes only) |
| R7 | Step references — cite numbers with source |
| R8 | Always state units — every number needs units (financial modes only) |
| R9 | Show conversion formulas — ÷1000 visible (financial modes only) |
| R10 | Persistence — try 2+ approaches before BLOCKED, but NEVER retry destructive ops |

Rules 6-9 are **task-specific** — injected only in audit/financial modes, not in coding tasks.

## Task Modes

9 task modes with adaptive parameters:

| Mode | Triggers | Temp | Effort | Extra prompts |
|------|----------|------|--------|---------------|
| creative | "придумай", "brainstorm" | 0.7 | high | — |
| audit | "аудит", "сверк", "ebitda" | 0.1 | max | Financial rules + audit checklist |
| debug | "баг", "crash", "traceback" | 0.2 | max | Debug protocol + coding rules |
| coding | "измени", "реализуй", "refactor" | 0.2 | high | Coding contract |
| create | "создай", "generate" | 0.3 | high | Create + readback |
| financial_verify | "проверь", "контрольн" | 0.1 | max | Financial rules |
| financial_analyze | "почему", "объясни" | 0.4 | max | Financial rules |
| financial_hypothesis | "предложи", "вариант" | 0.6 | high | Financial rules |
| default | (none of the above) | 0.3 | high | — |

Temperature is **non-destructive**: only set if not already specified by user/agent.

## Verification Command Classification

Only real verification commands count for the completion gate:

```
✅ npm test, npm run lint, npm run typecheck
✅ pytest, ruff check, mypy, pyright
✅ tsc, eslint, prettier
✅ go test, cargo test, make test
✅ python3 audit.py (Python scripts with .py/.csv/.xlsx)
❌ echo, pwd, ls, cat, git status --short
```

Commands are classified from `args.command` (not UI title). Ecosystem-aware: editing a `.py` file requires Python verification, editing `.ts` requires npm/tsc.

## Diff Review Gate

When the model claims "done" after changing **3+ unique files** or touching **risky files** (migration, auth, schema, API, .env, terraform, SQL):

1. Review is **requested** — model gets adversarial review prompt
2. Model must run `git diff` (not `git status`) — **evidence required**
3. Model must provide **verdict** — "No actionable finding" or specific findings
4. Only then completion is allowed

Verdict without evidence → BLOCKED.

## Session Isolation

All state is isolated per `sessionID` using a Map with **6-hour TTL cleanup**:
- Task mode, risk flags, blind-spot/plan/review status
- Evidence ledger (max 100 entries per session)
- Pending warnings, completion blocks, journal searches

No cross-session contamination — verified with parallel session tests.

## Two-Tier Prompt

- **First call**: Full discipline prompt (~2000 tokens) + task-specific prompt + financial rules (if applicable)
- **Subsequent calls**: Short reminder (~50 tokens) — **96% reduction**
- Task mode change triggers re-injection of relevant task prompt

## Installation

```bash
# Copy to your opencode plugins directory
mkdir -p ~/.config/opencode/plugins/fablize-opencode/dist
cp dist/index.js ~/.config/opencode/plugins/fablize-opencode/dist/index.js
cp package.json ~/.config/opencode/plugins/fablize-opencode/package.json
```

Add to `opencode.json`:
```json
{
  "plugin": [
    "/absolute/path/to/fablize-opencode/dist/index.js"
  ]
}
```

### CLI Wrapper (optional)

For `opencode run` (non-interactive) — runs verification after completion:

```bash
# Install
cp bin/fablize-run ~/.config/opencode/bin/fablize-run  # (if available)

# Use instead of opencode run
fablize-run "your prompt"
# → opencode runs
# → npm test / pytest / go test / cargo test (auto-detected)
# → git diff --check
# → exit 0 = pass, exit 1 = fail
```

Custom verification: create `.opencode/fablize-verify.sh` in your project.

### Project Invariants (optional)

Create `.opencode/fablize-invariants.md`:
```markdown
## Financial reporting
- Source data remain immutable.
- Reconciliation difference must be zero or explicitly explained.
- All monetary values carry currency and unit.

## Infrastructure
- No destructive command without confirmation.
- Terraform changes require `terraform plan`.
```

Plugin reads the matching section by task mode and injects before first write.

## A/B Test Results

Controlled comparison (GLM-5.2, same prompt, financial reconciliation with 6 embedded discrepancies):

| Metric | Without plugin | With plugin |
|--------|---------------|-------------|
| Discrepancies found | 6/6 ✅ | 6/6 ✅ |
| Cascade impact traced | ❌ | ✅ (−21.7M gap) |
| EBITDA variants analyzed | 1 | 4 (range 18–39.7M) |
| Self-corrected bugs | 0 | 2 (found + fixed in own code) |
| Code line references | ❌ | ✅ |
| Verification status section | ❌ | ✅ |

## Smoke Test Results

| Scenario | Result |
|----------|--------|
| Normal coding (edit + npm test + done) | ✅ PASS — 14 tests passed, no false block |
| Empty ledger (done without tools) | ✅ PASS — model refused to lie |
| Session isolation (A: npm test, B: echo only) | ✅ PASS — no cross-contamination |
| Risky diff (migration, 3 files, blind spot, review) | ✅ PASS — blind spot + git diff + 2 findings found |

## Audit History

6 rounds of third-party audit (via Perplexity AI), all P0/P1 issues resolved:

- ✅ Session state isolation (Map + TTL)
- ✅ Completion gate (programmatic, evidence-based)
- ✅ Verification classification (^ anchored, ecosystem-aware)
- ✅ Diff review (requires `git diff` with exit 0)
- ✅ Compaction memory (5th hook)
- ✅ Bypass tracking (honest state reporting)
- ✅ Params non-destructive (respects existing temperature/effort/maxOutputTokens)

## Requirements

- [opencode](https://opencode.ai) v1.14+
- Works with any LLM provider (tested with z.ai GLM-5.2)
- `reasoning_effort` parameter respected by provider (verified: minimal=0 tokens, max=495 tokens)

## Credits

- Original fablize framework: [fivetaku/fablize](https://github.com/fivetaku/fablize) (MIT)
- A/B methodology and execution disciplines from the original author's research
- Third-party audit by Perplexity AI (6 rounds)

## License

MIT
