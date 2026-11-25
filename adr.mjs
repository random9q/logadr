// adr.mjs — maintainer for a project's Architecture Decision Record.
//
// Two files, both managed by this script (edit via the tool, not by hand):
//   ADR-current.md — only the latest decision per scope.
//   ADR-history.md — append-only log of every decision, superseded ones
//                    included.  A scope's newest history entry always
//                    equals its current entry.
//
// A decision is scoped by a dot-hierarchy (letters/digits, optional
// internal dashes), e.g. `project.engine.targets.web.files-used`, and is
// timestamped to the second in a sortable local-time string.  Each entry
// is one markdown block:
//
//     ## <scope> — <YYYYMMDDTHHMMSS>
//     <decision text — multi-line, human-readable>
//
// Entries are delimited by that header line (not by blank lines), so a
// decision body may contain blank lines / paragraphs freely; it just may
// not contain a line that is itself a valid header.
//
// Commands (scope args match on dot boundaries — `proj.eng` ≠ `proj.engine`):
//   record  <scope> <text|@file>   set the current decision (append to history)
//   append  <scope> <text|@file>   add text after the current decision's text
//   prepend <scope> <text|@file>   add text before the current decision's text
//   list    [scope]                current decisions at & under scope, with text
//   tree    [scope]                the scope names only, alphabetical
//   history [scope]                every decision (incl. past) at & under scope
//   move    <from> <to>            rename a scope subtree (from → to)
//   delete  <scope>                remove a leaf scope and its history
//
// Text is a literal string, or `@path` to read the text from a file.

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE    = dirname(fileURLToPath(import.meta.url));
const CURRENT = resolve(HERE, "ADR-current.md");
const HISTORY = resolve(HERE, "ADR-history.md");

const CURRENT_TITLE =
    "# qewtkttn — Architecture Decision Record (current)\n\n" +
    "Only the latest decision per scope.  Managed by `adr.mjs` — edit via the tool.";
const HISTORY_TITLE =
    "# qewtkttn — Architecture Decision Record (history)\n\n" +
    "Append-only log of every decision, superseded ones included.  Managed by `adr.mjs`.";

// A scope: dot-separated segments of alphanumerics with optional internal dashes.
const SCOPE_RE  = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)*$/;
// An entry header line: "## <scope> — <timestamp>" with an optional
// " · <by>" provenance tag.  Scope and by are \S+ (no spaces) so the
// separators stay unambiguous; the by group is optional so entries
// written before provenance existed still parse.
const HEADER_RE = /^## (\S+) — (\d{8}T\d{6})(?: · (\S+))?$/;
// Provenance token — who made the decision (e.g. random9q, user, agent).
const BY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ─── helpers ────────────────────────────────────────────────────────

function fail(msg) { console.error("adr: " + msg); process.exit(1); }
function need(cond, msg) { if (!cond) fail(msg); }

function requireScope(s) {
    need(s, "missing scope");
    need(SCOPE_RE.test(s),
        `invalid scope "${s}" — use dot.separated segments of letters, digits, and dashes`);
}

function requireBy(by) {
    if (by !== undefined) need(BY_RE.test(by), `invalid --by "${by}" — use a token like random9q, user, agent`);
}

/** Local time as a sortable YYYYMMDDTHHMMSS string. */
function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
           `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A scope is "under" the query when equal or a dot-child of it. */
function underScope(scope, query) {
    return !query || scope === query || scope.startsWith(query + ".");
}

function byScope(a, b) { return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0; }

function fmtEntry(e) {
    return `## ${e.scope} — ${e.timestamp}${e.by ? " · " + e.by : ""}\n${e.body}`;
}

/** Resolve a text argument: `@path` reads a file, anything else is literal. */
function resolveText(arg) {
    need(arg !== undefined, "missing decision text");
    if (arg === "-") return readFileSync(0, "utf8");   // stdin
    if (arg.startsWith("@")) {
        const p = resolve(process.cwd(), arg.slice(1));
        need(existsSync(p), `no such file: ${p}`);
        return readFileSync(p, "utf8");
    }
    return arg;
}

/** Trim a body to non-blank bounds and reject header-lookalike lines. */
function normalizeBody(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    need(lines.length, "empty decision text");
    for (const l of lines)
        need(!HEADER_RE.test(l),
            `decision text contains a line that looks like an entry header — reword it:\n  ${l}`);
    return lines.join("\n");
}

// ─── file parse / read / write ──────────────────────────────────────

function parseFile(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const entries = [];
    const pre = [];
    let cur = null, seenHeader = false;
    const finish = (c) => {
        const b = c.body;
        while (b.length && b[0].trim() === "") b.shift();
        while (b.length && b[b.length - 1].trim() === "") b.pop();
        return { scope: c.scope, timestamp: c.timestamp, by: c.by, body: b.join("\n") };
    };
    for (const line of lines) {
        const m = line.match(HEADER_RE);
        if (m) {
            seenHeader = true;
            if (cur) entries.push(finish(cur));
            cur = { scope: m[1], timestamp: m[2], by: m[3] || null, body: [] };
        } else if (cur) {
            cur.body.push(line);
        } else if (!seenHeader) {
            pre.push(line);
        }
    }
    if (cur) entries.push(finish(cur));
    return { preamble: pre.join("\n").trim(), entries };
}

function readEntries(path, title) {
    if (!existsSync(path)) return { preamble: title, entries: [] };
    const { preamble, entries } = parseFile(readFileSync(path, "utf8"));
    return { preamble: preamble || title, entries };
}
const readCurrent = () => readEntries(CURRENT, CURRENT_TITLE);
const readHistory = () => readEntries(HISTORY, HISTORY_TITLE);

function writeEntries(path, preamble, entries) {
    const parts = [];
    if (preamble && preamble.trim()) parts.push(preamble.trim());
    for (const e of entries) parts.push(fmtEntry(e));
    writeFileSync(path, parts.join("\n\n") + "\n");
}
// Current is kept alphabetical so the raw file reads tidily; history
// keeps its natural append (chronological) order.
const writeCurrent = (preamble, entries) =>
    writeEntries(CURRENT, preamble, [...entries].sort(byScope));
const writeHistory = (preamble, entries) => writeEntries(HISTORY, preamble, entries);

/** Append-only history write — the normal path for record/append/prepend. */
function appendHistory(entry) {
    const block = fmtEntry(entry);
    if (!existsSync(HISTORY) || statSync(HISTORY).size === 0)
        writeFileSync(HISTORY, HISTORY_TITLE + "\n\n" + block + "\n");
    else
        appendFileSync(HISTORY, "\n" + block + "\n");
}

/** Core writer shared by record/append/prepend: stamp, log to history,
 *  replace the scope's current entry. */
function commit(scope, body, by) {
    const entry = { scope, timestamp: nowStamp(), by: by || null, body };
    appendHistory(entry);
    const cur = readCurrent();
    cur.entries = cur.entries.filter((e) => e.scope !== scope);
    cur.entries.push(entry);
    writeCurrent(cur.preamble, cur.entries);
    console.log(`recorded ${scope} @ ${entry.timestamp}`);
}

// ─── commands ───────────────────────────────────────────────────────

function cmdRecord(scope, textArg, flags = {}) {
    requireScope(scope);
    requireBy(flags.by);
    commit(scope, normalizeBody(resolveText(textArg)), flags.by);
}

function cmdAppend(scope, textArg, flags = {}) {
    requireScope(scope);
    requireBy(flags.by);
    const add = normalizeBody(resolveText(textArg));
    const existing = readCurrent().entries.find((e) => e.scope === scope);
    commit(scope, existing ? `${existing.body}\n\n${add}` : add, flags.by);
}

function cmdPrepend(scope, textArg, flags = {}) {
    requireScope(scope);
    requireBy(flags.by);
    const add = normalizeBody(resolveText(textArg));
    const existing = readCurrent().entries.find((e) => e.scope === scope);
    commit(scope, existing ? `${add}\n\n${existing.body}` : add, flags.by);
}

function cmdList(scope, flags = {}) {
    if (scope) requireScope(scope);
    const sel = readCurrent().entries
        .filter((e) => underScope(e.scope, scope) && (!flags.by || e.by === flags.by))
        .sort(byScope);
    if (flags.json) return void console.log(JSON.stringify(sel));
    console.log(sel.length ? sel.map(fmtEntry).join("\n\n") : "(no current decisions)");
}

function cmdTree(scope, flags = {}) {
    if (scope) requireScope(scope);
    const matched = readCurrent().entries
        .filter((e) => underScope(e.scope, scope) && (!flags.by || e.by === flags.by))
        .map((e) => e.scope);

    // --depth N collapses each scope to its first N dot-segments and
    // dedupes, so a dense tree can be read one zoom level at a time.
    if (flags.depth > 0) {
        const cut = new Map();   // prefix → was it truncated (has more below)?
        for (const s of matched) {
            const segs = s.split(".");
            const p = segs.slice(0, flags.depth).join(".");
            cut.set(p, (cut.get(p) || false) || segs.length > flags.depth);
        }
        const names = [...cut.keys()].sort();
        if (flags.json) return void console.log(JSON.stringify(names));
        return void console.log(names.length
            ? names.map((n) => n + (cut.get(n) ? " …" : "")).join("\n")
            : "(no current decisions)");
    }

    const names = [...new Set(matched)].sort();
    if (flags.json) return void console.log(JSON.stringify(names));
    console.log(names.length ? names.join("\n") : "(no current decisions)");
}

function cmdHistory(scope, flags = {}) {
    if (scope) requireScope(scope);
    let sel = readHistory().entries
        .map((e, i) => [e, i])
        .filter(([e]) => underScope(e.scope, scope) && (!flags.by || e.by === flags.by))
        .filter(([e]) => !flags.since || e.timestamp >= flags.since);
    // --since / --last are recency views (chronological); otherwise group
    // by scope with the append index (chronological) as the tie-break.
    if (flags.since || flags.last) {
        sel.sort((x, y) => x[1] - y[1]);
        if (flags.last) sel = sel.slice(-flags.last);
    } else {
        sel.sort((x, y) => byScope(x[0], y[0]) || x[1] - y[1]);
    }
    const out = sel.map(([e]) => e);
    if (flags.json) return void console.log(JSON.stringify(out));
    console.log(out.length ? out.map(fmtEntry).join("\n\n") : "(no history)");
}

// Exact single-scope fetch.  Exits non-zero when absent so a caller can
// guard `record` vs `append` without reading the whole file.
function cmdGet(scope, flags = {}) {
    requireScope(scope);
    const e = readCurrent().entries.find((x) => x.scope === scope) || null;
    if (flags.json) console.log(JSON.stringify(e));
    else console.log(e ? fmtEntry(e) : `(no current decision at "${scope}")`);
    if (!e) process.exit(1);
}

// Scope-aware body/scope search.  `query` is a literal substring, or a
// /regex/ if wrapped in slashes; matching is case-insensitive.  Searches
// current by default, all history with --history.
function cmdSearch(query, scope, flags = {}) {
    need(query, "usage: search <text|/regex/> [scope]");
    if (scope) requireScope(scope);
    const rx = query.length > 1 && query.startsWith("/") && query.endsWith("/")
        ? new RegExp(query.slice(1, -1), "i")
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const src = flags.history ? readHistory() : readCurrent();
    const sel = src.entries
        .filter((e) => underScope(e.scope, scope) && (!flags.by || e.by === flags.by))
        .map((e) => ({
            scope: e.scope, timestamp: e.timestamp, body: e.body,
            hits: e.body.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => rx.test(l)),
        }))
        .filter((e) => rx.test(e.scope) || e.hits.length)
        .sort(byScope);

    if (flags.json) return void console.log(JSON.stringify(sel));
    if (!sel.length) return void console.log("(no matches)");
    console.log(sel.map((e) => {
        const lines = e.hits.length
            ? e.hits.map(([n, l]) => `    ${n}: ${l}`).join("\n")
            : "    (scope-name match)";
        return `## ${e.scope} — ${e.timestamp}\n${lines}`;
    }).join("\n\n"));
}

// Integrity check: both files parse, current scopes are valid + unique,
// and every current entry equals the latest history entry for its scope.
function cmdCheck() {
    const problems = [];
    const cur = readCurrent();
    const hist = readHistory();

    const seen = new Set();
    for (const e of cur.entries) {
        if (!SCOPE_RE.test(e.scope)) problems.push(`current: invalid scope "${e.scope}"`);
        if (seen.has(e.scope)) problems.push(`current: duplicate scope "${e.scope}"`);
        seen.add(e.scope);
    }
    const latest = new Map();
    for (const e of hist.entries) latest.set(e.scope, e);   // append order → last wins
    for (const e of cur.entries) {
        const h = latest.get(e.scope);
        if (!h) problems.push(`current "${e.scope}" has no history entry`);
        else if (h.body !== e.body || h.timestamp !== e.timestamp || h.by !== e.by)
            problems.push(`current "${e.scope}" differs from its latest history entry`);
    }

    if (problems.length) {
        console.error(problems.map((p) => "  ✗ " + p).join("\n"));
        console.error(`check: ${problems.length} problem(s)`);
        process.exit(1);
    }
    console.log(`check: ok — ${cur.entries.length} current, ${hist.entries.length} history entries`);
}

// Regenerate ADR-current.md from the append-only history (latest per
// scope).  Self-heal if current ever drifts.
function cmdRebuild() {
    const hist = readHistory();
    const latest = new Map();
    for (const e of hist.entries) latest.set(e.scope, e);
    const cur = readCurrent();
    writeCurrent(cur.preamble || CURRENT_TITLE, [...latest.values()]);
    console.log(`rebuilt ADR-current.md from history — ${latest.size} scope(s)`);
}

function cmdMove(from, to) {
    requireScope(from);
    requireScope(to);
    const remap = (s) =>
        s === from ? to : s.startsWith(from + ".") ? to + s.slice(from.length) : null;

    const cur = readCurrent();
    const moved = cur.entries.filter((e) => remap(e.scope) !== null);
    need(moved.length, `no current decisions at or under "${from}"`);

    const movedSet = new Set(moved.map((e) => e.scope));
    for (const e of moved) {
        const ns = remap(e.scope);
        need(!cur.entries.some((o) => o.scope === ns && !movedSet.has(o.scope)),
            `move would collide with existing scope "${ns}"`);
    }

    for (const e of cur.entries) { const ns = remap(e.scope); if (ns) e.scope = ns; }
    writeCurrent(cur.preamble, cur.entries);

    const hist = readHistory();
    for (const e of hist.entries) { const ns = remap(e.scope); if (ns) e.scope = ns; }
    writeHistory(hist.preamble, hist.entries);

    console.log(`moved ${from} → ${to} (${moved.length} scope${moved.length === 1 ? "" : "s"})`);
}

function cmdDelete(scope) {
    requireScope(scope);
    const cur = readCurrent();
    need(cur.entries.some((e) => e.scope === scope), `no current decision at "${scope}"`);
    need(!cur.entries.some((e) => e.scope.startsWith(scope + ".")),
        `"${scope}" is not a leaf (it has sub-scopes) — delete those first`);

    cur.entries = cur.entries.filter((e) => e.scope !== scope);
    writeCurrent(cur.preamble, cur.entries);

    const hist = readHistory();
    hist.entries = hist.entries.filter((e) => e.scope !== scope);
    writeHistory(hist.preamble, hist.entries);

    console.log(`deleted ${scope} (and its history)`);
}

// Apply a batch of operations from a JSON array (literal, @file, or -):
//   [ { "op": "record", "scope": "a.b", "text": "…", "by": "claude" }, … ]
// op defaults to "record"; append/prepend also honored.  Every op is
// validated before any is written, so a bad batch is rejected whole
// rather than applied halfway.
function cmdApply(src) {
    let ops;
    try { ops = JSON.parse(resolveText(src)); }
    catch (e) { fail("apply: invalid JSON — " + e.message); }
    need(Array.isArray(ops), "apply: expected a JSON array of operations");

    ops.forEach((o, i) => {
        need(o && typeof o === "object" && !Array.isArray(o), `apply[${i}]: not an object`);
        o.op = o.op || "record";
        need(["record", "append", "prepend"].includes(o.op), `apply[${i}]: unknown op "${o.op}"`);
        need(o.scope && SCOPE_RE.test(o.scope), `apply[${i}]: invalid scope "${o.scope}"`);
        need(typeof o.text === "string", `apply[${i}]: missing text`);
        o._body = normalizeBody(o.text);
        if (o.by !== undefined && o.by !== null)
            need(BY_RE.test(o.by), `apply[${i}]: invalid by "${o.by}"`);
    });

    for (const o of ops) {
        let body = o._body;
        if (o.op !== "record") {
            const existing = readCurrent().entries.find((e) => e.scope === o.scope);
            if (existing)
                body = o.op === "append" ? `${existing.body}\n\n${o._body}`
                                         : `${o._body}\n\n${existing.body}`;
        }
        commit(o.scope, body, o.by);
    }
    console.log(`applied ${ops.length} operation(s)`);
}

function usage() {
    console.log(`adr — Architecture Decision Record maintainer

Text source is a literal string, @path to read a file, or - to read stdin.

  node adr.mjs record  <scope> <text>     set the current decision
  node adr.mjs append  <scope> <text>     add text after the current text
  node adr.mjs prepend <scope> <text>     add text before the current text
  node adr.mjs list    [scope]            current decisions (with text)
  node adr.mjs tree    [scope]            scope names only
  node adr.mjs history [scope]            every decision incl. past
  node adr.mjs get     <scope>            one exact decision (exit 1 if absent)
  node adr.mjs search  <text|/rx/> [scope] find matches in bodies + scope names
  node adr.mjs check                      verify file integrity + invariants
  node adr.mjs rebuild-current            regenerate current from history
  node adr.mjs apply   <json|@file|->     batch record/append/prepend, validated whole
  node adr.mjs move    <from> <to>        rename a scope subtree
  node adr.mjs delete  <scope>            remove a leaf scope + its history

Flags: --json (machine output)
       --by <who>  set author on writes / filter on reads (e.g. user, claude)
       --depth <n> (tree: collapse to n levels)
       --history (search past too) · --since <ts> · --last <n> (history recency)`);
}

// ─── dispatch ───────────────────────────────────────────────────────

// Flags may appear anywhere; everything else is a positional argument.
const flags = {};
const pos = [];
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === "--json") flags.json = true;
        else if (t === "--history") flags.history = true;
        else if (t === "--by") flags.by = argv[++i];
        else if (t === "--depth") flags.depth = Number(argv[++i]);
        else if (t === "--since") flags.since = argv[++i];
        else if (t === "--last") flags.last = Number(argv[++i]);
        else pos.push(t);
    }
}
const [cmd, a, b] = pos;
switch (cmd) {
    case "record":  need(a && b !== undefined, "usage: record <scope> <text|@file|->");  cmdRecord(a, b, flags);  break;
    case "append":  need(a && b !== undefined, "usage: append <scope> <text|@file|->");  cmdAppend(a, b, flags);  break;
    case "prepend": need(a && b !== undefined, "usage: prepend <scope> <text|@file|->"); cmdPrepend(a, b, flags); break;
    case "list":    cmdList(a, flags);    break;
    case "tree":    cmdTree(a, flags);    break;
    case "history": cmdHistory(a, flags); break;
    case "get":     need(a, "usage: get <scope>"); cmdGet(a, flags); break;
    case "search":  need(a, "usage: search <text|/rx/> [scope]"); cmdSearch(a, b, flags); break;
    case "check":   cmdCheck(); break;
    case "rebuild-current": cmdRebuild(); break;
    case "apply":   need(a, "usage: apply <json|@file|->"); cmdApply(a); break;
    case "move":    need(a && b, "usage: move <from> <to>"); cmdMove(a, b); break;
    case "delete":  need(a, "usage: delete <scope>");        cmdDelete(a);  break;
    case "help": case "-h": case "--help": usage(); break;
    default:        usage(); process.exit(cmd ? 1 : 0);
}
