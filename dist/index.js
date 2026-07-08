import { readFileSync, statSync } from "fs";

const JOURNAL_PATH = "/root/.config/opencode/agent-journal.md";
const JOURNAL_MAX_ENTRIES = 5;
const journalInjected = new Set();
const journalMtimeAtStart = new Map();

function readLastJournalEntries(count) {
  try {
    const content = readFileSync(JOURNAL_PATH, "utf-8");
    const blocks = content.split(/(?=\n## \d{4}-\d{2}-\d{2})/);
    if (blocks.length <= 1) return "";
    const entries = blocks.slice(1).slice(-count);
    let result = "";
    for (const entry of entries) {
      const lines = entry.trim().split("\n");
      const truncated = lines.slice(0, 15).join("\n");
      result += truncated + "\n\n";
    }
    return result;
  } catch (e) {
    return "(journal not readable yet — will be created after first task)\n";
  }
}

function getJournalMtime() {
  try {
    return statSync(JOURNAL_PATH).mtimeMs;
  } catch (e) {
    return 0;
  }
}

const DISCIPLINE_PROMPT = `<fablize-discipline — ENFORCED EXECUTION DISCIPLINE>
These rules are INJECTED by the fablize-opencode plugin. They are not optional. Violating them produces incorrect work. The model that ignores them ships promises instead of results.

## Rule 1 — Verification grounding: run it, don't describe it

Before writing "done", "complete", "verified", "checked", or any success claim about an artifact:

- **Code/build** → run the build or test. Show the command output (exit code, error count).
- **Numeric claim** → recompute from source cells. Show the formula and the cell addresses.
- **Generated file** → read it back. Confirm it contains what was intended.
- **Rendered output** (HTML/SVG/chart/table) → display it or describe what it renders as.

FORBIDDEN phrases: "the build should work", "this will produce X", "the sum is correct because I added the column", "I assume this is right".

REQUIRED pattern: "Build ran: \`tsc --noEmit\` returned 0 errors" or "Recomputed: cell P4 = 370, cell P5 = 417, sum P4:P5 = 787 = cell P6 (matches)."

If the artifact cannot be run in this environment, say so explicitly: state what WAS verified vs. what remains unverified.

## Rule 2 — Multi-story completion gate: decompose, then refuse groundless "done"

For any task with 2+ logical steps:

1. **Decompose first.** Before acting, list the steps explicitly.
2. **Checkpoint per step.** Each step gets its own evidence — not a global "I did everything".
3. **Refuse completion without proof.** Do not write "all done" if any step lacks its own evidence line.

Completion template (use this format in your completion message):

  Step 1 — <action>: <evidence (command output / cell ref / file readback)>
  Step 2 — <action>: <evidence>
  ...
  Overall: <state only what the evidence collectively supports>

If a step failed or is partial, SAY WHICH ONE. Do not paper over a failed step by emphasizing a successful one.

## Rule 3 — Systematic investigation: reproduce, hypothesize, trace

For debugging / discrepancy / unexpected-result tasks:

1. **Reproduce first.** State the exact observation (command, input, output, cell address, file line).
2. **Form hypotheses.** List 2+ plausible causes. Do not anchor on the first one.
3. **Compete them.** For each hypothesis, state what evidence would confirm or refute it.
4. **Trace the causal chain end-to-end.** A hypothesis is only accepted when the full chain (root cause → mechanism → observed symptom) is specified. "It's probably X" without the chain is NOT a diagnosis.

## Rule 4 — Early-stop prevention: do not promise, execute

Detect these patterns in your own draft output and REFUSE to ship them:

- "I'll do X" / "let me check" / "I'll verify" — without doing it in the SAME response.
- "This should work" / "this will likely" — without having run it.
- "Done!" — without evidence per step.
- "The rest is similar" — without confirming at least one more case.

When you catch yourself drafting one of these: STOP, DO the action, THEN write the result. If the action is genuinely impossible in this step (missing tool, missing file, requires user input), say "BLOCKED: <reason>" and what is needed to unblock — never paper over it with a promise.

## Rule 5 — Journal update (self-learning)

After completing any non-trivial task (2+ steps with deviations, decisions, errors, or discoveries), append an entry to \`/root/.config/opencode/agent-journal.md\` using the format specified in AGENTS.md. Use categories [РЕШЕНИЕ], [ОТКЛОНЕНИЕ], [ОШИБКА], [ОТКРЫТИЕ], or [ПАТТЕРН].

When NOT to journal: trivial tasks (1 step, no surprises), typo fixes, routine operations.

Before claiming "done" on a 2+ step task, self-check: "Did this task involve deviations from plan, key decisions, mistakes corrected, or surprising discoveries? If yes — was a journal entry written?" If not written → write it before claiming done.

## Evidence ledger

This plugin maintains an evidence ledger of every tool call in the current session. The current state is appended below. When claiming "done", the model must reference this trail. An empty ledger + a "done" claim = Rule 1 violation.

## Escalation (when you hit the model's ceiling)

Some things CANNOT be transferred by procedure. They are: out-of-spec defect discovery, open-ended creative detail, self-driven propagation depth. When you hit one: NAME the ceiling, recommend a stronger model or flag for human review with a specific question. Do not pretend.
</fablize-discipline>`;

const ledgers = new Map();
const MAX_ENTRIES = 100;
const RECENT_WINDOW = 10;

function recordEvidence(sessionID, entry) {
  if (!ledgers.has(sessionID)) ledgers.set(sessionID, []);
  const entries = ledgers.get(sessionID);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function getLedgerSummary(sessionID) {
  if (!sessionID) return "";
  const entries = ledgers.get(sessionID);
  if (!entries || entries.length === 0) {
    return "\n\n--- EVIDENCE LEDGER: empty (no tool calls yet in this session). Claiming 'done' now = Rule 1 violation. ---";
  }
  const startIdx = Math.max(0, entries.length - RECENT_WINDOW);
  const recent = entries.slice(startIdx);
  const lines = recent.map(function (e, i) {
    return (startIdx + i + 1) + ". [" + e.tool + "] " + e.title;
  });
  var header = "\n\n--- EVIDENCE LEDGER (" + entries.length + " tool call" +
    (entries.length === 1 ? "" : "s") + " total";
  if (entries.length > RECENT_WINDOW) {
    header += ", showing last " + RECENT_WINDOW;
  }
  header += ") ---\n";
  return header + lines.join("\n") + "\n--- END LEDGER ---";
}

var fablizePlugin = async function (_input) {
  return {
    "experimental.chat.system.transform": async function (input, output) {
      var sessionID = input.sessionID;
      var promptParts = [];

      promptParts.push(DISCIPLINE_PROMPT);

      if (!journalInjected.has(sessionID)) {
        journalInjected.add(sessionID);
        const mtime = getJournalMtime();
        journalMtimeAtStart.set(sessionID, mtime);

        const entries = readLastJournalEntries(JOURNAL_MAX_ENTRIES);
        if (entries) {
          promptParts.push("\n<agent-journal — LAST " + JOURNAL_MAX_ENTRIES + " ENTRIES (auto-injected at session start)>\n" +
            "These are lessons from previous sessions. Apply them when relevant to the current task.\n\n" +
            entries +
            "</agent-journal>");
        }
      }

      promptParts.push(getLedgerSummary(sessionID));

      output.system.push(promptParts.join(""));
    },

    "tool.execute.after": async function (input, output) {
      recordEvidence(input.sessionID, {
        tool: input.tool,
        callID: input.callID,
        title: (output && output.title) ? output.title : "(" + input.tool + " call)",
        timestamp: Date.now(),
      });
    },
  };
};

export { fablizePlugin as default };
