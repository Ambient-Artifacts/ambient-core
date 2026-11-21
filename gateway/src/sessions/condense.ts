// A Claude Code transcript (JSONL) cut down to what a summary needs: what the person asked,
// what the agent answered, and one line per thing it did (edited a file, ran a command). Tool
// output, file contents and the model's thinking are dropped (they're most of the text, and
// where secrets and customer data sit); what's left is scrubbed of anything secret-shaped.
// Nothing here is stored: the gateway seals the result for the worker and drops the upload.

export interface SessionLine {
  /** ISO time, when the transcript has one. */
  at: string | null;
  role: "user" | "assistant" | "tool";
  text: string;
  /** A prompt a person typed (newer Claude Code marks them). */
  human?: boolean;
  /** The file a tool line wrote or edited. */
  file?: string;
}

export interface ParsedSession {
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  branch: string | null;
  entrypoint: string | null;
  /** Prompts a person typed (newer Claude Code marks them; older transcripts don't). */
  humanPrompts: number;
  /** A person worked in it, as opposed to a scheduled job or a script running `claude -p`. */
  interactive: boolean;
  lines: SessionLine[];
  /** Files the agent wrote or edited. */
  edited: string[];
  prs: string[];
  commits: { sha: string; message: string }[];
  /** When each pull request and commit showed up, to give them to the right block. */
  marks: { at: string | null; pr?: string; commit?: { sha: string; message: string } }[];
}

/** What claudeCodeReader keeps of one transcript (see there). */
export const KEEP_CHARS = 8_000_000;
const LINE_COST = 64;
const LINE_TEXT_MAX = 120_000;
const MARKS_MAX = 2_000;

const INTERACTIVE_ENTRYPOINTS = new Set(["cli", "claude-desktop", "claude-vscode", "claude-jetbrains", "remote", "web"]);
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const COMMIT_LINE = /^\[([^\]\n]+?) ([0-9a-f]{7,40})\] ([^\n]{1,200})$/gm;
const SKIPPED_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "ToolSearch", "TodoWrite", "TodoRead", "BashOutput", "KillShell", "TaskOutput", "TaskStop"]);

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown };
type Line = {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string } | null;
  prUrl?: string;
  message?: { role?: string; content?: string | Block[] };
};

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toolLine(name: string, input: Record<string, unknown>): { text: string; edited?: string } | null {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = str("file_path") || str("notebook_path");
      return path ? { text: `${name === "Write" ? "wrote" : "edited"} ${path}`, edited: path } : null;
    }
    case "Bash":
      return { text: `ran: ${oneLine(str("description") || str("command").split("\n")[0] || "", 160)}` };
    case "WebSearch":
      return { text: `searched the web: ${oneLine(str("query"), 120)}` };
    case "WebFetch":
      return { text: `read ${oneLine(str("url"), 160)}` };
    case "Agent":
    case "Task":
      return { text: `delegated: ${oneLine(str("description"), 120)}` };
    default:
      if (SKIPPED_TOOLS.has(name)) return null;
      return { text: `used ${name.replace(/^mcp__/, "").replace(/__/g, " ")}` };
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

/** Text a person wrote, as opposed to text the app injected (reminders, command output, notifications). */
function isInjected(text: string): boolean {
  return /^\s*<(system-reminder|command-|local-command|task-notification|user-prompt-submit-hook|bash-)/.test(text);
}

/**
 * Reads a Claude Code transcript a line at a time, keeping only what the note needs: an upload is
 * streamed through it, so tool output and images (most of a transcript's size) are never all in
 * memory at once.
 */
export function claudeCodeReader(): { line: (raw: string) => void; done: () => ParsedSession } {
  const out: ParsedSession = {
    sessionId: null,
    startedAt: null,
    endedAt: null,
    cwd: null,
    branch: null,
    entrypoint: null,
    humanPrompts: 0,
    interactive: false,
    lines: [],
    edited: [],
    prs: [],
    commits: [],
    marks: [],
  };
  let sawOrigin = false;
  let plainPrompts = 0;
  const edited = new Set<string>();
  const prs = new Set<string>();
  const commits = new Map<string, string>();

  // What one transcript may keep, however long it is (an upload streams through here): the newest
  // lines up to KEEP_CHARS (each costing its text plus LINE_COST, so a million tiny lines count
  // too), each line cut at LINE_TEXT_MAX (a block's note reads 120,000 characters at most), and the
  // newest MARKS_MAX pull requests and commits (a note names 10 and 20). The oldest go first.
  let kept = 0;
  let head = 0;
  const keep = (l: SessionLine): void => {
    const text = l.text.length > LINE_TEXT_MAX ? l.text.slice(0, LINE_TEXT_MAX) : l.text;
    out.lines.push({ ...l, text });
    kept += text.length + LINE_COST;
    while (kept > KEEP_CHARS && head < out.lines.length - 1) kept -= out.lines[head++]!.text.length + LINE_COST;
    if (head > 10_000 && head * 2 > out.lines.length) {
      out.lines.splice(0, head);
      head = 0;
    }
  };
  const mark = (m: ParsedSession["marks"][number]): void => {
    out.marks.push(m);
    if (out.marks.length > MARKS_MAX * 2) out.marks.splice(0, out.marks.length - MARKS_MAX);
  };
  /** Keeps a dedupe set or map at its newest `max` entries. */
  const trim = (c: Set<string> | Map<string, string>, max: number): void => {
    if (c.size <= max * 2) return;
    for (const k of [...c.keys()].slice(0, c.size - max)) c.delete(k);
  };

  const line = (raw: string): void => {
    if (!raw.trim()) return;
    let o: Line;
    try {
      o = JSON.parse(raw) as Line;
    } catch {
      return;
    }
    out.sessionId ??= o.sessionId ?? null;
    if (o.timestamp) {
      out.startedAt ??= o.timestamp;
      out.endedAt = o.timestamp;
    }
    if (o.cwd) out.cwd ??= o.cwd;
    if (o.gitBranch && o.gitBranch !== "HEAD") out.branch = o.gitBranch;
    if (o.entrypoint) out.entrypoint ??= o.entrypoint;
    if ("origin" in o) sawOrigin = true;
    if (o.type === "pr-link" && o.prUrl && !prs.has(o.prUrl)) {
      prs.add(o.prUrl);
      trim(prs, MARKS_MAX);
      mark({ at: o.timestamp ?? null, pr: o.prUrl });
    }
    // Subagents' own turns, and the summary that replaces history after compaction (the
    // history itself is still earlier in the file).
    if (o.isSidechain || o.isCompactSummary || !o.message) return;
    const at = o.timestamp ?? null;
    const content = o.message.content;

    if (o.type === "user") {
      const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
      const human = o.origin?.kind === "human";
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const text = resultText(b.content);
          for (const m of text.matchAll(COMMIT_LINE)) {
            if (commits.has(m[2]!)) continue;
            commits.set(m[2]!, m[3]!.trim());
            trim(commits, MARKS_MAX);
            mark({ at, commit: { sha: m[2]!.slice(0, 12), message: m[3]!.trim() } });
          }
          for (const m of text.matchAll(PR_URL)) {
            if (prs.has(m[0])) continue;
            prs.add(m[0]);
            trim(prs, MARKS_MAX);
            mark({ at, pr: m[0] });
          }
        } else if (b.type === "text" && b.text && !o.isMeta && !isInjected(b.text)) {
          if (o.origin && !human) continue; // a notification or a hook, not a person
          keep({ at, role: "user", text: b.text.trim(), ...(human ? { human: true } : {}) });
          if (human) out.humanPrompts++;
          else plainPrompts++;
        }
      }
    } else if (o.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text?.trim()) {
          keep({ at, role: "assistant", text: b.text.trim() });
          for (const m of b.text.matchAll(PR_URL)) {
            if (prs.has(m[0])) continue;
            prs.add(m[0]);
            trim(prs, MARKS_MAX);
            mark({ at, pr: m[0] });
          }
        } else if (b.type === "tool_use" && b.name) {
          const line = toolLine(b.name, b.input ?? {});
          if (!line) continue;
          if (line.edited) {
            edited.add(line.edited);
            trim(edited, 5_000);
          }
          const last = out.lines.at(-1);
          if (last?.role === "tool" && last.text === line.text) continue;
          keep({ at, role: "tool", text: line.text, ...(line.edited ? { file: line.edited } : {}) });
        }
      }
    }
  };

  const done = (): ParsedSession => {
    if (head) out.lines.splice(0, head);
    if (out.marks.length > MARKS_MAX) out.marks.splice(0, out.marks.length - MARKS_MAX);
    out.interactive = out.humanPrompts > 0 || (!sawOrigin && plainPrompts > 0 && INTERACTIVE_ENTRYPOINTS.has(out.entrypoint ?? ""));
    out.edited = [...edited];
    out.prs = [...prs];
    out.commits = [...commits].map(([sha, message]) => ({ sha: sha.slice(0, 12), message }));
    return out;
  };
  return { line, done };
}

export function parseClaudeCode(jsonl: string): ParsedSession {
  const reader = claudeCodeReader();
  for (const raw of jsonl.split("\n")) reader.line(raw);
  return reader.done();
}

/**
 * A long session as working blocks: a new block starts when the person comes back after
 * `gapMs` (an hour by default). A Remote Control session can run for days and cover several
 * projects; one note per block keeps each note about one stretch of work, and each block goes
 * to a team (or not) by its own edits. Blocks only ever grow at the end, so a block's start
 * time names it across uploads.
 */
export function splitBlocks(s: ParsedSession, gapMs = 60 * 60_000): ParsedSession[] {
  const groups: SessionLine[][] = [];
  let current: SessionLine[] = [];
  let lastAt: number | null = null;
  for (const l of s.lines) {
    const t = l.at ? Date.parse(l.at) : Number.NaN;
    const comesBack = l.role === "user" && lastAt !== null && !Number.isNaN(t) && t - lastAt >= gapMs;
    if (comesBack && current.some((x) => x.role === "user")) {
      groups.push(current);
      current = [];
    }
    current.push(l);
    if (!Number.isNaN(t)) lastAt = t;
  }
  if (current.length) groups.push(current);

  const firstAt = (ls: SessionLine[]) => ls.find((l) => l.at)?.at ?? null;
  const originAware = s.humanPrompts > 0;
  return groups.map((lines, i) => {
    const start = firstAt(lines);
    const next = i + 1 < groups.length ? firstAt(groups[i + 1]!) : null;
    const from = i === 0 || !start ? Number.NEGATIVE_INFINITY : Date.parse(start);
    const to = next ? Date.parse(next) : Number.POSITIVE_INFINITY;
    const marks = s.marks.filter((m) => {
      const t = m.at ? Date.parse(m.at) : Number.POSITIVE_INFINITY;
      return t >= from && t < to;
    });
    const humanPrompts = lines.filter((l) => l.human).length;
    const prompts = lines.filter((l) => l.role === "user").length;
    return {
      ...s,
      startedAt: start,
      endedAt: [...lines].reverse().find((l) => l.at)?.at ?? start,
      humanPrompts,
      interactive: s.interactive && (originAware ? humanPrompts > 0 : prompts > 0),
      lines,
      edited: [...new Set(lines.flatMap((l) => (l.file ? [l.file] : [])))],
      prs: marks.flatMap((m) => (m.pr ? [m.pr] : [])),
      commits: marks.flatMap((m) => (m.commit ? [m.commit] : [])),
      marks,
    };
  });
}

/** `/Users/lena/git/x` → `~/git/x`, so rules and notes read the same on every machine. */
export function homeRelative(path: string, home: string | null): string {
  if (!home || home === "/") return path;
  const h = home.replace(/\/+$/, "");
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** A git remote as `host/org/repo`, without credentials, protocol or `.git`. */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const parsed = new URL(u);
      u = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return null;
    }
  }
  u = u.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9.-]+\/[^\s]+$/.test(u) ? u : null;
}

/**
 * Secrets in free text, replaced: known token formats, keys, credentials in URLs, headers and
 * connection strings, and values next to a name that says secret, token, password or key. Errs on
 * the side of removing too much, but it can't know every format: a bare random string with nothing
 * around it stays (tool output and file contents, where most secrets are, never get here).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key removed]")
    .replace(
      /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|A[KS]IA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,}|(?:ambient|brain)_pat_[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|phc_[A-Za-z0-9]{20,}|[sp]k-lf-[A-Za-z0-9-]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[a-f0-9]{40,}|shpat_[a-fA-F0-9]{32,})/g,
      "[secret]",
    )
    .replace(/https:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|[a-z0-9-]+\.webhook\.office\.com)\/[^\s"'<>)]+/g, "[webhook URL]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token]")
    .replace(/(https?:\/\/)[^\s:@/]+:[^\s@/]+@/g, "$1[credentials]@")
    .replace(/(https?:\/\/)[^\s@/]{20,}@/g, "$1[credentials]@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[credentials]@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[token]")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]{12,}/g, "$1[credentials]")
    .replace(/\b((?:x-)?(?:api-key|auth-token|access-token|apikey)\s*:\s*)["']?[^\s"']{12,}["']?/gi, "$1[secret]")
    .replace(/\b((?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)\s*=\s*)[^;\s"']{6,}/g, "$1[secret]")
    .replace(/(--(?:password|passwd|token|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))["']?[^\s"']{6,}["']?/gi, "$1[secret]")
    .replace(/\b((?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n]*?\s-p)[^\s"']{4,}/g, "$1[secret]")
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|DSN)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"']{8,}\3/g, "$1$2[secret]")
    .replace(/(["']?(?:api[_-]?key|secret|token|password|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["'])[^"'\s]{8,}(["'])/gi, "$1[secret]$2")
    // Unquoted, any case, spaces around the sign: aws_secret_access_key = wJalr…
    .replace(/\b([a-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[a-z0-9_.-]*\s*[:=]\s*)(?!\[secret\])[A-Za-z0-9+/_.~-]{16,}={0,2}/gi, "$1[secret]");
}

function clock(at: string | null): string {
  return at && /T\d{2}:\d{2}/.test(at) ? at.slice(11, 16) : "--:--";
}

/**
 * The transcript as text for the summarizer: `[09:12] User: …`, `[09:13] Claude: …`, and
 * `→ edited …` lines, capped at `maxChars` (the start and most of the end survive).
 */
export function condense(s: ParsedSession, opts: { home: string | null; maxChars?: number }): string {
  const maxChars = opts.maxChars ?? 120_000;
  const rows = s.lines.map((l) => {
    const text = l.role === "tool" ? l.text : l.text.length > (l.role === "user" ? 4000 : 1500) ? `${l.text.slice(0, l.role === "user" ? 4000 : 1500)} […]` : l.text;
    const home = opts.home?.replace(/\/+$/, "");
    const body = home && home !== "" ? text.split(`${home}/`).join("~/") : text;
    return l.role === "tool" ? `        → ${body}` : `[${clock(l.at)}] ${l.role === "user" ? "User" : "Agent"}: ${body}`;
  });
  let text = rows.join("\n");
  if (text.length > maxChars) {
    // Keep the opening (what the session set out to do) and most of the end (where it landed).
    const head: string[] = [];
    const tail: string[] = [];
    let headLen = 0;
    let tailLen = 0;
    for (const r of rows) {
      if (headLen + r.length > maxChars * 0.25) break;
      head.push(r);
      headLen += r.length + 1;
    }
    for (let i = rows.length - 1; i >= head.length; i--) {
      if (tailLen + rows[i]!.length > maxChars * 0.75) break;
      tail.unshift(rows[i]!);
      tailLen += rows[i]!.length + 1;
    }
    text = [...head, `[… ${rows.length - head.length - tail.length} lines from the middle of the session left out …]`, ...tail].join("\n");
  }
  return redactSecrets(text);
}

// ---- which team a session belongs to ----

export interface SessionRule {
  /** A folder (`~/git/brain-*`, `/srv/acme/**`) or a repo (`github.com/acme/*`). */
  match: string;
  /** Team slug. */
  team: string;
}

export interface SessionPlace {
  /** Paths below are home-relative (`~/…`) when the home folder is known. */
  cwd: string | null;
  repo: string | null;
  files: string[];
  /** The machine's home folder, so `/root/git/x` rules match `~/git/x` paths and back. */
  home?: string | null;
}

function isFolderPattern(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~");
}

/**
 * A rule's glob as a matcher: `**` is anything, `*` anything but "/", the rest is literal (any
 * case), and the path may go on below what matched ("/…"). Not a regex: a rule like
 * `/**a**a**a**a**b` made the regex engine backtrack for minutes on one short path, on the
 * gateway's only thread. This walks the pattern once over the path (time path × pattern).
 */
function globMatcher(pattern: string, budget: MatchBudget): { test: (path: string) => boolean } {
  const tokens: (string | "*" | "**")[] = [];
  for (const part of pattern.trim().replace(/\/+$/, "").split(/(\*\*|\*)/)) {
    if (part === "**" || part === "*") tokens.push(part);
    else tokens.push(...part.toLowerCase().split(""));
  }
  return {
    test(raw: string): boolean {
      const path = raw.toLowerCase();
      const n = path.length;
      // Rules and paths are the user's own (50 rules, 500 files a block, 50 blocks an upload): the
      // work for one upload has a ceiling, past which nothing more matches.
      const cost = tokens.length * (n + 1);
      if (cost > budget.left) return false;
      budget.left -= cost;
      // at[i]: the tokens so far can match path[0, i).
      let at = new Array<boolean>(n + 1).fill(false);
      at[0] = true;
      for (const t of tokens) {
        const next = new Array<boolean>(n + 1).fill(false);
        if (t === "**" || t === "*") {
          for (let i = 0; i <= n; i++) next[i] = at[i]! || (i > 0 && next[i - 1]! && (t === "**" || path[i - 1] !== "/"));
        } else {
          for (let i = 0; i < n; i++) if (at[i] && path[i] === t) next[i + 1] = true;
        }
        at = next;
      }
      return at[n]! || at.some((ok, i) => ok && path[i] === "/");
    },
  };
}

/** How much matching (pattern × path characters) one upload or one lookup may do. */
export interface MatchBudget {
  left: number;
}
export const matchBudget = (): MatchBudget => ({ left: 20_000_000 });

/** Does a rule cover this session: its folder (or most of its edits), or its repo? */
export function ruleMatches(rule: SessionRule, place: SessionPlace, budget: MatchBudget = matchBudget()): boolean {
  const pattern = rule.match.trim();
  if (!pattern) return false;
  if (isFolderPattern(pattern)) {
    // Compare absolute paths when the home folder is known: rules and paths may each be `~/…` or absolute.
    const home = place.home?.replace(/\/+$/, "");
    const expand = (p: string) => (home && (p === "~" || p.startsWith("~/")) ? `${home}${p.slice(1)}` : p);
    const re = globMatcher(expand(pattern), budget);
    if (place.cwd && re.test(expand(place.cwd))) return true;
    const hits = place.files.filter((f) => re.test(expand(f))).length;
    return place.files.length > 0 && hits * 2 >= place.files.length;
  }
  const repo = normalizeRemote(`https://${pattern.replace(/^[a-z]+:\/\//i, "")}`) ?? pattern.toLowerCase();
  return place.repo !== null && globMatcher(repo, budget).test(place.repo);
}

/** The first rule that covers the session and names a team the user is in. */
export function pickTeam<T extends { slug: string }>(rules: SessionRule[], place: SessionPlace, teams: T[], budget: MatchBudget = matchBudget()): T | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, place, budget)) continue;
    const team = teams.find((t) => t.slug === rule.team);
    if (team) return team;
  }
  return null;
}
