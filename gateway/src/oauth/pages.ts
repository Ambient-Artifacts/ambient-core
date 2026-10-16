// The few HTML pages the gateway serves while an AI app connects: code entry,
// consent and errors. Plain server-rendered HTML with one inline stylesheet, so
// the strict CSP (no scripts, no external styles/fonts/images) can stay: the app
// icons are embedded as data URIs.
import { readFileSync } from "node:fs";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#fafafa;--card:#fff;--text:#09090b;--muted:#71717a;--border:#e4e4e7;--field:#fff;--soft:#f4f4f5;
--primary:#0a0a0a;--primary-hover:#27272a;--on-primary:#fafafa;--ring:rgba(9,9,11,.14);--danger:#dc2626;--danger-bg:#fef2f2;
--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 32px rgba(0,0,0,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#111113;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--field:#09090b;
--soft:#18181b;--primary:#fafafa;--primary-hover:#e4e4e7;--on-primary:#09090b;--ring:rgba(250,250,250,.16);--danger:#f87171;
--danger-bg:rgba(248,113,113,.1);--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 32px rgba(0,0,0,.5)}}
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;
padding:24px 16px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif;
color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px 28px 28px;box-shadow:var(--shadow)}
.pair{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px}
.app{width:48px;height:48px;border-radius:23.5%;display:grid;place-items:center;font-weight:600;font-size:20px}
.client{background:var(--soft);border:1px solid var(--border);color:var(--text)}
img.app{display:block}
img.client{border:0;box-shadow:0 0 0 1px var(--border)}
.link{display:flex;gap:5px}.link i{width:4px;height:4px;border-radius:50%;background:var(--muted);opacity:.5}
h1{font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-.02em;text-align:center;margin:0 0 6px}
.sub{color:var(--muted);text-align:center;margin:0 0 22px}
.sub b{color:var(--text);font-weight:500}
.steps{list-style:none;padding:0;margin:0 0 22px;display:grid;gap:10px}
.steps li{display:flex;gap:12px;align-items:flex-start}
.steps .n{flex:none;width:22px;height:22px;margin-top:1px;border-radius:50%;display:grid;place-items:center;
font-size:12px;font-weight:600;background:var(--soft);border:1px solid var(--border);color:var(--muted)}
.steps b{font-weight:600}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.code{width:100%;margin:0 0 12px;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--field);
color:var(--text);font:600 28px/1.2 ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;letter-spacing:.3em;text-indent:.3em;
text-align:center;outline:none;transition:border-color .15s,box-shadow .15s}
.code::placeholder{color:var(--muted);opacity:.35}
.code:focus{border-color:var(--muted);box-shadow:0 0 0 3px var(--ring)}
.btn{display:block;width:100%;height:44px;border-radius:10px;border:0;font-size:15px;font-weight:500;font-family:inherit;cursor:pointer;
background:var(--primary);color:var(--on-primary);transition:background .15s,transform .05s}
.btn:hover{background:var(--primary-hover)}.btn:active{transform:scale(.99)}
.btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--ring)}
.btn.secondary{background:var(--card);color:var(--text);border:1px solid var(--border)}
.btn.secondary:hover{background:var(--soft)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px}
.actions form{margin:0}
.alert{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;margin:0 0 14px;border-radius:10px;
background:var(--danger-bg);color:var(--danger);font-size:14px}
.alert svg{flex:none;margin-top:2px}
.perms{list-style:none;padding:0;margin:4px 0 0;border:1px solid var(--border);border-radius:12px;overflow:hidden}
.perms li{display:flex;gap:12px;align-items:center;padding:12px 14px;border-top:1px solid var(--border)}
.perms li:first-child{border-top:0}
.tick{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--primary);color:var(--on-primary)}
.note{display:flex;gap:6px;align-items:center;justify-content:center;margin:18px 0 0;font-size:13px;color:var(--muted);text-align:center}
.foot{margin-top:20px;font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}
`;

/** An image in gateway/assets as a data URI (read once). */
function asset(path: string): string {
  return `data:image/webp;base64,${readFileSync(new URL(`../../assets/${path}`, import.meta.url)).toString("base64")}`;
}

/** Ambient's app icon: the Half Dome mark on black (the iPhone and Mac app's icon). */
const AMBIENT_ICON = asset("ambient-app.webp");

/**
 * Icons of AI apps we know, by the host they return to (checked by the OAuth server, so an
 * app can't borrow another's icon by naming itself after it). Others get their initial.
 * Each is the app's own icon, as served by that app.
 */
const CLIENT_ICONS: { host: RegExp; icon: string }[] = [
  { host: /(^|\.)claude\.(ai|com)$/, icon: asset("clients/claude.webp") },
  { host: /(^|\.)chatgpt\.com$/, icon: asset("clients/chatgpt.webp") },
];

/** The Half Dome mark, for the footer (the same path as the website's). */
const MARK_PATH =
  "M12.95 76.39L16.87 28.09C16.95 27.15 17.67 26.39 18.6 26.26C26.43 25.24 36.62 25.6 45.5 28.5C64.99 34.86 82 55 88.5 88L88.71 89.07C88.84 89.73 89.37 90.24 90.03 90.34L94.31 91.02C95.28 91.17 96 92.01 96 92.99L96 97.04C96 97.63 95.74 98.18 95.3 98.56C94.85 98.94 94.27 99.11 93.69 99.02L5.69 85.08C4.72 84.93 4 84.09 4 83.11L4 79.06C4 78.47 4.26 77.92 4.7 77.54C5.15 77.16 5.73 76.99 6.31 77.08L11.11 77.84C11.55 77.91 12 77.79 12.35 77.52C12.7 77.24 12.92 76.83 12.95 76.39ZM78.21 88.47C78.73 88.55 79.26 88.37 79.62 87.98C79.99 87.6 80.13 87.06 80.02 86.54C79.75 85.31 79.45 84.09 79.14 82.88C77.79 77.63 76.06 72.48 73.86 67.52C71.53 62.27 68.67 57.23 65.17 52.66C62.59 49.3 59.66 46.19 56.36 43.51C53.9 41.51 51.24 39.75 48.4 38.33C46.71 37.48 44.95 36.74 43.15 36.15C39.82 35.05 36.3 34.38 32.81 34.04C32.56 34.01 32.31 33.99 32.07 33.97C31.51 33.92 30.98 34.16 30.64 34.61C30.31 35.05 30.24 35.63 30.44 36.15C34.55 46.55 37.42 61.57 38.28 80.85C38.31 81.61 38.88 82.24 39.63 82.36L78.21 88.47Z";

const ICON = {
  mark: `<svg width="16" height="13" viewBox="4 25.74 92 73.3" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="${MARK_PATH}"/></svg>`,
  lock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  alert: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>`,
};

function layout(title: string, card: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main class="card">${card}</main>
<div class="foot">${ICON.mark}<span>Ambient</span></div></body></html>`;
}

/** "Claude ··· Ambient": the AI app's icon (or its initial) next to Ambient's. */
function pair(clientName: string, redirectHost: string): string {
  const host = redirectHost.replace(/:\d+$/, "").toLowerCase();
  const known = CLIENT_ICONS.find((c) => c.host.test(host));
  const client = known
    ? `<img class="app client" src="${known.icon}" width="48" height="48" alt="">`
    : `<div class="app client">${esc((clientName.trim()[0] ?? "?").toUpperCase())}</div>`;
  return `<div class="pair" aria-hidden="true">${client}
<div class="link"><i></i><i></i><i></i></div><img class="app" src="${AMBIENT_ICON}" width="48" height="48" alt=""></div>`;
}

const alertBox = (text: string) => `<div class="alert" role="alert">${ICON.alert}<span>${esc(text)}</span></div>`;

/**
 * A team invite link (`/join/<code>`), shared from the app: opens Ambient, which asks to join.
 * The code alone is shown too, for typing it in under Settings → Teams.
 */
export function joinPage(code: string): string {
  return layout(
    "Join your team on Ambient",
    `<div class="pair" aria-hidden="true"><img class="app" src="${AMBIENT_ICON}" width="48" height="48" alt=""></div>
<h1>Join your team on Ambient</h1>
<p class="sub">Open the invite in Ambient on your iPhone or Mac. You'll see the team before you join.</p>
<a class="btn" href="ambient://join/${esc(code)}" style="display:grid;place-items:center;text-decoration:none">Open in Ambient</a>
<p class="note"><span>Or type the code under <b>Settings → Teams → Join a team</b>: <b>${esc(code)}</b></span></p>`,
  );
}

/** Where people get an AI-app sign-in code: the Ambient app, the server's admin, or either. */
export type LoginCodes = "app" | "admin" | "both";

export function loginPage(o: { uid: string; clientName: string; redirectHost: string; error?: string; codes?: LoginCodes }): string {
  const admin = o.codes === "admin";
  const steps = admin
    ? `<li><span class="n">1</span><span>Ask whoever runs this Ambient server for a sign-in code.</span></li>
<li><span class="n">2</span><span>They make one with <b>admin connect-code</b> and your email.</span></li>
<li><span class="n">3</span><span>Enter it here within 5 minutes.</span></li>`
    : `<li><span class="n">1</span><span>Open <b>Ambient</b> on your iPhone or Mac.</span></li>
<li><span class="n">2</span><span>Go to <b>Settings → Connect an AI app</b>.</span></li>
<li><span class="n">3</span><span>Then enter the code it shows.</span></li>`;
  return layout(
    `Connect ${o.clientName} to Ambient`,
    `${pair(o.clientName, o.redirectHost)}
<h1>Connect ${esc(o.clientName)} to Ambient</h1>
<p class="sub"><b>${esc(o.redirectHost)}</b> wants to read your Ambient notes.</p>
<ol class="steps">
${steps}
</ol>
${o.error ? alertBox(o.error) : ""}
<form method="post" action="/interaction/${esc(o.uid)}/login">
<label class="sr" for="code">Code</label>
<input class="code" id="code" name="code" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="one-time-code" maxlength="11" placeholder="ABCD 2345" autofocus required>
<button class="btn" type="submit">Continue</button>
</form>
${o.codes === "both" ? `<p class="note"><span>No Ambient app? Ask whoever runs this server for a code.</span></p>\n` : ""}<p class="note">${ICON.lock}<span>You approve what it may do next.${admin ? "" : " Disconnect any time in the app."}</span></p>`,
  );
}

export function consentPage(o: { uid: string; clientName: string; redirectHost: string; permissionsHtml: string[] }): string {
  return layout(
    `Allow ${o.clientName}?`,
    `${pair(o.clientName, o.redirectHost)}
<h1>Allow ${esc(o.clientName)}?</h1>
<p class="sub">It will be able to:</p>
<ul class="perms">${o.permissionsHtml.map((p) => `<li><span class="tick">${ICON.check}</span><span>${p}</span></li>`).join("")}</ul>
<div class="actions">
<form method="post" action="/interaction/${esc(o.uid)}/abort"><button class="btn secondary" type="submit">Cancel</button></form>
<form method="post" action="/interaction/${esc(o.uid)}/confirm"><button class="btn" type="submit">Allow</button></form>
</div>
<p class="note">${ICON.lock}<span>You'll return to <b>${esc(o.redirectHost)}</b>. Disconnect any time in the app.</span></p>`,
  );
}

export function errorPage(o: { title?: string; message: string }): string {
  return layout(
    o.title ?? "Couldn't connect",
    `<h1>${esc(o.title ?? "Couldn't connect")}</h1>
<p class="sub">Start again from the app you were connecting.</p>
${alertBox(o.message)}`,
  );
}
