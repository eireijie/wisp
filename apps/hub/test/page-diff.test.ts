import { describe, expect, it } from "vitest";
import { addedLines, asksToSignIn, lineKey, pageLines, readPage } from "../src/page-diff.ts";

const issues = (titles: string[], ago = "3 hours ago") => `<!doctype html><html><head><title>Issues</title><script>window.nonce="${Math.random()}"</script><style>.a{}</style></head>
<body><nav><a href="/">Home</a> <a href="/issues">Issues</a></nav><main><h1>Issues · octo/hello</h1>
<p>Track bugs and feature requests for the hello project. Search all issues, filter by label, or open a new one.</p>
<ul>${titles.map((t, i) => `<li><a href="/issues/${i}">${t}</a><span> opened ${ago} by mona</span></li>`).join("")}</ul>
<footer>&copy; 2026 Example &mdash; terms and privacy</footer></main></body></html>`;

describe("reading a page without a model", () => {
  it("keeps the text a person sees, one line per block, without scripts or times that only say how long ago", () => {
    const lines = pageLines(issues(["Login button broken on Safari", "Add dark mode"]));
    expect(lines).toContain("Issues · octo/hello");
    expect(lines).toContain("Login button broken on Safari opened by mona");
    expect(lines.join("\n")).not.toMatch(/nonce|\.a\{\}|ago/);
    expect(lines).toContain("© 2026 Example — terms and privacy");
  });

  it("finds only lines that were added, not ones whose relative time moved on", () => {
    const before = pageLines(issues(["Login button broken on Safari"])).map(lineKey);
    expect(addedLines(before, pageLines(issues(["Login button broken on Safari"], "5 hours ago")))).toEqual([]);
    expect(addedLines(before, pageLines(issues(["Crash when saving a draft", "Login button broken on Safari"], "a day ago")))).toEqual(["Crash when saving a draft opened by mona"]);
  });

  it("hands sign-in pages, empty app shells and errors to the agent's browser", async () => {
    const reply = (body: string, init?: ResponseInit) => (async () => new Response(body, { headers: { "content-type": "text/html" }, ...init })) as unknown as typeof fetch;
    expect(asksToSignIn(`<form><input name=p type="password"></form>`)).toBe(true);
    expect(await readPage(reply(`<form>Sign in to continue<input type=password></form>`), "https://x.test")).toMatchObject({ ok: false, why: "it asks to sign in" });
    expect(await readPage(reply(`<div id=root></div><script src=app.js></script>`), "https://x.test")).toMatchObject({ ok: false });
    expect(await readPage(reply("nope", { status: 403 }), "https://x.test")).toMatchObject({ ok: false, why: "the site answered 403" });
    expect(await readPage((async () => { throw new Error("redirected"); }) as unknown as typeof fetch, "https://x.test")).toMatchObject({ ok: false, why: "redirected" });
    const ok = await readPage(reply(issues(["Login button broken on Safari", "Add dark mode", "Docs typo in README", "Flaky test on CI runners"])), "https://x.test");
    expect(ok.ok).toBe(true);
  });
});
