/**
 * Runs in the VM's Node: puts a login from the password manager into the page open in the
 * visible Chrome, over its debugging port. The login arrives on stdin (never in arguments, which
 * other processes can see). Prints a LoginFillResult as JSON.
 *
 * The fill runs in an isolated world of its own: the page's scripts (and anything an agent ran in
 * the page beforehand) can't swap out the DOM functions it calls. Its first step, in the same
 * synchronous run as the filling, checks the page is on the login's exact site over https, so a
 * redirect in between or a look-alike page gets nothing. If the password is still in its box a
 * few seconds after pressing sign in, sign in didn't go through and the box is emptied again.
 */
export const FILL_LOGIN_SCRIPT = String.raw`
const read = () => new Promise((resolve) => { let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => resolve(s)); });
const login = JSON.parse(await read());
login.site = login.site.toLowerCase().replace(/^www\./, "");
const cdp = process.env.CDP || "http://127.0.0.1:9222";
const CLEAR_AFTER_MS = Number(process.env.CLEAR_AFTER_MS || 3000);
const session = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const waiting = new Map();
  let n = 0;
  setTimeout(() => resolve(null), 5000);
  ws.onmessage = (m) => { const r = JSON.parse(m.data); const w = waiting.get(r.id); if (w) { waiting.delete(r.id); w(r); } };
  ws.onerror = () => resolve(null);
  ws.onopen = () => resolve({
    send: (method, params = {}) => new Promise((res) => {
      const id = ++n;
      waiting.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (waiting.delete(id)) res({ error: { message: "timed out" } }); }, 5000);
    }),
    close: () => { try { ws.close(); } catch {} },
  });
});
const value = (r) => (r && !r.error && !r.result?.exceptionDetails ? r.result?.result?.value ?? null : null);
// shared by both runs in the isolated world: set a box's value the way typing would
const setValue = (e, v) => {
  e.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, v);
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
};
const SET = "const set = " + setValue + ";";
const inPage = (d) => {
  const host = location.hostname.toLowerCase().replace(/^www\./, "");
  const local = host === "localhost" || host === "127.0.0.1";
  if (host !== d.site || (location.protocol !== "https:" && !local)) return { filled: [], submitted: false, wrongSite: host || location.href };
  const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.disabled && !e.readOnly; };
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const words = (e) => (e.name + " " + e.id + " " + (e.getAttribute("placeholder") || "") + " " + (e.getAttribute("aria-label") || "")).toLowerCase();
  const pw = inputs.find((e) => e.type === "password" && e.autocomplete !== "new-password");
  const otp = inputs.find((e) => e.autocomplete === "one-time-code" || /\botp\b|one.?time|2fa|totp|verification code|security code/.test(words(e)));
  const textish = (e) => ["text", "email", "tel", ""].includes(e.type) && e !== otp;
  const user =
    inputs.find((e) => /username|email/.test(e.autocomplete) && textish(e)) ||
    (pw ? inputs.slice(0, inputs.indexOf(pw)).reverse().find(textish) : inputs.find((e) => textish(e) && (e.type === "email" || /user|email|login|account/.test(words(e)))));
  const filled = [];
  if (pw && d.password) {
    if (user && d.username) { set(user, d.username); filled.push("username"); }
    set(pw, d.password);
    filled.push("password");
  } else if (otp && d.otp) {
    set(otp, d.otp);
    filled.push("otp");
  } else if (user && d.username) {
    set(user, d.username);
    filled.push("username");
  }
  if (!filled.length) return { filled, submitted: false, problem: pw ? "the password box is there but the login has no password" : otp ? "it wants a one-time code and the login has none saved" : "there are no sign-in boxes on the page" };
  const last = filled.includes("password") ? pw : filled.includes("otp") ? otp : user;
  const named = (b) => /sign.?in|log.?in|continue|next|submit|verify/i.test(b.innerText || b.value || b.getAttribute("aria-label") || "");
  const form = last.form;
  const buttons = [...(form || document).querySelectorAll("button, input[type=submit]")].filter((b) => shown(b) && (b.type !== "button" || named(b)));
  const button = buttons.find((b) => b.type === "submit" && (!form || form.contains(b))) || buttons.find(named);
  let submitted = false;
  try {
    if (form && form.requestSubmit) { form.requestSubmit(button && button.form === form && button.type === "submit" ? button : undefined); submitted = true; }
    else if (button) { button.click(); submitted = true; }
  } catch {}
  if (filled.includes("password")) {
    // nothing pressed sign in: don't leave the password sitting in the page
    if (!submitted) { set(pw, ""); return { filled, submitted, cleared: true, problem: "there's no sign-in button to press" }; }
    // this world's globals aren't the page's, so only the check below can find it
    window.__wispPassword = pw;
  }
  return { filled, submitted };
};
const stillThere = () => { const e = window.__wispPassword; delete window.__wispPassword; if (!e || !e.isConnected || !e.value) return false; set(e, ""); return true; };

const pages = (await fetch(cdp + "/json/list").then((r) => r.json(), () => [])).filter((p) => p.type === "page" && p.webSocketDebuggerUrl);
let front = null;
for (const p of pages) {
  const s = await session(p.webSocketDebuggerUrl);
  const visible = s && value(await s.send("Runtime.evaluate", { expression: "document.visibilityState === 'visible'", returnByValue: true }));
  s?.close();
  if (visible) { front = p; break; }
  if (s && !front) front = p;
}
let result = { filled: [], submitted: false, problem: "the browser has no page open" };
if (front) {
  result = { filled: [], submitted: false, problem: "the page didn't answer" };
  const s = await session(front.webSocketDebuggerUrl);
  const frameId = s && (await s.send("Page.getFrameTree")).result?.frameTree?.frame?.id;
  const contextId = frameId && (await s.send("Page.createIsolatedWorld", { frameId, worldName: "wisp-login" })).result?.executionContextId;
  const run = (fn, arg) => s.send("Runtime.evaluate", { contextId, returnByValue: true, expression: "(() => { " + SET + " return (" + fn + ")(" + (arg === undefined ? "" : JSON.stringify(arg)) + "); })()" });
  if (contextId) {
    result = value(await run(inPage, login)) ?? result;
    if (result.submitted && result.filled.includes("password")) {
      await new Promise((r) => setTimeout(r, CLEAR_AFTER_MS));
      // a page that moved on took this world with it; the call then fails, and nothing needs clearing
      if (value(await run(stillThere))) result.cleared = true;
    }
  }
  s?.close();
}
console.log(JSON.stringify(result));
`;
