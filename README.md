# fablize-opencode

An [opencode](https://opencode.ai) plugin that enforces execution discipline — ported from [fivetaku/fablize](https://github.com/fivetaku/fablize) (originally built for Claude Code).

## What it does

Forces the model to **reach its own ceiling** by enforcing four verified execution disciplines through plugin hooks:

1. **Verification grounding** — every "done" claim must be backed by tool output (build result, cell reference, file readback). "Should work" is forbidden.
2. **Multi-story completion gate** — multi-step tasks must be decomposed, with per-step evidence. No global "I did everything" without proof.
3. **Systematic investigation** — debugging requires: reproduce → form 2+ competing hypotheses → trace causal chain end-to-end.
4. **Early-stop prevention** — detects "I'll do X" patterns without execution in the same step. Forces doing over promising.

## How it works

Two opencode plugin hooks:

- `experimental.chat.system.transform` — injects the four disciplines into the system prompt at **every** LLM call (not just when triggered). Also injects last 5 journal entries for cross-session learning.
- `tool.execute.after` — maintains an **evidence ledger**: records every tool call (tool name, call ID, title, timestamp) per session. The ledger is shown in the system prompt, so the model sees its own verification trail. An empty ledger + "done" claim = Rule 1 violation.

## A/B Test Results

Controlled comparison with identical model (GLM-5.2) and identical prompt on a financial reconciliation task with embedded discrepancies:

| Metric | Without plugin | With plugin |
|---|---|---|
| Discrepancies found | 3/3 ✅ | 3/3 ✅ |
| Cascade impact traced | ❌ | ✅ (Σ = -21.7M gap) |
| Control links verified | ⚠️ noticed | ✅ explicitly verified |
| Code line references | ❌ | ✅ `stsc_audit.py:23` |
| "What is NOT verified" section | ⚠️ partial | ✅ explicit |
| Per-step evidence | ❌ | ✅ with ledger |

The plugin makes the model **more thorough**, not smarter. Consistent with the original fablize author's finding: *"It does not raise the model's ceiling; it makes the model reach its own ceiling."*

## Installation

```bash
# Copy to your opencode plugins directory
mkdir -p ~/.config/opencode/plugins/fablize-opencode
cp dist/index.js ~/.config/opencode/plugins/fablize-opencode/dist/index.js
cp package.json ~/.config/opencode/plugins/fablize-opencode/package.json
```

Add to `opencode.json`:
```json
{
  "plugin": [
    "/path/to/fablize-opencode/dist/index.js"
  ]
}
```

## Requirements

- [opencode](https://opencode.ai) v1.14+
- The plugin is model-independent — works with any LLM provider

## Credits

- Original fablize framework: [fivetaku/fablize](https://github.com/fivetaku/fablize) (MIT)
- A/B methodology and four disciplines are from the original author's research (19 runs + 26 sessions, ~1500 tool calls comparing Fable 5 vs Opus 4.8)

## License

MIT
