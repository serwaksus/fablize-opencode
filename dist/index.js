import { readFileSync } from "fs";

// ══ CONFIG ══
var JOURNAL_PATH = "/root/.config/opencode/agent-journal.md";
var JOURNAL_MAX_ENTRIES = 5;

// ══ FIX 1: SESSION STATE ISOLATION ══
var sessionState = new Map();
var lastSessionID = null;

function stateOf(sessionID) {
  if (!sessionState.has(sessionID)) {
    sessionState.set(sessionID, {
      currentTaskMode: "default",
      previousTaskMode: null,
      pendingLazyWarning: null,
      pendingJournalSearch: null,
      pendingCompletionBlock: null,
      fullPromptInjected: false,
      journalInjected: false,
    });
  }
  return sessionState.get(sessionID);
}

// ══ TASK MODE DETECTION ══
var AUDIT_KW = ["аудит","сверк","ebitda","дебет","кредит","сальдо","проводк","audit","reconcil"];
var DEBUG_KW = ["баг","ошибк","не работает","сломал","падает","крашит","висит","debug","error","crash","broken","fail","traceback","exception"];
var CREATE_KW = ["создай","сделай файл","напиши файл","сгенерир","создать","построй","create","generate","build","scaffold"];
var CREATIVE_KW = ["напиши текст","придумай","brainstorm","creative","сочини","слоган","стих","рассказ"];
var FIN_VERIFY = ["сверк","проверь","контрольн","сход","бьётс"];
var FIN_ANALYZE = ["почему","причин","объясни","найди","откуда","из-за"];
var FIN_HYPO = ["предложи","вариант","что если","гипотез","допустим"];
var FIN_GEN = ["расчёт","расчет","формул","млн","тыс","excel","xlsx","бюджет","прогноз","budget","forecast","formula","financial","revenue","cost","profit","loss","balance"];

function detectTaskMode(text) {
  var t = (text || "").toLowerCase();
  for (var i = 0; i < CREATIVE_KW.length; i++) if (t.indexOf(CREATIVE_KW[i]) !== -1) return "creative";
  for (var i = 0; i < AUDIT_KW.length; i++) if (t.indexOf(AUDIT_KW[i]) !== -1) return "audit";
  for (var i = 0; i < DEBUG_KW.length; i++) if (t.indexOf(DEBUG_KW[i]) !== -1) return "debug";
  for (var i = 0; i < CREATE_KW.length; i++) if (t.indexOf(CREATE_KW[i]) !== -1) return "create";
  for (var i = 0; i < FIN_VERIFY.length; i++) if (t.indexOf(FIN_VERIFY[i]) !== -1) return "financial_verify";
  for (var i = 0; i < FIN_ANALYZE.length; i++) if (t.indexOf(FIN_ANALYZE[i]) !== -1) return "financial_analyze";
  for (var i = 0; i < FIN_HYPO.length; i++) if (t.indexOf(FIN_HYPO[i]) !== -1) return "financial_hypothesis";
  for (var i = 0; i < FIN_GEN.length; i++) if (t.indexOf(FIN_GEN[i]) !== -1) return "financial_general";
  return "default";
}

// ══ FIX 3: FINANCIAL RULES (R6-R9) — task-specific, not in base prompt ══
var FINANCIAL_RULES = [
  "## Rule 6 — No mental math for financial calculations",
  "Numbers > 100 in arithmetic: ALWAYS run Python. Mental math for money is FORBIDDEN.",
  "",
  "## Rule 7 — Step references",
  "Cite numbers with source: \"as computed in step 3 (ledger #3: sum=787)\".",
  "",
  "## Rule 8 — Always state units",
  "EVERY number MUST have units: '452 000 тыс. руб. (= 452.0 млн руб.)'.",
  "",
  "## Rule 9 — Show conversion formulas",
  "When converting: '452 000 / 1000 = 452.0 млн'. Never bare converted value."
].join("\n");

var FINANCIAL_MODES = ["audit", "financial_verify", "financial_analyze", "financial_hypothesis", "financial_general"];

var TASK_PROMPTS = {
  "audit": "--- TASK MODE: AUDIT ---\nCheck ALL control sums. Convert тыс→млн EXPLICITLY (÷1000).\nTrace discrepancies to source cells. Compare cross-sheet values.\nALL calculations via Python. State units (R8). Show conversions (R9).",
  "debug": "--- TASK MODE: DEBUG ---\nReproduce error FIRST: show command + output.\n3+ competing hypotheses. Causal chain: root cause → mechanism → symptom.\nAfter fix: RE-RUN failing case. No 'fixed' without re-run.",
  "create": "--- TASK MODE: CREATE ---\nAfter creating: READ FILE BACK. Confirm content matches intent.\nShow key parts as evidence. Run applicable tests/checks."
};
function getTaskPrompt(mode) { return TASK_PROMPTS[mode] || null; }
function needsFinancialRules(mode) { return FINANCIAL_MODES.indexOf(mode) !== -1; }

// ══ COMPLETION DETECTION (replaces laziness + self-rating) ══
var DONE_PATTERNS = [
  /\b(done|fixed|implemented|resolved|complete|finished|verified)\b/i,
  /\b(готово|исправлено|реализовано|решено|завершено|проверено)\b/i
];
var LAZY_PATTERNS = [
  /i'?ll do/i,/let me check/i,/i'?ll verify/i,/i'?ll check/i,/i'?ll run/i,
  /this should work/i,/i assume/i,/давайте проверим/i,/сейчас проверю/i,
  /нужно проверить/i,/я проверю/i,/осталось проверить/i
];

function detectLaziness(text) {
  if (!text || typeof text !== "string") return null;
  for (var i = 0; i < LAZY_PATTERNS.length; i++) { var m = text.match(LAZY_PATTERNS[i]); if (m) return m[0]; }
  return null;
}

// ══ FIX 2: PROGRAMMATIC COMPLETION GATE ══
function checkCompletionGate(text, ledger) {
  if (!text || !ledger || ledger.length === 0) return null;
  var isDone = DONE_PATTERNS.some(function(re) { return re.test(text); });
  if (!isDone) return null;
  var lastWriteIdx = -1;
  for (var i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].tool === "write" || ledger[i].tool === "edit") { lastWriteIdx = i; break; }
  }
  if (lastWriteIdx === -1) return null;
  for (var j = lastWriteIdx + 1; j < ledger.length; j++) {
    if (ledger[j].tool === "bash" && ledger[j].exitCode === 0 && !ledger[j].hasError) return null;
  }
  return "COMPLETION BLOCKED: After the last file change (step " + (lastWriteIdx + 1) +
    ": " + ledger[lastWriteIdx].title + "), there is NO successful verification command. " +
    "Run the smallest relevant check (test/lint/typecheck) or state exactly why it cannot be run.";
}

// ══ FIX 4: ENHANCED EVIDENCE EXTRACTION ══
function extractKeyNumbers(output) {
  if (!output || typeof output !== "string") return [];
  var numbers = [];
  var lines = output.split("\n");
  for (var i = 0; i < lines.length && numbers.length < 5; i++) {
    var match = lines[i].match(/([A-Za-zА-Яа-яЁё][\w\s]{0,25}?)\s*[=:]\s*(-?\d{1,12}[.,]?\d{0,4})/);
    if (match) {
      var key = match[1].trim(), val = match[2].replace(",", ".");
      if (key.length > 1 && Math.abs(parseFloat(val)) > 0) numbers.push(key + "=" + val);
    }
  }
  return numbers;
}

function hasError(output) {
  if (!output) return false;
  var s = String(output).toLowerCase();
  return s.indexOf("error") !== -1 || s.indexOf("traceback") !== -1 ||
    s.indexOf("расхождение") !== -1 || s.indexOf("failed") !== -1 ||
    s.indexOf("exit code: 1") !== -1 || s.indexOf("\u2717") !== -1;
}

function extractExitCode(output, metadata) {
  if (metadata && typeof metadata.exit !== "undefined") return metadata.exit;
  if (!output) return null;
  var s = String(output);
  var m = s.match(/exit code:?\s*(\d+)/i) || s.match(/EXIT:(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function extractTestResult(output) {
  if (!output || typeof output !== "string") return null;
  var m = output.match(/(\d+)\s*(passed|tests?\s*passed|test[s]?\s*passing)/i);
  if (m) return m[1] + " passed";
  m = output.match(/(\d+)\s*(failed|failing|errors?)/i);
  if (m) return m[1] + " failed";
  return null;
}

function extractFilePath(args) {
  if (!args) return null;
  return args.filePath || args.path || args.file || null;
}

// ══ ERROR KEYWORD EXTRACTION + JOURNAL SEARCH ══
function extractErrorKeywords(output) {
  if (!output) return null;
  var lower = output.toLowerCase();
  var kws = [];
  var patterns = ["auth","token","permission","denied","connection","timeout","refused",
    "module","import","not found","syntax","invalid","type error","attribute",
    "null","undefined","endpoint","format"];
  for (var i = 0; i < patterns.length && kws.length < 4; i++) {
    if (lower.indexOf(patterns[i]) !== -1) kws.push(patterns[i]);
  }
  return kws.length > 0 ? kws : null;
}

function searchJournal(keywords) {
  if (!keywords || keywords.length === 0) return null;
  try {
    var content = readFileSync(JOURNAL_PATH, "utf-8");
    var blocks = content.split(/(?=\n## \d{4}-\d{2}-\d{2})/);
    var matches = [];
    for (var i = 1; i < blocks.length && matches.length < 2; i++) {
      var lower = blocks[i].toLowerCase();
      for (var k = 0; k < keywords.length; k++) {
        if (lower.indexOf(keywords[k].toLowerCase()) !== -1) {
          matches.push(blocks[i].trim().split("\n").slice(0, 8).join("\n"));
          break;
        }
      }
    }
    return matches.length > 0 ? matches.join("\n\n") : null;
  } catch (e) { return null; }
}

// ══ DISCIPLINE PROMPT (base: R1-5, R10. No R6-R9, no self-rating) ══
var DISCIPLINE_PROMPT = [
  "<fablize-discipline — ENFORCED EXECUTION DISCIPLINE>",
  "Not optional. Violating them produces incorrect work.",
  "",
  "## Rule 1 — Verification grounding",
  "Before \"done\": run code, show output, cite cells. FORBIDDEN: \"should work\", \"I assume\".",
  "",
  "## Rule 2 — Multi-story completion gate",
  "For 2+ steps: decompose, evidence per step, refuse groundless \"done\".",
  "The plugin checks your tool history PROGRAMMATICALLY: if you wrote/edited a file but did",
  "NOT run a verification command (test/lint/typecheck) afterward, 'done' will be BLOCKED.",
  "Self-rating is replaced by this automatic check — you cannot bypass it by claiming high scores.",
  "",
  "## Rule 3 — Systematic investigation",
  "Reproduce → 2+ hypotheses → evidence per hypothesis → causal chain end-to-end.",
  "",
  "## Rule 4 — Early-stop prevention",
  "REFUSE: \"I'll do X\" without doing NOW. \"Should work\" without running. If impossible: \"BLOCKED: reason\".",
  "",
  "## Rule 5 — Journal update",
  "After non-trivial tasks: append to /root/.config/opencode/agent-journal.md.",
  "",
  "## Rule 10 — Persistence before BLOCKED",
  "Try at least 2 different approaches. Document what you tried. BLOCKED only after genuine exhaustion.",
  "",
  "## Evidence ledger",
  "Every tool call tracked with exit codes and test results. Empty ledger + \"done\" = blocked.",
  "",
  "## Escalation",
  "Capability ceiling exists. When hit: NAME it, escalate.",
  "</fablize-discipline>"
].join("\n");

var DISCIPLINE_SHORT = "<fablize-active> Verify before done (R1) | Completion auto-gated: write→must verify (R2) | 2+ hypotheses (R3) | No empty promises (R4) | Journal (R5) | Try 2+ before BLOCKED (R10). Financial rules (R6-R9) in task prompt. Ledger below. </fablize-active>";

// ══ LEDGER ══
var ledgers = new Map();
var MAX_ENTRIES = 100, RECENT_WINDOW = 10;

function recordEvidence(sessionID, entry) {
  if (!ledgers.has(sessionID)) ledgers.set(sessionID, []);
  var entries = ledgers.get(sessionID);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function getLedgerSummary(sessionID) {
  if (!sessionID) return "";
  var entries = ledgers.get(sessionID);
  if (!entries || entries.length === 0)
    return "\n\n--- EVIDENCE LEDGER: empty. 'done' without tool calls = blocked. ---";
  var startIdx = Math.max(0, entries.length - RECENT_WINDOW);
  var recent = entries.slice(startIdx);
  var lines = [];
  for (var i = 0; i < recent.length; i++) {
    var e = recent[i];
    var line = (startIdx + i + 1) + ". [" + e.tool + "] " + e.title;
    if (e.exitCode !== null && e.exitCode !== undefined) line += " → exit " + e.exitCode;
    if (e.testResult) line += ", " + e.testResult;
    else if (e.filePath) line += " → " + e.filePath;
    if (e.keyNumbers && e.keyNumbers.length > 0) line += " | " + e.keyNumbers.join(", ");
    if (e.hasError) line += " [ERROR]";
    lines.push(line);
  }
  return "\n\n--- EVIDENCE LEDGER (" + entries.length + " call" + (entries.length === 1 ? "" : "s") +
    (entries.length > RECENT_WINDOW ? ", last " + RECENT_WINDOW : "") + ") ---\n" +
    lines.join("\n") + "\n--- END LEDGER ---";
}

// ══ JOURNAL ══
function readLastJournalEntries(count) {
  try {
    var content = readFileSync(JOURNAL_PATH, "utf-8");
    var blocks = content.split(/(?=\n## \d{4}-\d{2}-\d{2})/);
    if (blocks.length <= 1) return "";
    var entries = blocks.slice(1).slice(-count);
    var result = "";
    for (var i = 0; i < entries.length; i++)
      result += entries[i].trim().split("\n").slice(0, 15).join("\n") + "\n\n";
    return result;
  } catch (e) { return "(journal not readable yet)\n"; }
}

// ══ PLUGIN (4 hooks) ══
var fablizePlugin = async function (_input) {
  return {

    "experimental.chat.system.transform": async function (input, output) {
      var sessionID = input.sessionID;
      lastSessionID = sessionID;
      var state = stateOf(sessionID);
      var parts = [];

      // Two-tier prompt
      if (!state.fullPromptInjected) {
        state.fullPromptInjected = true;
        parts.push(DISCIPLINE_PROMPT);
        var tp = getTaskPrompt(state.currentTaskMode);
        if (tp) parts.push("\n" + tp);
        if (needsFinancialRules(state.currentTaskMode)) parts.push("\n" + FINANCIAL_RULES);
      } else {
        parts.push(DISCIPLINE_SHORT);
        if (state.currentTaskMode !== state.previousTaskMode) {
          var newTp = getTaskPrompt(state.currentTaskMode);
          if (newTp) parts.push("\n" + newTp);
          if (needsFinancialRules(state.currentTaskMode)) parts.push("\n" + FINANCIAL_RULES);
        }
      }
      state.previousTaskMode = state.currentTaskMode;

      // Completion gate (Fix 2)
      if (state.pendingCompletionBlock) {
        parts.push("\n--- " + state.pendingCompletionBlock + " ---\n");
        state.pendingCompletionBlock = null;
      }

      // Anti-laziness
      if (state.pendingLazyWarning) {
        parts.push("\n--- ANTI-LAZINESS ALERT ---");
        parts.push("Previous response promised: \"" + state.pendingLazyWarning + "\" without executing.");
        parts.push("DO IT NOW or state BLOCKED: <reason>.\n");
        state.pendingLazyWarning = null;
      }

      // Contextual journal search
      if (state.pendingJournalSearch) {
        var jMatches = searchJournal(state.pendingJournalSearch);
        if (jMatches) {
          parts.push("\n--- JOURNAL MATCH (error context) ---\n" + jMatches + "\n");
        }
        state.pendingJournalSearch = null;
      }

      // Journal (first call only)
      if (!state.journalInjected) {
        state.journalInjected = true;
        var entries = readLastJournalEntries(JOURNAL_MAX_ENTRIES);
        if (entries) {
          parts.push("\n<agent-journal — LAST " + JOURNAL_MAX_ENTRIES + " ENTRIES>");
          parts.push("Lessons from previous sessions. Apply when relevant.\n");
          parts.push(entries + "</agent-journal>");
        }
      }

      parts.push(getLedgerSummary(sessionID));
      output.system.push(parts.join("\n"));
    },

    "chat.params": async function (input, output) {
      var sessionID = input.sessionID || lastSessionID;
      if (sessionID) { lastSessionID = sessionID; var s = stateOf(sessionID); }
      var msgText = "";
      if (input.message) {
        msgText = input.message.text || input.message.content || "";
        if (typeof msgText !== "string") msgText = JSON.stringify(msgText) || "";
      }
      var mode = detectTaskMode(msgText);
      if (sessionID) stateOf(sessionID).currentTaskMode = mode;

      var tempMap = {
        "creative":{temp:0.7,effort:"high"},"audit":{temp:0.1,effort:"max"},
        "debug":{temp:0.3,effort:"max"},"create":{temp:0.3,effort:"max"},
        "financial_verify":{temp:0.1,effort:"max"},"financial_analyze":{temp:0.4,effort:"max"},
        "financial_hypothesis":{temp:0.6,effort:"max"},"financial_general":{temp:0.2,effort:"max"},
        "default":{temp:0.3,effort:"max"}
      };
      var settings = tempMap[mode] || tempMap["default"];
      output.temperature = settings.temp;
      output.options = output.options || {};
      output.options.reasoning_effort = settings.effort;
      if (!output.maxOutputTokens || output.maxOutputTokens < 8192) output.maxOutputTokens = 8192;
    },

    "experimental.chat.messages.transform": async function (_input, msgOutput) {
      try {
        if (!msgOutput || !msgOutput.messages || msgOutput.messages.length === 0) return;
        var sessionID = lastSessionID;
        if (!sessionID) return;
        var state = stateOf(sessionID);
        state.pendingLazyWarning = null;
        state.pendingCompletionBlock = null;

        // Find last assistant message
        for (var i = msgOutput.messages.length - 1; i >= 0; i--) {
          var msg = msgOutput.messages[i];
          var isAssistant = msg.info && (msg.info.role === "assistant" || msg.info.roleID === "assistant");
          if (!isAssistant) continue;

          var fullText = "", hasToolCall = false;
          if (msg.parts) {
            for (var j = 0; j < msg.parts.length; j++) {
              var part = msg.parts[j];
              if (part.type === "text" && part.text) fullText += part.text;
              if (part.type === "tool" || part.type === "tool_use" || part.type === "tool_call" || part.tool) hasToolCall = true;
            }
          }

          // FIX 2: Programmatic completion gate
          var ledger = ledgers.get(sessionID) || [];
          var completionBlock = checkCompletionGate(fullText, ledger);
          if (completionBlock) {
            state.pendingCompletionBlock = completionBlock;
          } else if (!hasToolCall) {
            var lazyMatch = detectLaziness(fullText);
            if (lazyMatch) state.pendingLazyWarning = lazyMatch;
          }
          break;
        }
      } catch (e) {}
    },

    "tool.execute.after": async function (input, output) {
      var sessionID = input.sessionID;
      lastSessionID = sessionID;
      var outStr = "";
      var metadata = output && output.metadata ? output.metadata : {};
      if (output && output.output)
        outStr = typeof output.output === "string" ? output.output : JSON.stringify(output.output);

      var errorFlag = hasError(outStr);
      recordEvidence(sessionID, {
        tool: input.tool,
        callID: input.callID,
        title: (output && output.title) ? output.title : "(" + input.tool + ")",
        timestamp: Date.now(),
        keyNumbers: extractKeyNumbers(outStr),
        hasError: errorFlag,
        exitCode: extractExitCode(outStr, metadata),
        testResult: extractTestResult(outStr),
        filePath: extractFilePath(input.args),
      });

      if (errorFlag) {
        var errorKws = extractErrorKeywords(outStr);
        if (errorKws) stateOf(sessionID).pendingJournalSearch = errorKws;
      }
    },

  };
};

export { fablizePlugin as default };
