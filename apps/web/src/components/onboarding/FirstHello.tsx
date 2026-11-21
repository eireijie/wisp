import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent, Message } from "@wisp/core";
import { loadAnswers } from "../../onboardingV3.ts";
import { motionReduced, useMotionReduced } from "../../theme.ts";
import { useStore } from "../../store.ts";
import { Ghost } from "../Ghost.tsx";
import { OB_EASE, hostWasAt } from "./HostGhost.tsx";

/**
 * A new agent's first chat, alive: the host lands in the name pill, the hello types in once, and
 * what it already knows about you is underlined, with where it learned it on hover.
 */

type Fact = { group: string; text: string; src?: string };

const STOP = new Set(["about", "after", "again", "always", "being", "could", "every", "first", "great", "their", "there", "these", "thing", "things", "those", "through", "would", "where", "which", "while", "works", "working", "people", "really", "should", "around", "before", "using", "uses", "likes", "prefers", "wants", "needs"]);

/** The words in what it learned that would only be in its hello because it learned them: names, places, numbers, long words. */
export function knownTerms(facts: readonly Fact[]): { term: string; src: string }[] {
  const out = new Map<string, string>();
  for (const f of facts) {
    const words = f.text.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
    words.forEach((w, i) => {
      const bare = w.replace(/['’]s$/i, "");
      const lower = bare.toLowerCase();
      if (bare.length < 3 || STOP.has(lower)) return;
      const proper = i > 0 && /^\p{Lu}/u.test(bare);
      if (proper || /\d/.test(bare) || bare.length >= 7) if (!out.has(lower)) out.set(lower, f.src ?? "you");
    });
  }
  return [...out].map(([term, src]) => ({ term, src }));
}

const SRC_LABEL = (src: string) => (src === "you" ? "You told me" : `From ${src}`);

/** Underline the known words in a message's HTML (text only, never inside tags or links). */
export function markKnown(html: string, terms: readonly { term: string; src: string }[]): string {
  if (!terms.length || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  const escaped = terms.map((t) => t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join("|")})(?=[^\\p{L}\\p{N}]|$)`, "giu");
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.parentElement?.closest("a, code, pre")) nodes.push(t);
  }
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const m of text.matchAll(re)) {
      const start = (m.index ?? 0) + m[1].length;
      frag.append(text.slice(at, start));
      const span = doc.createElement("span");
      span.className = "ob-known";
      span.textContent = m[2];
      span.title = SRC_LABEL(terms.find((t) => t.term === m[2].toLowerCase())?.src ?? "you");
      frag.append(span);
      at = start + m[2].length;
    }
    frag.append(text.slice(at));
    node.replaceWith(frag);
  }
  return root.innerHTML;
}

/** The first `n` visible characters of some HTML, tags kept (for typing it in). */
export function cutHtml(html: string, n: number): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  let left = n;
  const walk = (el: Node) => {
    for (const child of [...el.childNodes]) {
      if (left <= 0) {
        child.remove();
        continue;
      }
      if (child.nodeType === 3) {
        const t = child as Text;
        if (t.data.length > left) t.data = t.data.slice(0, left);
        left -= t.data.length;
      } else walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

const typedKey = (id: string) => `wisp.helloTyped.${id}`;
const wasTyped = (id: string) => {
  try {
    return !!localStorage.getItem(typedKey(id));
  } catch {
    return true;
  }
};

/** Is this message the hello of a first chat (the agent's setup greeting)? */
function useHelloAgent(m: Message): Agent | undefined {
  return useStore((s) => {
    if (m.author.kind !== "agent") return undefined;
    const a = s.agents.find((x) => x.id === m.author.id);
    return a?.settings.setup?.greetingId === m.id ? a : undefined;
  });
}

/**
 * The HTML to show for a message: unchanged for most, but a first chat's hello types in once
 * (all at once under Reduce Motion) and underlines what it knows from setup.
 */
export function useFirstHelloHtml(m: Message, html: string): string {
  const agent = useHelloAgent(m);
  const reduced = useMotionReduced();
  const marked = useMemo(() => {
    if (!agent) return html;
    const facts = (loadAnswers(agent.workspaceId) as { facts?: Fact[] }).facts ?? [];
    return markKnown(html, knownTerms(facts));
  }, [agent, html]);
  // type it in only the first time it's seen, and only while it's new
  const [typing] = useState(() => !!agent && !reduced && !wasTyped(m.id) && Date.now() - Date.parse(m.createdAt) < 10 * 60_000);
  const total = useMemo(() => (typing ? (new DOMParser().parseFromString(marked, "text/html").body.textContent ?? "").length : 0), [typing, marked]);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!typing) return;
    try {
      localStorage.setItem(typedKey(m.id), "1");
    } catch {}
    const start = performance.now();
    let frame = 0;
    const step = () => {
      const next = Math.min(total, Math.floor(((performance.now() - start) / 1000) * 70));
      setN(next);
      if (next < total) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [typing, total, m.id]);
  if (!agent) return html;
  if (!typing || n >= total) return marked;
  return `${cutHtml(marked, n)}<span class="ob-caret" aria-hidden="true"></span>`;
}

/**
 * The host landing in the name pill: when the chat opens straight from setup, a ghost flies from
 * where the host last stood into the pill's avatar, then the pill's own ghost takes over.
 */
export function GhostLanding({ agent, target }: { agent: Agent; target: () => HTMLElement | null }) {
  const [from] = useState(() => (motionReduced() ? null : hostWasAt()));
  const ref = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(!from);
  useLayoutEffect(() => {
    const el = ref.current;
    const to = target()?.querySelector<HTMLElement>(".ghost") ?? target();
    if (!from || !el || !to || typeof el.animate !== "function") return setDone(true);
    const r = to.getBoundingClientRect();
    const s = r.width / from.width;
    const dx = r.left + r.width / 2 - (from.left + from.width / 2);
    const dy = r.top + r.height / 2 - (from.top + from.height / 2);
    to.style.opacity = "0";
    const a = el.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }], { duration: 750, easing: OB_EASE, fill: "forwards" });
    a.onfinish = () => {
      to.style.opacity = "";
      setDone(true);
    };
    return () => {
      to.style.opacity = "";
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (done || !from || !agent.settings.appearance) return null;
  return (
    <div ref={ref} aria-hidden className="fixed z-50 pointer-events-none" style={{ left: from.left, top: from.top, width: from.width, height: from.height, transformOrigin: "50% 50%" }}>
      <Ghost look={agent.settings.appearance} size={from.width} label="" />
    </div>
  );
}
