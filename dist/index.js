import { readFileSync } from "fs";

// ══ CONFIG ══
var JOURNAL_PATH = "/root/.config/opencode/agent-journal.md";
var JOURNAL_MAX_ENTRIES = 5;

// ══ TASK MODE DETECTION ══
var AUDIT_KW = ["аудит","сверк","ebitda","дебет","кредит","сальдо","проводк","audit","reconcil"];
var DEBUG_KW = ["баг","ошибк","не работает","сломал","падает","крашит","висит","debug","error","crash","broken","fail","traceback","exception","not working"];
var CREATE_KW = ["создай","сделай файл","напиши файл","сгенерир","создать","построй","create","generate","build","scaffold"];
var CREATIVE_KW = ["напиши текст","придумай","brainstorm","creative","сочини","слоган","стих","рассказ"];
var FIN_VERIFY = ["сверк","проверь","контрольн","сход","бьётс"];
var FIN_ANALYZE = ["почему","причин","объясни","найди","откуда","из-за"];
var FIN_HYPO = ["предложи","вариант","что если","гипотез","допустим"];
var FIN_GEN = ["расчёт","расчет","формул","млн","тыс","excel","xlsx","бюджет","прогноз","кассов","budget","forecast","formula","financial","revenue","cost","profit","loss","balance"];

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

var TASK_PROMPTS = {
  "audit": "--- TASK MODE: AUDIT ---\nCheck ALL control sums. Convert тыс→млн EXPLICITLY (÷1000).\nTrace discrepancies to source cells. Compare cross-sheet values.\nALL calculations via Python. State units (R8). Show conversions (R9).",
  "debug": "--- TASK MODE: DEBUG ---\nReproduce error FIRST: show command + output.\n3+ competing hypotheses. Causal chain: root cause → mechanism → symptom.\nAfter fix: RE-RUN failing case. No 'fixed' without re-run.",
  "create": "--- TASK MODE: CREATE ---\nAfter creating: READ FILE BACK. Confirm content matches intent.\nShow key parts as evidence. Run applicable tests/checks."
};
function getTaskPrompt(mode) { return TASK_PROMPTS[mode] || null; }

// ══ LAZINESS DETECTION ══
var LAZY_PATTERNS = [
  /i'?ll do/i,/i will do/i,/let me check/i,/let me verify/i,/i'?ll verify/i,
  /i will verify/i,/let me look/i,/i'?ll look/i,/i'?ll check/i,/i will check/i,
  /i'?ll run/i,/let me run/i,/i'?ll test/i,/this should work/i,/this will likely/i,
  /the rest is similar/i,/i assume/i,/i believe/i,
  /давайте проверим/i,/давайте сверим/i,/сейчас посмотрю/i,/сейчас проверю/i,
  /нужно посмотреть/i,/нужно проверить/i,/я проверю/i,/я сверю/i,
  /это должно работать/i,/я сейчас сделаю/i,/осталось проверить/i,
  /далее проверим/i,/я посмотрю/i,/осталось сверить/i
];
function detectLaziness(text) {
  if (!text || typeof text !== "string") return null;
  for (var i = 0; i < LAZY_PATTERNS.length; i++) { var m = text.match(LAZY_PATTERNS[i]); if (m) return m[0]; }
  return null;
}

// ══ KEY NUMBER EXTRACTION ══
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
  var s = String(output);
  return s.indexOf("Error") !== -1 || s.indexOf("Traceback") !== -1 ||
    s.indexOf("РАСХОЖДЕНИЕ") !== -1 || s.indexOf("FAILED") !== -1 ||
    s.indexOf("exit code: 1") !== -1 || s.indexOf("\u2717") !== -1;
}

// ══ #2: ERROR KEYWORD EXTRACTION + CONTEXTUAL JOURNAL SEARCH ══
function extractErrorKeywords(output) {
  if (!output) return null;
  var lower = output.toLowerCase();
  var kws = [];
  var patterns = ["auth","token","key","permission","denied","connection","timeout","refused",
    "module","import","not found","no such","syntax","unexpected","invalid","type","attribute",
    "null","undefined","ошибк","отказ","недоступ","не найден","endpoint","api","config","format"];
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

// ══ DISCIPLINE PROMPT (Rules 1-10, evidence-cited self-assessment) ══
var DISCIPLINE_PROMPT = [
  "<fablize-discipline — ENFORCED EXECUTION DISCIPLINE>",
  "These rules are INJECTED by the fablize-opencode plugin. Not optional.",
  "",
  "## Rule 1 — Verification grounding",
  "Before \"done\": run code, show output, cite cells. FORBIDDEN: \"should work\", \"I assume\".",
  "",
  "## Rule 2 — Completion gate + evidence-cited self-assessment",
  "For 2+ steps: decompose, evidence per step, refuse groundless \"done\".",
  "Before \"done\", self-rate WITH EVIDENCE (cannot cite → rating = 0):",
  "  R1: [cite which tool output verifies] ___/10",
  "  R6: [cite which Python command you ran] ___/10",
  "  R7: [show a step reference from your output] ___/10",
  "  R8: [show a number with units from your output] ___/10",
  "If ANY rating < 8: fix before done. State ratings explicitly.",
  "",
  "## Rule 3 — Systematic investigation",
  "Reproduce → 2+ hypotheses → confirming/refuting evidence → causal chain end-to-end.",
  "\"Probably X\" without chain = NOT a diagnosis.",
  "",
  "## Rule 4 — Early-stop prevention",
  "REFUSE: \"I'll do X\" without doing NOW. \"Should work\" without running. \"Done!\" without evidence.",
  "If impossible: say \"BLOCKED: reason\". Never paper over.",
  "",
  "## Rule 5 — Journal update",
  "After non-trivial tasks: append to /root/.config/opencode/agent-journal.md.",
  "",
  "## Rule 6 — No mental math",
  "Numbers > 100 in arithmetic: ALWAYS run Python. Mental math for money is FORBIDDEN.",
  "",
  "## Rule 7 — Step references",
  "Cite numbers with source: \"as computed in step 3 (ledger #3: sum=787)\".",
  "",
  "## Rule 8 — Always state units",
  "EVERY number MUST have units: '452 000 тыс. руб. (= 452.0 млн руб.)'.",
  "",
  "## Rule 9 — Show conversion formulas",
  "When converting: '452 000 / 1000 = 452.0 млн'. Never bare converted value.",
  "",
  "## Rule 10 — Persistence before BLOCKED (NEW)",
  "Before writing BLOCKED: try at least 2 different approaches.",
  "Document what you tried and why each failed. BLOCKED only after genuine exhaustion.",
  "",
  "## Evidence ledger",
  "Every tool call tracked below. Empty ledger + \"done\" = Rule 1 violation.",
  "",
  "## Escalation",
  "Capability ceiling exists. When hit: NAME it, escalate. Do not pretend.",
  "</fablize-discipline>"
].join("\n");

var DISCIPLINE_SHORT = "<fablize-active> Verify+evidence before done (R1) | Self-rate R1/R6/R7/R8 with citations (R2) | No mental math >100 (R6) | 2+ hypotheses (R3) | No empty promises (R4) | Try 2+ approaches before BLOCKED (R10) | Journal (R5) | Step refs (R7) | Units always (R8) | Show conversions (R9). Ledger below. </fablize-active>";

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
    return "\n\n--- EVIDENCE LEDGER: empty. Claiming 'done' = Rule 1 violation. ---";
  var startIdx = Math.max(0, entries.length - RECENT_WINDOW);
  var recent = entries.slice(startIdx);
  var lines = [];
  for (var i = 0; i < recent.length; i++) {
    var e = recent[i];
    var line = (startIdx + i + 1) + ". [" + e.tool + "] " + e.title;
    if (e.keyNumbers && e.keyNumbers.length > 0) line += " | " + e.keyNumbers.join(", ");
    if (e.hasError) line += " [ERROR]";
    lines.push(line);
  }
  return "\n\n--- EVIDENCE LEDGER (" + entries.length + " call" + (entries.length === 1 ? "" : "s") +
    (entries.length > RECENT_WINDOW ? ", last " + RECENT_WINDOW : "") + ") ---\n" +
    lines.join("\n") + "\n--- END LEDGER ---";
}

// ══ JOURNAL + STATE ══
var journalInjected = new Set();
var fullPromptInjected = new Set();
var pendingLazyWarning = null;
var currentTaskMode = "default";
var previousTaskMode = "default";
var pendingJournalSearch = null;

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
      var parts = [];

      // Two-tier prompt
      if (!fullPromptInjected.has(sessionID)) {
        fullPromptInjected.add(sessionID);
        parts.push(DISCIPLINE_PROMPT);
        // Task prompt on first call
        var tp = getTaskPrompt(currentTaskMode);
        if (tp) parts.push("\n" + tp);
      } else {
        parts.push(DISCIPLINE_SHORT);
        // #1: Dynamic task mode — inject if mode CHANGED since last call
        if (currentTaskMode !== previousTaskMode) {
          var newTp = getTaskPrompt(currentTaskMode);
          if (newTp) parts.push("\n" + newTp);
        }
      }
      previousTaskMode = currentTaskMode;

      // Anti-laziness
      if (pendingLazyWarning) {
        parts.push("\n--- ANTI-LAZINESS ALERT ---");
        parts.push("Previous response promised: \"" + pendingLazyWarning + "\" without executing.");
        parts.push("DO IT NOW or state BLOCKED: <reason>.\n");
        pendingLazyWarning = null;
      }

      // #2: Contextual journal search on errors
      if (pendingJournalSearch) {
        var jMatches = searchJournal(pendingJournalSearch);
        if (jMatches) {
          parts.push("\n--- JOURNAL MATCH (error context) ---");
          parts.push("Relevant past lessons for current error:\n" + jMatches + "\n");
        }
        pendingJournalSearch = null;
      }

      // Journal (first call only)
      if (!journalInjected.has(sessionID)) {
        journalInjected.add(sessionID);
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
      var msgText = "";
      if (input.message) {
        msgText = input.message.text || input.message.content || "";
        if (typeof msgText !== "string") msgText = JSON.stringify(msgText) || "";
      }
      currentTaskMode = detectTaskMode(msgText);

      var tempMap = {
        "creative":{temp:0.7,effort:"high"},"audit":{temp:0.1,effort:"max"},
        "debug":{temp:0.3,effort:"max"},"create":{temp:0.3,effort:"max"},
        "financial_verify":{temp:0.1,effort:"max"},"financial_analyze":{temp:0.4,effort:"max"},
        "financial_hypothesis":{temp:0.6,effort:"max"},"financial_general":{temp:0.2,effort:"max"},
        "default":{temp:0.3,effort:"max"}
      };
      var s = tempMap[currentTaskMode] || tempMap["default"];
      output.temperature = s.temp;
      output.options = output.options || {};
      output.options.reasoning_effort = s.effort;
      if (!output.maxOutputTokens || output.maxOutputTokens < 8192) output.maxOutputTokens = 8192;
    },

    "experimental.chat.messages.transform": async function (_input, output) {
      try {
        if (!output || !output.messages || output.messages.length === 0) return;
        pendingLazyWarning = null;
        for (var i = output.messages.length - 1; i >= 0; i--) {
          var msg = output.messages[i];
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
          if (!hasToolCall) { var lm = detectLaziness(fullText); if (lm) pendingLazyWarning = lm; }
          break;
        }
      } catch (e) {}
    },

    "tool.execute.after": async function (input, output) {
      var outStr = "";
      if (output && output.output)
        outStr = typeof output.output === "string" ? output.output : JSON.stringify(output.output);
      var errorFlag = hasError(outStr);
      recordEvidence(input.sessionID, {
        tool: input.tool, callID: input.callID,
        title: (output && output.title) ? output.title : "(" + input.tool + ")",
        timestamp: Date.now(),
        keyNumbers: extractKeyNumbers(outStr),
        hasError: errorFlag,
      });
      // #2: Trigger contextual journal search on error
      if (errorFlag) {
        var errorKws = extractErrorKeywords(outStr);
        if (errorKws) pendingJournalSearch = errorKws;
      }
    },

  };
};

export { fablizePlugin as default };
