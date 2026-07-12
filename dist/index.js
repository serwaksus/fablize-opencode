import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ══ CONFIG ══
var JOURNAL_PATH = "/root/.config/opencode/agent-journal.md";
var JOURNAL_MAX_ENTRIES = 5;

// ══ LEDGER (declared before session state) ══
var ledgers = new Map();
var MAX_ENTRIES = 100, RECENT_WINDOW = 10;

// ══ SESSION STATE (isolated per sessionID, with TTL) ══
var sessionState = new Map();
var SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function cleanupSessions() {
  var now = Date.now();
  for (var id of sessionState.keys()) {
    if (now - sessionState.get(id).lastSeenAt > SESSION_TTL_MS) {
      sessionState.delete(id);
      ledgers.delete(id);
    }
  }
}

function stateOf(sessionID) {
  if (typeof sessionID !== "string" || !sessionID.trim()) return null;
  cleanupSessions();
  if (!sessionState.has(sessionID)) {
    sessionState.set(sessionID, {
      currentTaskMode: "default",
      previousTaskMode: null,
      pendingWarning: null,
      pendingJournalSearch: null,
      pendingCompletionBlock: null,
      fullPromptInjected: false,
      litePromptInjected: false,
      lastSeenAt: Date.now(),
      blindSpotRequested: false,
      blindSpotDone: false,
      blindSpotBypassed: false,
      isRisky: false,
      planRequested: false,
      planProvided: false,
      planBypassed: false,
      invariantsInjected: false,
      reviewRequested: false,
      reviewEvidenceSeen: false,
      reviewDone: false,
      verificationRecoveryRequired: false,
      verificationFailureSummary: null,
      verificationFailureAttempts: 0,
      verificationFailedCommand: null,
      writtenFiles: [],
      hasWritesSinceLastVerify: false,
      fablizeMode: "full",
      fablizeStatusRequested: false,
    });
  }
  var state = sessionState.get(sessionID);
  state.lastSeenAt = Date.now();
  return state;
}

// ══ v1.3: MODE TRANSITION — reset gates/recovery/flags on mode switch ══
function setFablizeMode(state, sessionID, nextMode) {
  if (!state || state.fablizeMode === nextMode) return;
  state.fablizeMode = nextMode;
  state.fullPromptInjected = false;
  state.litePromptInjected = false;
  state.pendingCompletionBlock = null;
  state.pendingWarning = null;
  state.pendingJournalSearch = null;
  state.reviewRequested = false;
  state.reviewEvidenceSeen = false;
  state.reviewDone = false;
  state.verificationRecoveryRequired = false;
  state.verificationFailureSummary = null;
  state.verificationFailureAttempts = 0;
  state.verificationFailedCommand = null;
  state.hasWritesSinceLastVerify = false;
  state.blindSpotRequested = false;
  state.blindSpotDone = false;
  state.blindSpotBypassed = false;
  state.planRequested = false;
  state.planProvided = false;
  state.planBypassed = false;
  state.invariantsInjected = false;
  state.isRisky = false;
  state.writtenFiles = [];
}

// ══ TASK MODE DETECTION ══
var CREATIVE_KW = ["напиши текст","придумай","brainstorm","creative","сочини","слоган","стих","рассказ"];
var AUDIT_KW = ["аудит","сверк","ebitda","дебет","кредит","сальдо","проводк","audit","reconcil"];
var DEBUG_KW = ["баг","не работает","сломал","падает","крашит","висит","debug","crash","broken","traceback","exception"];
var CODING_KW = ["измени","поправь","рефактор","реализуй","update","modify","refactor","implement","change code"];
var CREATE_KW = ["создай","сделай файл","напиши файл","сгенерир","создать","построй","create","generate","scaffold"];
var FIN_VERIFY = ["сверк","проверь","контрольн","сход","бьётс"];
var FIN_ANALYZE = ["почему","причин","объясни","найди","откуда","из-за"];
var FIN_HYPO = ["предложи","вариант","что если","гипотез","допустим"];
var FIN_GEN = ["расчёт","расчет","формул","млн","тыс","excel","xlsx","бюджет","прогноз","budget","forecast","formula","financial","revenue","cost","profit","loss","balance"];

// #1: Risky change keywords — trigger blind-spot gate
var RISKY_KW = ["migration","миграц","schema","схема","auth","аутентиф","permission","разрешен",
  "api","endpoint","deploy","deployment","продакшен","production","database","база данных",
  "sql","trading","торгов","order","ордер","payment","платёж","payment","money","деньг",
  "refactor","рефактор","architecture","архитектур"];

function detectTaskMode(text) {
  var t = (text || "").toLowerCase();
  for (var i = 0; i < CREATIVE_KW.length; i++) if (t.indexOf(CREATIVE_KW[i]) !== -1) return "creative";
  for (var i = 0; i < AUDIT_KW.length; i++) if (t.indexOf(AUDIT_KW[i]) !== -1) return "audit";
  for (var i = 0; i < DEBUG_KW.length; i++) if (t.indexOf(DEBUG_KW[i]) !== -1) return "debug";
  for (var i = 0; i < CODING_KW.length; i++) if (t.indexOf(CODING_KW[i]) !== -1) return "coding";
  for (var i = 0; i < CREATE_KW.length; i++) if (t.indexOf(CREATE_KW[i]) !== -1) return "create";
  for (var i = 0; i < FIN_VERIFY.length; i++) if (t.indexOf(FIN_VERIFY[i]) !== -1) return "financial_verify";
  for (var i = 0; i < FIN_ANALYZE.length; i++) if (t.indexOf(FIN_ANALYZE[i]) !== -1) return "financial_analyze";
  for (var i = 0; i < FIN_HYPO.length; i++) if (t.indexOf(FIN_HYPO[i]) !== -1) return "financial_hypothesis";
  for (var i = 0; i < FIN_GEN.length; i++) if (t.indexOf(FIN_GEN[i]) !== -1) return "financial_general";
  return "default";
}

function detectRisky(text) {
  var t = (text || "").toLowerCase();
  for (var i = 0; i < RISKY_KW.length; i++) if (t.indexOf(RISKY_KW[i]) !== -1) return true;
  return false;
}

// ══ FINANCIAL RULES (R6-R9) ══
var FINANCIAL_RULES = [
  "## Rule 6 — No mental math for financial calculations",
  "Numbers > 100 in arithmetic: ALWAYS run Python. Mental math for money is FORBIDDEN.",
  "## Rule 7 — Step references",
  "Cite numbers with source: \"as computed in step 3 (ledger #3: sum=787)\".",
  "## Rule 8 — Always state units",
  "EVERY number MUST have units: '452 000 тыс. руб. (= 452.0 млн руб.)'.",
  "## Rule 9 — Show conversion formulas",
  "When converting: '452 000 / 1000 = 452.0 млн'. Never bare converted value."
].join("\n");
var FINANCIAL_MODES = ["audit","financial_verify","financial_analyze","financial_hypothesis","financial_general"];

var TASK_PROMPTS = {
  "audit": "--- TASK MODE: AUDIT ---\nCheck ALL control sums. Convert тыс→млн EXPLICITLY (÷1000).\nTrace discrepancies to source cells. Compare cross-sheet values.\nALL calculations via Python. State units (R8). Show conversions (R9).",
  "debug": "--- TASK MODE: DEBUG ---\nReproduce error FIRST: show command + output.\n3+ competing hypotheses. Causal chain: root cause → mechanism → symptom.\nKeep diff scoped; do not refactor unrelated code.\nAfter fix: RE-RUN failing case with real verification command. No 'fixed' without re-run.",
  "coding": "--- TASK MODE: CODING ---\nInspect nearest implementation and its tests before editing.\nKeep diff scoped; do not refactor unrelated code.\nAfter last code edit: run smallest relevant verification (test/lint/typecheck).\nFor bug fixes: show failing scenario, fix, then rerun.\nReport: files changed, verification result, unverified risk.\nDo NOT claim a test passed without showing its output.",
  "create": "--- TASK MODE: CREATE ---\nAfter creating: READ FILE BACK. Confirm content matches intent.\nShow key parts as evidence. Run applicable tests/checks."
};
function getTaskPrompt(mode) { return TASK_PROMPTS[mode] || null; }
function needsFinancialRules(mode) { return FINANCIAL_MODES.indexOf(mode) !== -1; }

// ══ CONDITIONAL PROMPT BLOCKS (#1-#4) ══

// #1: Blind-spot gate
var BLIND_SPOT_PROMPT = [
  "--- BLIND-SPOT PASS (before editing) ---",
  "List only material unknowns that could change the implementation:",
  "- Ambiguous behavior or acceptance criterion",
  "- Existing contract/API/schema constraint",
  "- Backward-compat, migration, security, production, or money risk",
  "- Missing test oracle or unclear source of truth",
  "For each unknown choose: A. Resolve from repo evidence, B. Safe default + proceed, C. Ask user one blocking question.",
  "Do not ask questions answerable by reading the repository.",
  "If no material unknowns: write 'No blocking unknowns found' and proceed."
].join("\n");

// #4 update: Diff review now requires evidence

// #2: Plan as contract
var PLAN_CONTRACT_PROMPT = [
  "--- IMPLEMENTATION CONTRACT (before first write) ---",
  "Before editing files, state briefly:",
  "Goal: <one sentence>",
  "In scope: <files/areas>",
  "Out of scope: <what you will NOT touch>",
  "Acceptance checks: <how to verify success>",
  "Risks/rollback: <what could break, how to undo>",
  "Then proceed. If scope expands during work, state why explicitly."
].join("\n");

// #4: Diff-aware review pass
var DIFF_REVIEW_PROMPT = [
  "--- FINAL DIFF REVIEW ---",
  "Read the current diff as an adversarial reviewer. Report ONLY actionable findings:",
  "- Contract break / backward incompatibility",
  "- Missing failure-path test",
  "- Security or data-loss risk",
  "- Incorrect assumption relative to nearby code",
  "- Scope creep beyond stated goal",
  "For every finding cite file and line. Do NOT modify code in this pass.",
  "If no issues: state 'No actionable finding after diff review.'"
].join("\n");

// ══ v1.1: VERIFICATION RECOVERY PROMPT ══
var RECOVERY_PROMPT = [
  "--- VERIFICATION FAILED — RECOVERY REQUIRED ---",
  "A relevant check failed after your changes.",
  "Do not claim completion.",
  "Read the exact failure output from the evidence ledger.",
  "State at least two plausible causes.",
  "Make the smallest justified correction and rerun the failing check.",
  "If the issue remains after two genuine repair attempts,",
  "report UNRESOLVED with the blocker and evidence."
].join("\n");

// ══ CONDITIONAL DETECTION HELPERS ══
function hasPlanMarkers(text) {
  if (!text) return false;
  return /\b(goal|цель)\b/i.test(text) && /\b(in scope|в рамках|acceptance|критер)/i.test(text);
}

function hasBlindSpotCompletion(text) {
  if (!text) return false;
  return /no blocking unknowns/i.test(text) || /\b(unknown|неизвестн|risk|risk|вопрос)\b/i.test(text);
}

function isDiffReviewCommand(command) {
  return /^git\s+diff(?:\s|$)/i.test((command || "").trim());
}

// ══ COMPLETION DETECTION ══
var DONE_PATTERNS = [
  /\b(done|fixed|implemented|resolved|complete|finished|verified)\b/i,
  /(готово|исправлено|реализовано|решено|завершено|проверено|сделано)/i
];
var UNSUPPORTED_CLAIMS = [/this should work/i, /i assume/i, /это должно работать/i, /я предполагаю/i];

function detectUnsupportedClaim(text) {
  if (!text || typeof text !== "string") return null;
  for (var i = 0; i < UNSUPPORTED_CLAIMS.length; i++) { var m = text.match(UNSUPPORTED_CLAIMS[i]); if (m) return m[0]; }
  return null;
}

// ══ VERIFICATION CLASSIFICATION ══
function extractCommand(args) {
  if (!args) return "";
  return String(args.command || args.cmd || args.script || "").trim();
}

var VERIFICATION_PATTERNS = [
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|check|typecheck|build))\b/,
  /^(?:python(?:3)?\s+-m\s+pytest|pytest)\b/,
  /^(?:ruff|mypy|pyright|flake8|pylint|bandit)\b/,
  /^(?:npx\s+)?(?:tsc|eslint|prettier)\b/,
  /^(?:go\s+(?:test|vet)|cargo\s+(?:test|check|clippy)|gradlew?\s+test|mvn\s+test)\b/,
  /^make\s+(?:test|lint|check|build)\b/
];

function isVerificationCommand(command) {
  var c = (command || "").trim().toLowerCase();
  if (!c) return false;
  for (var i = 0; i < VERIFICATION_PATTERNS.length; i++) if (VERIFICATION_PATTERNS[i].test(c)) return true;
  if (/^python/.test(c) && /\.(py|csv|xlsx)/.test(c)) return true;
  return false;
}

// ══ COMPLETION GATE ══
var WORK_MODES = ["create","debug","coding","audit","financial_verify","financial_analyze","financial_hypothesis","financial_general"];

function checkCompletionGate(text, ledger, taskMode) {
  if (!text) return null;
  if (!DONE_PATTERNS.some(function(re) { return re.test(text); })) return null;
  if ((!ledger || ledger.length === 0) && WORK_MODES.indexOf(taskMode) !== -1)
    return "COMPLETION BLOCKED: Response claims completion, but this session has NO tool evidence.";
  if (!ledger || ledger.length === 0) return null;

  var lastWriteIdx = -1;
  for (var i = ledger.length - 1; i >= 0; i--)
    if (ledger[i].tool === "write" || ledger[i].tool === "edit") { lastWriteIdx = i; break; }
  if (lastWriteIdx === -1) return null;

  var changedExt = ledger[lastWriteIdx].filePath ? ledger[lastWriteIdx].filePath.split(".").pop().toLowerCase() : "";
  for (var j = lastWriteIdx + 1; j < ledger.length; j++) {
    var e = ledger[j];
    if (e.tool === "bash" && e.exitCode === 0 && !e.hasError && e.isVerification && isRelevantVerification(e.command, changedExt))
      return null;
  }
  return "COMPLETION BLOCKED: After last file change, NO relevant verification. Run matching check or explain why.";
}

function isRelevantVerification(command, fileExt) {
  if (!command || !fileExt) return true;
  var c = command.toLowerCase();
  if (["py","csv","xlsx","jsonl"].indexOf(fileExt) !== -1 && /(pytest|ruff|mypy|pyright|python)/.test(c)) return true;
  if (["ts","tsx","js","jsx","mjs"].indexOf(fileExt) !== -1 && /(npm|pnpm|yarn|tsc|eslint|prettier)/.test(c)) return true;
  if (fileExt === "go" && /go\s+(test|vet)/.test(c)) return true;
  if (fileExt === "rs" && /cargo/.test(c)) return true;
  if (/make\s+/.test(c)) return true;
  return false;
}

// ══ EVIDENCE EXTRACTION ══
function extractKeyNumbers(output) {
  if (!output || typeof output !== "string") return [];
  var numbers = [];
  var lines = output.split("\n");
  for (var i = 0; i < lines.length && numbers.length < 5; i++) {
    var match = lines[i].match(/([A-Za-zА-Яа-яЁё][\w\s]{0,25}?)\s*[=:]\s*(-?\d{1,12}[.,]?\d{0,4})/);
    if (match) { var k = match[1].trim(), v = match[2].replace(",", "."); if (k.length > 1 && Math.abs(parseFloat(v)) > 0) numbers.push(k + "=" + v); }
  }
  return numbers;
}

function hasError(output, exitCode) {
  if (exitCode !== null && exitCode !== undefined) return exitCode !== 0;
  if (!output) return false;
  var s = String(output).toLowerCase();
  if (/\b(traceback|exception|fatal error|command not found)\b/.test(s)) return true;
  if (/\b(failed|error)\b/.test(s) && !/\b(0 errors|no errors|0 failed|all tests passed|error handling)\b/.test(s)) return true;
  return s.indexOf("расхождение") !== -1;
}

function extractExitCode(output, metadata) {
  var raw = null;
  if (metadata && typeof metadata.exit !== "undefined") raw = metadata.exit;
  else if (metadata && typeof metadata.exitCode !== "undefined") raw = metadata.exitCode;
  else if (output) {
    var m = String(output).match(/exit code:?\s*(\d+)/i) || String(output).match(/EXIT:(\d+)/);
    if (m) raw = m[1];
  }
  if (raw === null || raw === undefined || raw === "") return null;
  var n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function extractTestResult(output) {
  if (!output || typeof output !== "string") return null;
  var m = output.match(/(\d+)\s*(passed|tests?\s*passed|test[s]?\s*passing)/i);
  if (m) return m[1] + " passed";
  m = output.match(/(\d+)\s*(failed|failing)\b/i);
  return m ? m[1] + " failed" : null;
}

// ══ v1.1: VERIFICATION FAILURE SUMMARY ══
function extractFailureSummary(command, output, exitCode) {
  var lines = (output || "").split("\n");
  var keyLines = [];
  for (var i = 0; i < lines.length && keyLines.length < 5; i++) {
    var l = lines[i].trim();
    if (!l) continue;
    if (/^(FAILED|ERROR|Traceback|AssertionError|E\s|FAILED|FAIL\b)/i.test(l) ||
        /\d+\s*(failed|error|failing)\b/i.test(l)) {
      keyLines.push(l.substring(0, 120));
    }
  }
  return (command || "").substring(0, 80) + " → exit " + (exitCode != null ? exitCode : "?") +
    (keyLines.length > 0 ? " | " + keyLines.join(" / ") : "");
}

function hasTestFailures(output, exitCode) {
  if (exitCode != null && exitCode !== 0) return true;
  if (!output) return false;
  var s = String(output);
  // Look for "N failed" where N > 0
  var m = s.match(/(\d+)\s*(failed|failing)\b/i);
  if (m && parseInt(m[1]) > 0) return true;
  // Look for FAILED test markers
  if (/^FAILED\b/m.test(s)) return true;
  return false;
}

function hasGenuinePass(output, exitCode) {
  if (exitCode === null || exitCode === undefined) return false;
  if (exitCode !== 0) return false;
  if (!output) return true;
  var s = String(output);
  var m = s.match(/(\d+)\s*(failed|failing)\b/i);
  if (m && parseInt(m[1]) > 0) return false;
  if (/^FAILED\b/m.test(s)) return false;
  if (/\b(traceback|exception|fatal error)\b/i.test(s)) return false;
  return true;
}

function extractFilePath(args) { return args ? (args.filePath || args.path || args.file || null) : null; }

// ══ JOURNAL + INVARIANTS ══
function extractErrorKeywords(output) {
  if (!output) return null;
  var lower = output.toLowerCase();
  var kws = [];
  var patterns = ["auth","token","permission","denied","connection","timeout","refused",
    "module","import","not found","syntax","invalid","type error","attribute","endpoint"];
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
      for (var k = 0; k < keywords.length; k++)
        if (lower.indexOf(keywords[k].toLowerCase()) !== -1) { matches.push(blocks[i].trim().split("\n").slice(0, 8).join("\n")); break; }
    }
    return matches.length > 0 ? matches.join("\n\n") : null;
  } catch (e) { return null; }
}

// #3: Project invariants — reads from workspace-aware paths
function readInvariants(taskMode, directory, worktree) {
  var paths = [
    join(worktree || directory || ".", ".opencode", "fablize-invariants.md"),
    join(directory || ".", ".opencode", "fablize-invariants.md"),
    join(homedir(), ".opencode", "fablize-invariants.md"),
  ];
  for (var p = 0; p < paths.length; p++) {
    if (!existsSync(paths[p])) continue;
    try {
      var content = readFileSync(paths[p], "utf-8");
      var sections = content.split(/^## /m);
      var modeKw = {
        "audit": ["financial","finance","audit","аудит","финанс"],
        "financial_verify": ["financial","finance","reconcil","финанс","сверк"],
        "debug": ["debug","error","infra","инфра","ошибк"],
        "coding": ["code","api","coding","код"],
        "create": ["create","deploy","инфра"],
      };
      var kws = modeKw[taskMode] || [];
      for (var s = 1; s < sections.length; s++) {
        var sectionLower = sections[s].toLowerCase();
        for (var ki = 0; ki < kws.length; ki++) {
          if (sectionLower.indexOf(kws[ki]) !== -1) {
            var lines = sections[s].trim().split("\n").slice(0, 8);
            return "--- PROJECT INVARIANTS ---\n" + lines.join("\n");
          }
        }
      }
      return null; // File exists but no matching section
    } catch (e) { return null; }
  }
  return null;
}

// ══ DISCIPLINE PROMPT ══
var DISCIPLINE_PROMPT = [
  "<fablize-discipline — ENFORCED EXECUTION DISCIPLINE>",
  "Not optional. Violating them produces incorrect work.",
  "",
  "## Rule 1 — Verification grounding",
  "Before \"done\": run code, show output, cite cells. FORBIDDEN: \"should work\", \"I assume\".",
  "",
  "## Rule 2 — Completion gate (programmatic)",
  "For 2+ steps: decompose, evidence per step, refuse groundless \"done\".",
  "Plugin checks PROGRAMMATICALLY: write/edit without relevant verification → BLOCKED.",
  "Empty ledger + done in work modes → BLOCKED.",
  "",
  "## Rule 3 — Systematic investigation",
  "Reproduce → 2+ hypotheses → evidence each → causal chain end-to-end.",
  "",
  "## Rule 4 — No unsupported claims",
  "FORBIDDEN: \"this should work\", \"I assume\". If impossible: \"BLOCKED: reason\".",
  "",
  "## Rule 5 — Journal update",
  "After non-trivial tasks: append to /root/.config/opencode/agent-journal.md.",
  "",
  "## Rule 10 — Persistence before BLOCKED",
  "Try 2+ approaches. NEVER retry: production data, credentials, destructive migrations, financial ops.",
  "",
  "## Evidence ledger",
  "Every tool call tracked with exit codes, test results, file paths, verification status.",
  "",
  "## Escalation",
  "Capability ceiling exists. When hit: NAME it, escalate.",
  "</fablize-discipline>"
].join("\n");

var DISCIPLINE_SHORT = "<fablize-active> Verify before done (R1) | Write→relevant verify (R2) | 2+ hypotheses (R3) | No unsupported claims (R4) | Journal (R5) | Try 2+ not for destructive ops (R10). Financial R6-R9 in task prompt. </fablize-active>";

// ══ v1.2: LITE MODE PROMPTS ══
var LITE_PROMPT = [
  "<fablize-lite>",
  "Before reporting done: run a relevant check (test/lint/typecheck).",
  "If a check fails: investigate the failure, fix, and rerun. Do not claim done with failing tests.",
  "Run `git diff --check` before your final response.",
  "</fablize-lite>"
].join("\n");
var LITE_SHORT = "<fablize-lite> Verify before done | Recovery on failed check | git diff --check before done </fablize-lite>";

// ══ LEDGER FUNCTIONS ══
function recordEvidence(sessionID, entry) {
  if (!ledgers.has(sessionID)) ledgers.set(sessionID, []);
  var entries = ledgers.get(sessionID);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function getLedgerSummary(sessionID) {
  if (!sessionID) return "";
  var entries = ledgers.get(sessionID);
  if (!entries || entries.length === 0) return "\n\n--- EVIDENCE LEDGER: empty. 'done' without tool calls = blocked in work modes. ---";
  var startIdx = Math.max(0, entries.length - RECENT_WINDOW);
  var recent = entries.slice(startIdx);
  var lines = [];
  for (var i = 0; i < recent.length; i++) {
    var e = recent[i];
    var line = (startIdx + i + 1) + ". [" + e.tool + "] " + e.title;
    if (e.command) line += " — " + e.command.substring(0, 80);
    if (e.exitCode !== null && e.exitCode !== undefined) line += " → exit " + e.exitCode;
    if (e.testResult) line += ", " + e.testResult;
    if (e.filePath) line += " → " + e.filePath;
    if (e.isVerification) line += " [VERIFY]";
    if (e.keyNumbers && e.keyNumbers.length > 0) line += " | " + e.keyNumbers.join(", ");
    if (e.hasError) line += " [ERROR]";
    lines.push(line);
  }
  return "\n\n--- EVIDENCE LEDGER (" + entries.length + " call" + (entries.length === 1 ? "" : "s") +
    (entries.length > RECENT_WINDOW ? ", last " + RECENT_WINDOW : "") + ") ---\n" + lines.join("\n") + "\n--- END LEDGER ---";
}

function countWritesInLedger(ledger) {
  ledger = ledger || [];
  var count = 0, files = {};
  for (var i = 0; i < ledger.length; i++) {
    if (ledger[i].tool === "write" || ledger[i].tool === "edit") {
      files[ledger[i].filePath || "_"] = true;
      count++;
    }
  }
  return { total: count, unique: Object.keys(files).length, files: Object.keys(files) };
}

function hasRiskyFileChange(ledger) {
  ledger = ledger || [];
  var riskyPatterns = ["migration","schema","auth","permission","api","config",".env","secret","deploy","terraform","sql"];
  for (var i = 0; i < ledger.length; i++) {
    if (ledger[i].filePath) {
      var fp = ledger[i].filePath.toLowerCase();
      for (var j = 0; j < riskyPatterns.length; j++) if (fp.indexOf(riskyPatterns[j]) !== -1) return true;
    }
  }
  return false;
}

// ══ PLUGIN (4 hooks + 4 conditional mechanisms) ══
var fablizePlugin = async function (_input) {
  return {

    "experimental.chat.system.transform": async function (input, output) {
      var sessionID = input.sessionID;
      var state = stateOf(sessionID);
      if (!state) return;

      // ══ v1.2: MODE DISPATCH ══

      // OFF: completely silent
      if (state.fablizeMode === "off") {
        if (state.fablizeStatusRequested) {
          state.fablizeStatusRequested = false;
          output.system.push("[fablize] Mode: OFF — all discipline disabled.");
        }
        return;
      }

      // STATUS: show current mode + features
      if (state.fablizeStatusRequested) {
        state.fablizeStatusRequested = false;
        var features = state.fablizeMode === "full"
          ? "completion gate: ON | recovery: ON | diff review: ON | blind-spot: ON | plan: ON | journal: ON | model settings: adjusted"
          : state.fablizeMode === "lite"
            ? "completion gate: ON | recovery: ON | diff review: OFF | blind-spot: OFF | plan: OFF | journal: OFF | model settings: unchanged"
            : "all features OFF";
        output.system.push("[fablize] Mode: " + state.fablizeMode.toUpperCase() + " — " + features);
        if (state.fablizeMode === "off") return;
      }

      var parts = [];

      // LITE: minimal prompt, no blind-spot/plan/invariants/journal/ledger
      if (state.fablizeMode === "lite") {
        if (!state.litePromptInjected) {
          state.litePromptInjected = true;
          parts.push(LITE_PROMPT);
        } else {
          parts.push(LITE_SHORT);
        }
        // Recovery injection (lite includes recovery)
        if (state.verificationRecoveryRequired) {
          parts.push("\n" + RECOVERY_PROMPT);
          if (state.verificationFailureSummary) {
            parts.push("\nLast failure: " + state.verificationFailureSummary);
          }
        }
        // Completion block (lite includes completion gate)
        if (state.pendingCompletionBlock) {
          parts.push("\n--- " + state.pendingCompletionBlock + " ---\n");
          state.pendingCompletionBlock = null;
        }
        output.system.push(parts.join("\n"));
        return;
      }

      // FULL: original behavior below

      // Two-tier prompt
      if (!state.fullPromptInjected) {
        state.fullPromptInjected = true;
        state.previousTaskMode = state.currentTaskMode;
        parts.push(DISCIPLINE_PROMPT);
        var tp = getTaskPrompt(state.currentTaskMode);
        if (tp) parts.push("\n" + tp);
        if (needsFinancialRules(state.currentTaskMode)) parts.push("\n" + FINANCIAL_RULES);
      } else {
        parts.push(DISCIPLINE_SHORT);
        if (state.currentTaskMode !== state.previousTaskMode) {
          state.previousTaskMode = state.currentTaskMode;
          var newTp = getTaskPrompt(state.currentTaskMode);
          if (newTp) parts.push("\n" + newTp);
          if (needsFinancialRules(state.currentTaskMode)) parts.push("\n" + FINANCIAL_RULES);
        }
      }

      // #1: BLIND-SPOT GATE — only before risky changes, before any writes
      var ledger = ledgers.get(sessionID) || [];
      var hasWrites = ledger.some(function(e) { return e.tool === "write" || e.tool === "edit"; });
      if (state.isRisky && !state.blindSpotRequested && !hasWrites) {
        parts.push("\n" + BLIND_SPOT_PROMPT);
        state.blindSpotRequested = true;
      }

      // #2: PLAN CONTRACT — before first write in complex modes
      if (!state.planRequested && !hasWrites && ["audit","debug","coding","financial_verify","financial_analyze"].indexOf(state.currentTaskMode) !== -1) {
        parts.push("\n" + PLAN_CONTRACT_PROMPT);
        state.planRequested = true;
      }

      // #3: PROJECT INVARIANTS — before first write
      if (!state.invariantsInjected && !hasWrites) {
        var invariants = readInvariants(state.currentTaskMode, _input.directory, _input.worktree);
        if (invariants) parts.push("\n" + invariants);
        state.invariantsInjected = true;
      }

      // Completion gate
      if (state.pendingCompletionBlock) {
        parts.push("\n--- " + state.pendingCompletionBlock + " ---\n");
        state.pendingCompletionBlock = null;
      }

      // Unsupported claims
      if (state.pendingWarning) {
        parts.push("\n--- UNSUPPORTED CLAIM ---");
        parts.push("\"" + state.pendingWarning + "\" without evidence. Provide evidence or retract.\n");
        state.pendingWarning = null;
      }

      // Journal error-context search
      if (state.pendingJournalSearch) {
        var jMatches = searchJournal(state.pendingJournalSearch);
        if (jMatches) parts.push("\n--- JOURNAL MATCH ---\n" + jMatches + "\n");
        state.pendingJournalSearch = null;
      }

      // ══ v1.1: VERIFICATION RECOVERY INJECTION ══
      if (state.verificationRecoveryRequired) {
        parts.push("\n" + RECOVERY_PROMPT);
        if (state.verificationFailureAttempts >= 2) {
          parts.push("\n⚠ You have made " + state.verificationFailureAttempts + " repair attempts. If this check still fails, report UNRESOLVED with the blocker and evidence.");
        }
        if (state.verificationFailureSummary) {
          parts.push("\nLast failure: " + state.verificationFailureSummary);
        }
      }

      parts.push(getLedgerSummary(sessionID));
      output.system.push(parts.join("\n"));
    },

    "chat.params": async function (input, output) {
      var sessionID = input.sessionID;
      var msgText = "";
      if (input.message) {
        msgText = input.message.text || input.message.content || "";
        if (typeof msgText !== "string") msgText = JSON.stringify(msgText) || "";
      }

      // ══ v1.2: /fablize COMMAND DETECTION ══
      var fabCmd = msgText.match(/^\/fablize(?:\s+(\w+))?/i);
      if (fabCmd) {
        var cmd = (fabCmd[1] || "status").toLowerCase();
        if (sessionID) {
          var fst = stateOf(sessionID);
          if (!fst) return;
          if (cmd === "off") { setFablizeMode(fst, sessionID, "off"); fst.fablizeStatusRequested = true; }
          else if (cmd === "lite") { setFablizeMode(fst, sessionID, "lite"); fst.fablizeStatusRequested = true; }
          else if (cmd === "full") { setFablizeMode(fst, sessionID, "full"); fst.fablizeStatusRequested = true; }
          else { fst.fablizeStatusRequested = true; }
        }
        // Do NOT run task mode detection or change model settings for /fablize commands
        return;
      }

      var mode = detectTaskMode(msgText);
      if (sessionID) {
        var st = stateOf(sessionID);
        if (!st) return;
        // v1.3: Don't reset to default on follow-up messages
        if (mode !== "default") st.currentTaskMode = mode;
        // ══ v1.2: Skip model settings in off/lite modes ══
        if (st.fablizeMode === "off" || st.fablizeMode === "lite") {
          st.isRisky = st.isRisky || detectRisky(msgText);
          return;
        }
        st.isRisky = st.isRisky || detectRisky(msgText);
      }

      var tempMap = {
        "creative":{temp:0.7,effort:"high"},"audit":{temp:0.1,effort:"max"},
        "debug":{temp:0.2,effort:"max"},"coding":{temp:0.2,effort:"high"},
        "create":{temp:0.3,effort:"high"},
        "financial_verify":{temp:0.1,effort:"max"},"financial_analyze":{temp:0.4,effort:"max"},
        "financial_hypothesis":{temp:0.6,effort:"high"},"financial_general":{temp:0.2,effort:"max"},
        "default":{temp:0.3,effort:"high"}
      };
      var settings = tempMap[mode] || tempMap["default"];
      if (output.temperature == null) output.temperature = settings.temp;
      output.options = output.options || {};
      if (output.options.reasoning_effort == null) output.options.reasoning_effort = settings.effort;
      if (output.maxOutputTokens == null) output.maxOutputTokens = 4096;
    },

    "experimental.chat.messages.transform": async function (_input, msgOutput) {
      try {
        if (!msgOutput || !msgOutput.messages || msgOutput.messages.length === 0) return;

        var sessionID = null;
        for (var si = msgOutput.messages.length - 1; si >= 0; si--)
          if (msgOutput.messages[si].info && msgOutput.messages[si].info.sessionID) { sessionID = msgOutput.messages[si].info.sessionID; break; }
        if (!sessionID) {
          if (process.env.FABLIZE_DEBUG === "1") console.error("[fablize] completion check skipped: sessionID unavailable");
          return;
        }

        var state = stateOf(sessionID);
        if (!state) return;

        // ══ v1.2: OFF mode — skip entirely ══
        if (state.fablizeMode === "off") return;

        state.pendingWarning = null;
        state.pendingCompletionBlock = null;

        for (var i = msgOutput.messages.length - 1; i >= 0; i--) {
          var msg = msgOutput.messages[i];
          if (!msg.info || (msg.info.role !== "assistant" && msg.info.roleID !== "assistant")) continue;

          var fullText = "", hasToolCall = false;
          if (msg.parts) {
            for (var j = 0; j < msg.parts.length; j++) {
              var part = msg.parts[j];
              if (part.type === "text" && part.text) fullText += part.text;
              if (part.type === "tool" || part.type === "tool_use" || part.type === "tool_call" || part.tool) hasToolCall = true;
            }
          }

          var ledger = ledgers.get(sessionID) || [];

          // ══ v1.2: LITE mode — completion gate + recovery only, skip blind-spot/plan/review ══
          if (state.fablizeMode === "lite") {
            if (DONE_PATTERNS.some(function(re) { return re.test(fullText); })) {
              if (state.verificationRecoveryRequired) {
                state.pendingCompletionBlock = "VERIFICATION RECOVERY REQUIRED: A check failed and must be fixed before completion.";
                break;
              }
              var liteBlock = checkCompletionGate(fullText, ledger, state.currentTaskMode);
              if (liteBlock) state.pendingCompletionBlock = liteBlock;
            }
            break;
          }

          // FULL mode: blind-spot/plan/review tracking below
          if (state.blindSpotRequested && !state.blindSpotDone && hasBlindSpotCompletion(fullText)) {
            state.blindSpotDone = true;
          }

          // Track: plan provided?
          if (state.planRequested && !state.planProvided && hasPlanMarkers(fullText)) {
            state.planProvided = true;
          }

          // #4: DIFF-AWARE REVIEW — verify evidence before accepting review
          if (state.reviewRequested && !state.reviewDone) {
            var hasVerdict = /no actionable finding|diff review|adversarial/i.test(fullText);
            if (hasVerdict && !state.reviewEvidenceSeen) {
              // Verdict without evidence → block
              state.pendingCompletionBlock = "DIFF REVIEW EVIDENCE REQUIRED: You stated a review verdict without inspecting the diff. Run `git diff --check` and `git diff`, then report findings with file/line evidence.";
              break;
            }
            if (state.reviewEvidenceSeen && hasVerdict) {
              state.reviewDone = true;
            }
          }

          if (DONE_PATTERNS.some(function(re) { return re.test(fullText); })) {
            // ══ v1.1: Block completion if verification recovery is required ══
            if (state.verificationRecoveryRequired) {
              state.pendingCompletionBlock = "VERIFICATION RECOVERY REQUIRED: A check failed and must be fixed before completion. Do not claim 'done'. Investigate the failure in the evidence ledger, form 2+ hypotheses, fix, and rerun the failing check.";
              break;
            }
            var writeInfo = countWritesInLedger(ledger);
            var needsReview = (writeInfo.unique >= 3 || hasRiskyFileChange(ledger)) && !state.reviewRequested;
            if (needsReview) {
              state.reviewRequested = true;
              state.pendingCompletionBlock = DIFF_REVIEW_PROMPT + "\n\nFirst run `git diff` or `git diff --check` and inspect the output. Do NOT state the review verdict without tool evidence.";
              break;
            }
            // If review was requested but not done yet → block
            if (state.reviewRequested && !state.reviewDone) {
              state.pendingCompletionBlock = "COMPLETION BLOCKED: Diff review was requested but not completed. Run `git diff` and report findings first.";
              break;
            }
          }

          // Normal completion gate
          var completionBlock = checkCompletionGate(fullText, ledger, state.currentTaskMode);
          if (completionBlock) {
            state.pendingCompletionBlock = completionBlock;
          } else if (!hasToolCall) {
            var claim = detectUnsupportedClaim(fullText);
            if (claim) state.pendingWarning = claim;
          }
          break;
        }
      } catch (e) {}
    },

    "tool.execute.after": async function (input, output) {
      var sessionID = input.sessionID;
      var state = stateOf(sessionID);
      if (!state) return;

      // ══ v1.2: OFF mode — skip entirely ══
      if (state.fablizeMode === "off") return;

      var outStr = "";
      var metadata = output && output.metadata ? output.metadata : {};
      if (output && output.output) outStr = typeof output.output === "string" ? output.output : JSON.stringify(output.output);

      var exitCode = extractExitCode(outStr, metadata);
      var errorFlag = hasError(outStr, exitCode);
      var title = (output && output.title) ? output.title : "(" + input.tool + ")";
      var command = extractCommand(input.args);
      var filePath = extractFilePath(input.args);

      recordEvidence(sessionID, {
        tool: input.tool, callID: input.callID, title: title, command: command,
        timestamp: Date.now(), keyNumbers: extractKeyNumbers(outStr), hasError: errorFlag,
        exitCode: exitCode, testResult: extractTestResult(outStr), filePath: filePath,
        isVerification: input.tool === "bash" ? isVerificationCommand(command) : false,
      });

      // ══ v1.2: LITE mode — evidence + recovery only, skip blind-spot/plan/journal ══
      if (state.fablizeMode === "lite") {
        // Track written files (needed for completion gate)
        if ((input.tool === "write" || input.tool === "edit") && filePath) {
          if (state.writtenFiles.indexOf(filePath) === -1) state.writtenFiles.push(filePath);
          state.hasWritesSinceLastVerify = true;
        }
        // Recovery tracking — v1.3: match command identity
        if (input.tool === "bash" && isVerificationCommand(command)) {
          var normCmd = command.replace(/\s+/g, " ").trim().toLowerCase();
          if (hasTestFailures(outStr, exitCode)) {
            if (state.verificationFailedCommand && state.verificationFailedCommand === normCmd && state.hasWritesSinceLastVerify) {
              state.verificationFailureAttempts++;
            } else {
              state.verificationFailureAttempts = 0;
            }
            state.verificationRecoveryRequired = true;
            state.verificationFailureSummary = extractFailureSummary(command, outStr, exitCode);
            state.verificationFailedCommand = normCmd;
            state.hasWritesSinceLastVerify = false;
          } else if (hasGenuinePass(outStr, exitCode)) {
            if (!state.verificationFailedCommand || state.verificationFailedCommand === normCmd) {
              state.verificationRecoveryRequired = false;
              state.verificationFailureSummary = null;
              state.verificationFailureAttempts = 0;
              state.verificationFailedCommand = null;
            }
          }
        }
        return;
      }

      // FULL mode: blind-spot/plan/journal tracking below
      if ((input.tool === "write" || input.tool === "edit") && filePath) {
        var st = stateOf(sessionID);
        if (!st) return;
        if (st.writtenFiles.indexOf(filePath) === -1) st.writtenFiles.push(filePath);
        st.hasWritesSinceLastVerify = true;
        // If blind-spot was requested but not completed, mark as bypassed (not done)
        if (st.blindSpotRequested && !st.blindSpotDone) st.blindSpotBypassed = true;
        // If plan was requested but not provided, mark as bypassed
        if (st.planRequested && !st.planProvided) st.planBypassed = true;
      }

      // Track diff review evidence (only on success)
      if (input.tool === "bash" && exitCode === 0 && !errorFlag && isDiffReviewCommand(command)) {
        stateOf(sessionID).reviewEvidenceSeen = true;
      }

      if (errorFlag) {
        var errorKws = extractErrorKeywords(outStr);
        if (errorKws) stateOf(sessionID).pendingJournalSearch = errorKws;
      }

      // ══ v1.1: VERIFICATION RECOVERY TRACKING (v1.3: command identity matching) ══
      if (input.tool === "bash" && isVerificationCommand(command)) {
        var vState = stateOf(sessionID);
        if (!vState) return;
        var fullNormCmd = command.replace(/\s+/g, " ").trim().toLowerCase();
        if (hasTestFailures(outStr, exitCode)) {
          if (vState.verificationFailedCommand && vState.verificationFailedCommand === fullNormCmd && vState.hasWritesSinceLastVerify) {
            vState.verificationFailureAttempts++;
          } else {
            vState.verificationFailureAttempts = 0;
          }
          vState.verificationRecoveryRequired = true;
          vState.verificationFailureSummary = extractFailureSummary(command, outStr, exitCode);
          vState.verificationFailedCommand = fullNormCmd;
          vState.hasWritesSinceLastVerify = false;
        } else if (hasGenuinePass(outStr, exitCode)) {
          if (!vState.verificationFailedCommand || vState.verificationFailedCommand === fullNormCmd) {
            vState.verificationRecoveryRequired = false;
            vState.verificationFailureSummary = null;
            vState.verificationFailureAttempts = 0;
            vState.verificationFailedCommand = null;
          }
        }
      }
    },

    // ══ #5: COMPACTION MEMORY — preserve fablize state across context compression ══
    "experimental.session.compacting": async function (input, output) {
      try {
        var sessionID = input.sessionID;
        var state = stateOf(sessionID);
        if (!state) return;

        // ══ v1.2: OFF mode — minimal note ══
        if (state.fablizeMode === "off") {
          output.context.push("FABLIZE: off (no discipline active)");
          return;
        }

        var ledger = ledgers.get(sessionID) || [];
        var writeInfo = countWritesInLedger(ledger);

        // ══ v1.2: LITE mode — recovery + verification only ══
        if (state.fablizeMode === "lite") {
          var liteLines = ["FABLIZE LITE STATE"];
          if (state.writtenFiles && state.writtenFiles.length > 0) {
            liteLines.push("Files changed: " + state.writtenFiles.join(", "));
          }
          var liteLastVerify = null;
          for (var li = ledger.length - 1; li >= 0; li--) {
            if (ledger[li].isVerification) {
              liteLastVerify = ledger[li].command + " → exit " + ledger[li].exitCode +
                (ledger[li].testResult ? ", " + ledger[li].testResult : "");
              break;
            }
          }
          liteLines.push("Last verification: " + (liteLastVerify || "none"));
          liteLines.push("Recovery required: " + (state.verificationRecoveryRequired ? "yes (attempts: " + state.verificationFailureAttempts + ")" : "no"));
          output.context.push(liteLines.join("\n"));
          return;
        }

        // FULL mode: detailed state below

        // Build compact continuation state from session data
        var lines = ["FABLIZE CONTINUATION STATE"];

        // Task mode + risk
        lines.push("Task mode: " + state.currentTaskMode);
        if (state.isRisky) lines.push("Risk: HIGH (migration/auth/money/infra detected)");

        // Implementation contract status
        if (state.planRequested) {
          if (state.planProvided) lines.push("Plan contract: provided");
          else if (state.planBypassed) lines.push("Plan contract: BYPASSED before first write — assumptions not recorded");
          else lines.push("Plan contract: requested but not yet provided");
        }

        // Blind-spot status
        if (state.blindSpotRequested) {
          if (state.blindSpotDone) lines.push("Blind-spot pass: completed");
          else if (state.blindSpotBypassed) lines.push("Blind-spot pass: BYPASSED before first write — unknowns not enumerated");
          else lines.push("Blind-spot pass: requested but not yet completed");
        }

        // Files changed
        if (state.writtenFiles && state.writtenFiles.length > 0) {
          lines.push("Files changed: " + state.writtenFiles.join(", "));
        }

        // Last verification
        var lastVerify = null;
        for (var i = ledger.length - 1; i >= 0; i--) {
          if (ledger[i].isVerification && ledger[i].exitCode === 0) {
            lastVerify = ledger[i].command + " → exit " + ledger[i].exitCode;
            if (ledger[i].testResult) lastVerify += ", " + ledger[i].testResult;
            break;
          }
        }
        lines.push("Last verification: " + (lastVerify || "none"));

        // ══ v1.1: Recovery status ══
        if (state.verificationRecoveryRequired) {
          lines.push("Recovery required: yes (attempts: " + state.verificationFailureAttempts + ")");
          if (state.verificationFailureSummary) {
            lines.push("Last failure: " + state.verificationFailureSummary.substring(0, 100));
          }
        } else {
          lines.push("Recovery required: no");
        }

        // Review status
        if (state.reviewRequested) {
          var reviewStatus = state.reviewDone ? "completed" :
            (state.reviewEvidenceSeen ? "evidence seen, awaiting verdict" : "requested, no evidence yet");
          lines.push("Diff review: " + reviewStatus);
        }

        // Open errors
        var openErrors = [];
        for (var j = ledger.length - 1; j >= 0 && openErrors.length < 3; j--) {
          if (ledger[j].hasError) openErrors.push(ledger[j].title);
        }
        if (openErrors.length > 0) {
          lines.push("Open errors: " + openErrors.join("; "));
        }

        // Pending gates
        if (state.pendingCompletionBlock) lines.push("Pending block: " + state.pendingCompletionBlock.substring(0, 100));

        // Key numbers from recent tool calls
        var recentNumbers = [];
        for (var k = ledger.length - 1; k >= 0 && recentNumbers.length < 5; k--) {
          if (ledger[k].keyNumbers && ledger[k].keyNumbers.length > 0) {
            recentNumbers = recentNumbers.concat(ledger[k].keyNumbers);
          }
        }
        if (recentNumbers.length > 0) {
          lines.push("Key numbers: " + recentNumbers.slice(0, 5).join(", "));
        }

        output.context.push(lines.join("\n"));
      } catch (e) {
        // Never crash compaction — fail silently
      }
    },

  };
};

export { fablizePlugin as default };
