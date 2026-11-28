import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppWindow, BellOff, Check, ChevronDown, ChevronRight, Copy, EyeOff, FileText, Folder, LogOut, Mail, MoreHorizontal, PenLine, Pin, PinOff, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { requestChatSearch } from "../chatSearch.ts";
import { MAX_PINS, type SidebarLayout } from "@bubble-ai/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go, href } from "../router.ts";
import { openDm } from "../openDm.ts";
import { addSection, baseLayout, clearUnread, deleteSection, foldSection, forget, hide, markUnread, moveTo, movePin, newSectionName, NONE, pin, pinsFullNotice, placeHome, renameSection, unpin } from "../sidebarLayout.ts";
import { ChatAvatar, shortTime, type Chat, type PreviewLine } from "./ChatList.tsx";
import { ChannelSettings, leaveChannel, setChannelPrefs } from "./Channels.tsx";
import { ConfirmDialog } from "./InboxParts.tsx";
import { cx } from "./ui.tsx";

/**
 * The list of agents and teams (2026-11-25 "Bubble AI, bubbles", boards 3 and 7), the same on desktops
 * (in the sidebar) and phones (the Chats page): up to 9 pins in a 3×3 grid, an All / Your turn
 * filter, then the person's own sections (rename in place, fold, drag agents and teams between
 * them) and "No section". Right-click (press and hold on a phone) for the menu. Pins and sections
 * are kept per person in the hub, so every device shows the same list.
 */

const LEGACY_FOLDED = "wisp.chats.collapsed";
const DRAG = "text/x-wisp-chat";
const NEW_SECTION = "wisp:new-section";

/** "New section" from a + menu: the list adds one and puts its name up for editing. */
export function newSideSection() {
  window.dispatchEvent(new Event(NEW_SECTION));
}

const readJson = <T,>(k: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "") as T;
  } catch {
    return fallback;
  }
};

/** The open menu: whose, where, and whether it opens to the left (a pin in the third column). */
type MenuAt = { key: string; x: number; y: number; left?: boolean; tile?: boolean };

/** A small blue dot for unread, the agent's own flag says when it needs you. */
/** The one mark a chat gets (round 4): a blue dot when its agent needs you or there's something unread. */
export const BLUE_DOT = "#0a84ff";
/** Needs you or unread: a blue dot on the bubble's top-left corner, as on the pins */
function BlueDot({ on }: { on: boolean }) {
  return on ? <span aria-hidden className="side-pin-dot side-row-dot" style={{ background: BLUE_DOT }} /> : null;
}

export function useSideLayout(chats: readonly Chat[]): [SidebarLayout, (next: SidebarLayout) => void] {
  const saved = useStore((s) => s.me?.prefs.sidebar);
  const sections = useStore((s) => s.sections);
  const layout = useMemo(() => baseLayout(saved, chats, sections, readJson(LEGACY_FOLDED, {})), [saved, chats, sections]);
  const save = (next: SidebarLayout) => {
    void useStore
      .getState()
      .setPrefs({ sidebar: next })
      .catch((e) => alert((e as Error).message));
  };
  return [layout, save];
}

/**
 * What the chat menus do (round 16): the wide sidebar's list and the narrow rail share them, so Pin
 * and Unpin work the same in both. Pins are the sidebar layout's; a team's star follows along.
 */
function useChatActions(chats: readonly Chat[], active: string | null) {
  const [layout, save] = useSideLayout(chats);
  const [notice, setNotice] = useState<string | null>(null);
  const doPin = (c: Chat) => {
    const next = pin(layout, c.key);
    if (!next) return setNotice(pinsFullNotice(c.name));
    setNotice(null);
    save(next);
    if (c.channel && !c.channel.starred) void setChannelPrefs(c.channel, { starred: true }).catch(() => {});
  };
  const doUnpin = (c: Chat) => {
    save(unpin(layout, c.key));
    if (c.channel?.starred) void setChannelPrefs(c.channel, { starred: false }).catch(() => {});
  };
  const doMove = (c: Chat, sectionId: string) => {
    const wasPinned = layout.pins.includes(c.key);
    save(sectionId === NONE ? moveTo(layout, c.key, "__none__") : moveTo(layout, c.key, sectionId));
    if (wasPinned && c.channel?.starred) void setChannelPrefs(c.channel, { starred: false }).catch(() => {});
  };
  const doRename = async (c: Chat, name: string) => {
    const clean = name.trim();
    if (!clean || clean === c.name) return;
    try {
      if (c.kind === "dm" && c.agent) {
        await api("PATCH", `/api/agents/${c.agent.id}`, { name: clean.slice(0, 80) });
        await useStore.getState().refreshAgents();
      } else if (c.channel) {
        const slug = clean.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 80);
        if (!slug) return;
        await api("PATCH", `/api/channels/${c.channel.id}`, { name: slug });
        await useStore.getState().refreshChannels();
      }
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const doDelete = async (c: Chat) => {
    if (c.kind === "dm" && c.agent) {
      await api("DELETE", `/api/agents/${c.agent.id}`);
      await useStore.getState().refreshAgents();
    } else if (c.channel) {
      await api("DELETE", `/api/channels/${c.channel.id}`);
      await useStore.getState().refreshChannels();
    }
    save(forget(layout, c.key));
    if (c.channel && c.channel.id === active) go({ view: "chats" });
  };

  return { layout, save, notice, setNotice, doPin, doUnpin, doMove, doRename, doDelete };
}

export function SideList({ chats, lines, active, phone = false }: { chats: Chat[]; lines: Map<string, PreviewLine>; active: string | null; phone?: boolean }) {
  const me = useStore((s) => s.me)!;
  const clock = useStore((s) => s.me?.prefs.clock) ?? "auto";
  const guest = me.role === "guest";
  const { layout, save, notice, setNotice, doPin, doUnpin, doMove, doRename: renameTo, doDelete } = useChatActions(chats, active);
  const doRename = (c: Chat, name: string) => {
    setRenaming(null);
    return renameTo(c, name);
  };
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Chat | null>(null);
  const [settingsFor, setSettingsFor] = useState<Chat | null>(null);

  const byKey = useMemo(() => new Map(chats.map((c) => [c.key, c])), [chats]);
  const home = useMemo(() => placeHome(layout, chats), [layout, chats]);
  const placed = { sections: home.folders };
  const unreadMarks = useMemo(() => new Set(layout.unread ?? []), [layout.unread]);
  const isUnread = (c: Chat) => c.unread > 0 || unreadMarks.has(c.key);

  // opening a chat you marked unread clears the mark
  const activeKey = chats.find((c) => c.channel && c.channel.id === active)?.key;
  useEffect(() => {
    if (activeKey && unreadMarks.has(activeKey)) save(clearUnread(layout, activeKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const open = (c: Chat) => (c.channel ? go({ view: "chat", channelId: c.channel.id, threadId: null }) : c.agent && void openDm(c.agent.id));
  const urlOf = (c: Chat) => (c.channel ? href({ view: "chat", channelId: c.channel.id, threadId: null }) : undefined);

  const doNewSection = (c?: Chat) => {
    const id = `s${Date.now().toString(36)}`;
    save(addSection(layout, newSectionName(layout), id, c?.key));
    setEditing(id);
  };
  const newRef = useRef(doNewSection);
  newRef.current = doNewSection;
  useEffect(() => {
    const on = () => newRef.current();
    window.addEventListener(NEW_SECTION, on);
    return () => window.removeEventListener(NEW_SECTION, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // --- drag and drop (desktop) -------------------------------------------------------------------
  const dragProps = (c: Chat) =>
    phone || guest
      ? {}
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG, c.key);
            e.dataTransfer.effectAllowed = "move";
            setDragging(c.key);
          },
          onDragEnd: () => (setDragging(null), setHot(null)),
        };
  const dropProps = (target: string, onDrop: (key: string) => void) =>
    phone || guest
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (hot !== target) setHot(target);
          },
          onDragLeave: (e: React.DragEvent) => {
            if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setHot((h) => (h === target ? null : h));
          },
          onDrop: (e: React.DragEvent) => {
            const key = e.dataTransfer.getData(DRAG);
            e.preventDefault();
            setHot(null);
            setDragging(null);
            if (key) onDrop(key);
          },
        };

  const menuFor = (c: Chat, e: { clientX: number; clientY: number; preventDefault: () => void }, left?: boolean, tile?: boolean) => {
    e.preventDefault();
    setMenu({ key: c.key, x: e.clientX, y: e.clientY, left, tile });
  };
  const press = useLongPress((key, x, y) => setMenu({ key, x, y }));

  // --- tiles (round 16, board 16c): only what's pinned -------------------------------------------
  // round 8 sizes (owner, 2026-11-28: "make them bigger"): 68 in the sidebar, the iPhone's 80 on phones
  const tileSize = phone ? 80 : 68;
  const tiles = home.tiles.map((k) => byKey.get(k)!).filter(Boolean);
  const tileGrid = tiles.length > 0 && (
    <div
      data-tour="pins"
      aria-label="Pinned"
      role="list"
      className={cx("side-tiles grid grid-cols-3 gap-x-1 gap-y-1 rounded-[14px]", phone ? "px-1 pb-1.5 pt-2.5" : "px-0.5 pb-2 pt-3", hot === "pins" && "bg-[var(--wisp-soft,rgba(122,91,220,.10))]")}
      {...dropProps("pins", (key) => {
        const c = byKey.get(key);
        if (!c || layout.pins.includes(key)) return;
        doPin(c);
      })}
    >
      {tiles.map((c, i) => {
        const line = lines.get(c.key);
        const unread = isUnread(c);
        const pinned = layout.pins.includes(c.key);
        const label = `${c.name}${pinned ? ", pinned" : ""}${c.unread > 0 ? `, ${c.unread} unread` : unread ? ", unread" : ""}${line?.working ? ", working" : ""}${line?.needs ? ", needs you" : ""}`;
        const isActive = !!c.channel && c.channel.id === active;
        const loud = unread || !!line?.needs;
        return (
          <div key={c.key} role="listitem" className={cx("relative flex justify-center", dragging === c.key && "opacity-40")}>
            <a
              href={urlOf(c) ?? "#"}
              onClick={(e) => {
                if (!c.channel) {
                  e.preventDefault();
                  open(c);
                }
              }}
              onContextMenu={(e) => menuFor(c, e, i % 3 === 2, true)}
              {...press(c.key)}
              {...dragProps(c)}
              {...dropProps(`pin:${c.key}`, (key) => layout.pins.includes(key) && pinned && save(movePin(layout, key, layout.pins.indexOf(c.key))))}
              aria-label={label}
              aria-current={isActive ? "page" : undefined}
              data-bub-host=""
              className={cx("side-tile press-row flex w-full flex-col items-center justify-center gap-[5px] rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40", phone ? "h-[138px]" : "h-[122px]", isActive ? "side-row-on" : menu?.key === c.key && menu.tile ? "bg-side-active" : "hover:bg-side-hover")}
            >
              <span className="relative grid place-items-center" style={{ width: tileSize, height: tileSize }}>
                <ChatAvatar chat={c} size={tileSize} />
                {loud && <span aria-hidden className="side-tile-dot" style={{ background: BLUE_DOT }} />}
              </span>
              {renaming === c.key ? (
                <RenameField value={c.name} onDone={(v) => void doRename(c, v)} className={cx("text-center", phone ? "w-[100px] text-[13px]" : "w-[84px] text-[12.5px]")} />
              ) : (
                <span className={cx("truncate", phone ? "max-w-[104px] text-[13px]" : "max-w-[88px] text-[12.5px]", loud || isActive ? "font-semibold text-ink" : "text-muted")}>{c.name}</span>
              )}
            </a>
          </div>
        );
      })}
    </div>
  );

  // --- rows: the chats in each folder ------------------------------------------------------------
  const avatar = phone ? 46 : 36;
  const row = (c: Chat) => {
    const line = lines.get(c.key);
    const unread = isUnread(c);
    const isActive = !!c.channel && c.channel.id === active;
    const label = `${c.name}${c.unread > 0 ? `, ${c.unread} unread` : unread ? ", unread" : ""}${line?.working ? ", working" : ""}${line?.needs ? ", needs you" : ""}`;
    return (
      <div key={c.key} className={cx("relative", dragging === c.key && "opacity-35")}>
        <a
          href={urlOf(c) ?? "#"}
          onClick={(e) => {
            if (!c.channel) {
              e.preventDefault();
              open(c);
            }
          }}
          onContextMenu={(e) => menuFor(c, e)}
          {...press(c.key)}
          {...dragProps(c)}
          aria-label={label}
          aria-current={isActive ? "page" : undefined}
          data-tour="chat-row"
          data-needs={line?.needs ? "" : undefined}
          data-bub-host=""
          className={cx(
            "press-row group/row flex w-full items-center gap-3 text-left outline-none transition-[background-color] duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
            phone ? "rounded-[14px] px-[10px] py-2" : "h-[58px] rounded-[12px] px-3",
            isActive ? "bg-side-active" : menu?.key === c.key && !menu.tile ? "bg-side-active" : "hover:bg-side-hover",
          )}
        >
          {c.agent ? (
            // the agent's avatar opens its profile; the rest of the row opens the chat
            <span
              role="button"
              tabIndex={-1}
              aria-label={`${c.agent.name}'s profile`}
              title={`${c.agent.name}'s profile`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                go({ view: "agents", agentId: c.agent!.id, tab: "overview" });
              }}
              className="relative grid shrink-0 cursor-pointer place-items-center outline-none"
              style={{ width: avatar, height: avatar }}
            >
              <ChatAvatar chat={c} size={avatar} />
              <BlueDot on={unread || !!line?.needs} />
            </span>
          ) : (
            <span className="relative grid shrink-0 place-items-center" style={{ width: avatar, height: avatar }}>
              <ChatAvatar chat={c} size={avatar} />
              <BlueDot on={unread || !!line?.needs} />
            </span>
          )}
          <span className={cx("flex min-w-0 flex-1 flex-col", c.muted && "opacity-60")}>
            <span className="flex items-baseline gap-2">
              {renaming === c.key ? (
                <RenameField value={c.name} onDone={(v) => void doRename(c, v)} className="min-w-0 flex-1 text-[14px] font-semibold" />
              ) : (
                <span className={cx("min-w-0 flex-1 truncate font-semibold text-ink", phone ? "text-[15.5px]" : "text-[14px]")}>{c.name}</span>
              )}
              {c.at > 0 && <span className={cx("shrink-0", phone ? "text-[12.5px]" : "text-[12px]", unread ? "font-semibold text-[#0a84ff]" : "text-muted")}>{shortTime(c.at, clock)}</span>}
            </span>
            {line?.text && (
              <span className={cx("mt-0.5 flex min-w-0 items-center gap-1.5", phone ? "text-[14px]" : "text-[13px]", line.working ? "text-wisp-strong" : unread || line.needs ? "text-ink" : "text-muted")}>
                {line.icon && <span className="inline-flex shrink-0 items-center">{line.icon}</span>}
                <span className={cx("truncate", line.working && "shimmer-text")}>{line.text}</span>
              </span>
            )}
          </span>
        </a>
      </div>
    );
  };

  // --- folders ------------------------------------------------------------------------------------
  const sectionBlock = (s: (typeof placed.sections)[number]) => {
    const isHot = hot === `sec:${s.id}`;
    const dragName = dragging ? byKey.get(dragging)?.name : null;
    const isEditing = editing === s.id && !s.none;
    return (
      <section key={s.id} aria-label={s.name} className={cx("flex flex-col rounded-[12px]", isHot && s.keys.length > 0 && "bg-[var(--wisp-soft,rgba(122,91,220,.10))]")} {...dropProps(`sec:${s.id}`, (key) => byKey.get(key) && doMove(byKey.get(key)!, s.id))}>
        {s.none && layout.sections.length === 0 ? (
          // no folders: the chats under the pins are just "Chats"
          tiles.length > 0 && !phone ? <div className="px-3 pb-1.5 pt-4 text-[12.5px] font-medium text-muted">Chats</div> : null
        ) : isEditing ? (
          <div className={cx("flex items-center gap-1.5", phone ? "px-[10px] pb-1 pt-3.5" : "px-3 pb-1.5 pt-4")}>
            <RenameField
              value={layout.sections.find((x) => x.id === s.id)?.name ?? s.name}
              onDone={(v) => {
                setEditing(null);
                save(renameSection(layout, s.id, v));
              }}
              className="h-[26px] flex-1 rounded-[7px] bg-[var(--control,var(--panel))] px-2 text-[13px] font-semibold shadow-[inset_0_0_0_1.5px_var(--wisp)]"
            />
          </div>
        ) : (
          <SectionHeader
            name={s.name}
            folded={s.folded}
            phone={phone}
            canEdit={!guest && !s.none}
            onToggle={() => save(foldSection(layout, s.id, !s.folded))}
            onRename={() => setEditing(s.id)}
            onDelete={() => save(deleteSection(layout, s.id))}
          />
        )}
        {!s.folded && s.keys.map((k) => byKey.get(k)).filter((c): c is Chat => !!c).map(row)}
        {!s.folded && !s.none && s.keys.length === 0 && (
          <div className={cx("mx-1 mb-1.5 mt-0.5 grid h-[48px] place-items-center rounded-[12px] border-[1.5px] border-dashed text-[13px]", isHot ? "border-wisp bg-[var(--wisp-soft,rgba(122,91,220,.10))] font-semibold text-wisp-strong" : "border-line2 text-muted")}>
            {isHot && dragName ? `Drop to move ${dragName} here` : phone ? "Hold a chat, then Move to" : "Drag chats here"}
          </div>
        )}
      </section>
    );
  };

  const shownSections = placed.sections.filter((s) => !s.none || s.keys.length > 0);
  const menuChat = menu ? byKey.get(menu.key) : undefined;

  return (
    // the tour's "blue dot" stop points at the whole list (tour.ts)
    <div data-tour="yourturn" className="flex flex-col">
      {notice && (
        <div role="status" className="m-pop mx-0.5 mb-2 flex items-center gap-2.5 rounded-[12px] bg-panel px-3 py-2.5 text-[13px] text-ink shadow-[0_12px_36px_rgba(0,0,0,.16),0_0_0_1px_rgba(0,0,0,.06)]">
          <Pin size={15} strokeWidth={2} className="shrink-0 text-muted" aria-hidden />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded px-1 py-0.5 font-semibold hover:bg-hover">
            OK
          </button>
        </div>
      )}
      {tiles.length > 0 && !phone && <div className="px-3 pt-1 text-[12.5px] font-medium text-muted">Pinned</div>}
      {tileGrid}
      <div data-tour="sections" className="flex flex-col gap-0.5">
        {shownSections.map(sectionBlock)}
        {/* New section is in the + menu, once */}
      </div>

      {menu && menuChat && (
        <SideMenu
          chat={menuChat}
          at={menu}
          phone={phone}
          guest={guest}
          pinned={layout.pins.includes(menuChat.key)}
          pinsFull={layout.pins.length >= MAX_PINS}
          unread={isUnread(menuChat)}
          sections={layout.sections}
          here={layout.sections.find((s) => s.items.includes(menuChat.key))?.id ?? NONE}
          onClose={() => setMenu(null)}
          onPin={() => doPin(menuChat)}
          onUnpin={() => doUnpin(menuChat)}
          onMove={(id) => doMove(menuChat, id)}
          onNewSection={() => doNewSection(menuChat)}
          onMarkUnread={() => save(markUnread(layout, menuChat.key))}
          onMarkRead={() => {
            save(clearUnread(layout, menuChat.key));
            if (menuChat.channel?.unread) useStore.getState().markRead(menuChat.channel.id);
          }}
          onNewWindow={() => {
            const url = urlOf(menuChat);
            if (url) window.open(url, "_blank", "noopener");
          }}
          onRename={() => setRenaming(menuChat.key)}
          onHide={() => save(hide(layout, menuChat.key))}
          onSearch={() => {
            if (!menuChat.channel) return;
            requestChatSearch(menuChat.channel.id);
            open(menuChat);
          }}
          onMute={() => menuChat.channel && void setChannelPrefs(menuChat.channel, { notify: menuChat.channel.notify === "mute" ? "default" : "mute" })}
          onTeamSettings={() => setSettingsFor(menuChat)}
          onLeave={() => menuChat.channel && void leaveChannel(menuChat.channel)}
          onDelete={() => setConfirm(menuChat)}
          onTemplate={() => menuChat.channel && void api("POST", "/api/team-templates", { channelId: menuChat.channel.id, name: menuChat.name }).then(() => setNotice(`Saved ${menuChat.name} as a template. Find it under New team.`), (e) => setNotice((e as Error).message))}
          line={lines.get(menuChat.key)}
        />
      )}
      {confirm && (
        <DeleteConfirm chat={confirm} onClose={() => setConfirm(null)} onDelete={() => doDelete(confirm)} />
      )}
      {settingsFor?.channel && createPortal(<ChannelSettings channel={settingsFor.channel} onClose={() => setSettingsFor(null)} />, document.body)}
    </div>
  );
}

/**
 * The narrow rail's right-click menu (round 16, board 16c): the same menu as the wide sidebar, so
 * Pin and Unpin are there too. Rename is in the wide sidebar, where the name can be edited in place.
 */
export function RailChatMenu({ chats, chat, at, active, line, onClose, onNewFolder }: { chats: readonly Chat[]; chat: Chat; at: { x: number; y: number }; active: string | null; line?: PreviewLine; onClose: () => void; onNewFolder: () => void }) {
  const guest = useStore((s) => s.me?.role) === "guest";
  const { layout, save, notice, setNotice, doPin, doUnpin, doMove, doDelete } = useChatActions(chats, active);
  const [confirm, setConfirm] = useState(false);
  const [settings, setSettings] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const unread = chat.unread > 0 || (layout.unread ?? []).includes(chat.key);
  const url = chat.channel ? href({ view: "chat", channelId: chat.channel.id, threadId: null }) : undefined;
  const open = () => (chat.channel ? go({ view: "chat", channelId: chat.channel.id, threadId: null }) : chat.agent && void openDm(chat.agent.id));
  const done = () => !confirm && !settings && !notice && onClose();
  // the menu closes as soon as something is picked; what it opened (a confirm, settings, a notice) stays
  const closeMenu = () => setMenuOpen(false);
  useEffect(() => {
    if (!menuOpen) done();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, confirm, settings, notice]);
  return (
    <>
      {menuOpen && (
        <SideMenu
          chat={chat}
          at={{ key: chat.key, ...at }}
          phone={false}
          guest={guest}
          pinned={layout.pins.includes(chat.key)}
          pinsFull={layout.pins.length >= MAX_PINS}
          unread={unread}
          sections={layout.sections}
          here={layout.sections.find((x) => x.items.includes(chat.key))?.id ?? NONE}
          onClose={closeMenu}
          onPin={() => doPin(chat)}
          onUnpin={() => doUnpin(chat)}
          onMove={(id) => doMove(chat, id)}
          onNewSection={onNewFolder}
          onMarkUnread={() => save(markUnread(layout, chat.key))}
          onMarkRead={() => {
            save(clearUnread(layout, chat.key));
            if (chat.channel?.unread) useStore.getState().markRead(chat.channel.id);
          }}
          onNewWindow={() => url && window.open(url, "_blank", "noopener")}
          onHide={() => save(hide(layout, chat.key))}
          onSearch={() => {
            if (!chat.channel) return;
            requestChatSearch(chat.channel.id);
            open();
          }}
          onMute={() => chat.channel && void setChannelPrefs(chat.channel, { notify: chat.channel.notify === "mute" ? "default" : "mute" })}
          onTeamSettings={() => setSettings(true)}
          onLeave={() => chat.channel && void leaveChannel(chat.channel)}
          onDelete={() => setConfirm(true)}
          onTemplate={() => chat.channel && void api("POST", "/api/team-templates", { channelId: chat.channel.id, name: chat.name }).then(() => setNotice(`Saved ${chat.name} as a template. Find it under New team.`), (e) => setNotice((e as Error).message))}
          line={line}
        />
      )}
      {notice &&
        createPortal(
          <div role="status" className="m-pop fixed bottom-4 left-[110px] z-[95] flex w-[300px] items-center gap-2.5 rounded-[12px] bg-panel px-3 py-2.5 text-[13px] text-ink shadow-[0_12px_36px_rgba(0,0,0,.16),0_0_0_1px_rgba(0,0,0,.06)]">
            <Pin size={15} strokeWidth={2} className="shrink-0 text-muted" aria-hidden />
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="rounded px-1 py-0.5 font-semibold hover:bg-hover">
              OK
            </button>
          </div>,
          document.body,
        )}
      {confirm && <DeleteConfirm chat={chat} onClose={() => setConfirm(false)} onDelete={() => doDelete(chat)} />}
      {settings && chat.channel && createPortal(<ChannelSettings channel={chat.channel} onClose={() => setSettings(false)} />, document.body)}
    </>
  );
}

function DeleteConfirm({ chat, onClose, onDelete }: { chat: Chat; onClose: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = chat.kind === "team";
  return (
    <ConfirmDialog
      title={`Delete ${chat.name}?`}
      body={
        <>
          {team ? "Its messages and threads are deleted for everyone. This can't be undone." : "Its notes and personality stay in memory. Its schedules and chats stop."}
          {error && <span className="mt-2 block text-bad">{error}</span>}
        </>
      }
      confirm="Delete"
      keep="Keep it"
      danger
      busy={busy}
      onClose={onClose}
      onConfirm={() => {
        setBusy(true);
        setError(null);
        onDelete().then(onClose, (e) => (setError((e as Error).message), setBusy(false)));
      }}
    />
  );
}

/** A name field that saves on Enter or when it loses focus, and puts the old name back on Escape. */
function RenameField({ value, onDone, className }: { value: string; onDone: (v: string) => void; className?: string }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (val: string) => {
    if (done.current) return;
    done.current = true;
    onDone(val);
  };
  return (
    <input
      ref={ref}
      value={v}
      maxLength={40}
      aria-label="Name"
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => (e.preventDefault(), e.stopPropagation())}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(v);
        else if (e.key === "Escape") finish(value);
      }}
      onBlur={() => finish(v)}
      className={cx("bg-transparent text-ink outline-none", className)}
    />
  );
}

function SectionHeader({ name, folded, phone, canEdit, onToggle, onRename, onDelete }: { name: string; folded: boolean; phone: boolean; canEdit: boolean; onToggle: () => void; onRename: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        onDoubleClick={canEdit ? (e) => (e.preventDefault(), onRename()) : undefined}
        onContextMenu={canEdit ? (e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY })) : undefined}
        aria-expanded={!folded}
        className={cx("flex w-fit items-center gap-1.5 rounded-[8px] text-left font-medium text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/40", phone ? "px-[10px] pb-1 pt-3.5 text-[14px]" : "px-3 pb-1.5 pt-4 text-[12.5px]")}
      >
        <span className="truncate">{name}</span>
        <ChevronDown size={12} strokeWidth={2} aria-hidden className={cx("shrink-0", folded && "-rotate-90")} />
      </button>
      {menu && (
        <Pop at={menu} onClose={() => setMenu(null)} label={name}>
          {(close) => (
            <>
              <Item icon={<PenLine size={16} />} onClick={() => (close(), onRename())}>
                Rename folder
              </Item>
              <Item icon={<Trash2 size={16} />} danger onClick={() => (close(), onDelete())}>
                Delete folder
              </Item>
            </>
          )}
        </Pop>
      )}
    </>
  );
}

/**
 * The right-click / press-and-hold menu (round 11, board 11): Mark unread, Pin, Move to (its folders
 * open right in the menu), Share as template (teams), Hide, and More for the rest (Rename, Search in chat, Mute,
 * Open in new window, Team settings, Leave team, Copy ID, Delete). It opens and closes at once.
 */
function SideMenu(p: {
  chat: Chat;
  at: MenuAt;
  phone: boolean;
  guest: boolean;
  pinned: boolean;
  pinsFull: boolean;
  unread: boolean;
  sections: SidebarLayout["sections"];
  here: string;
  onClose: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onMove: (sectionId: string) => void;
  onNewSection: () => void;
  onMarkUnread: () => void;
  onMarkRead: () => void;
  onNewWindow: () => void;
  /** absent where the name can't be edited in place (the narrow rail) */
  onRename?: () => void;
  onHide: () => void;
  onMute: () => void;
  onSearch: () => void;
  onTeamSettings: () => void;
  onLeave: () => void;
  onDelete: () => void;
  onTemplate: () => void;
  line?: PreviewLine;
}) {
  const [open, setOpen] = useState<"move" | "more" | null>(null);
  const { chat } = p;
  const team = chat.kind === "team";
  const muted = chat.channel?.notify === "mute";
  const small = !p.phone;
  const id = chat.channel?.id ?? chat.agent?.id ?? chat.key;
  return (
    <Pop at={p.at} onClose={p.onClose} label={chat.name} left={p.at.left} phone={p.phone} preview={p.phone ? { chat, line: p.line } : undefined}>
      {(close) => (
        <>
          {p.unread ? (
            <Item small={small} icon={<Mail size={16} />} onClick={() => (close(), p.onMarkRead())}>
              Mark read
            </Item>
          ) : (
            <Item small={small} icon={<Mail size={16} />} onClick={() => (close(), p.onMarkUnread())}>
              Mark unread
            </Item>
          )}
          {p.pinned ? (
            <Item small={small} icon={<PinOff size={16} />} onClick={() => (close(), p.onUnpin())}>
              Unpin
            </Item>
          ) : (
            <Item small={small} icon={<Pin size={16} />} hint={p.pinsFull ? `${MAX_PINS} of ${MAX_PINS}` : undefined} onClick={() => (close(), p.onPin())}>
              Pin
            </Item>
          )}
          {!p.guest && (
            <Item small={small} icon={<Folder size={16} />} on={open === "move"} more={<ChevronDown size={15} className={cx("text-muted", open !== "move" && "-rotate-90")} />} onClick={() => setOpen((o) => (o === "move" ? null : "move"))} expanded={open === "move"}>
              Move to
            </Item>
          )}
          {open === "move" && (
            <div className="flex flex-col pb-[3px] pl-[28px]">
              {[...p.sections.map((s) => ({ id: s.id, name: s.name })), { id: NONE, name: "Unsorted" }].map((s) => (
                <Item key={s.id} sub icon={p.here === s.id ? <Check size={15} /> : <span className="inline-block w-[15px]" />} onClick={() => (close(), p.onMove(s.id))}>
                  {s.name}
                </Item>
              ))}
              <Item sub muted icon={<Plus size={15} />} onClick={() => (close(), p.onNewSection())}>
                New folder
              </Item>
            </div>
          )}
          {team && !p.guest && (
            <Item small={small} icon={<FileText size={16} />} onClick={() => (close(), p.onTemplate())}>
              Share as template
            </Item>
          )}
          <Item small={small} danger icon={<EyeOff size={16} />} onClick={() => (close(), p.onHide())}>
            Hide
          </Item>
          <Item small={small} icon={<MoreHorizontal size={16} />} on={open === "more"} more={<ChevronRight size={15} className={cx("text-muted", open === "more" && "rotate-90")} />} onClick={() => setOpen((o) => (o === "more" ? null : "more"))} expanded={open === "more"}>
            More
          </Item>
          {open === "more" && (
            <div className="flex flex-col pb-[3px] pl-[28px]">
              {!p.guest && p.onRename && (
                <Item sub icon={<PenLine size={15} />} onClick={() => (close(), p.onRename?.())}>
                  Rename
                </Item>
              )}
              {chat.channel && (
                <Item sub icon={<Search size={15} />} onClick={() => (close(), p.onSearch())}>
                  Search in chat
                </Item>
              )}
              {chat.channel && (
                <Item sub icon={<BellOff size={15} />} onClick={() => (close(), p.onMute())}>
                  {muted ? "Unmute" : "Mute"}
                </Item>
              )}
              {chat.channel && !p.phone && (
                <Item sub icon={<AppWindow size={15} />} onClick={() => (close(), p.onNewWindow())}>
                  Open in new window
                </Item>
              )}
              {team && !p.guest && (
                <Item sub icon={<Settings2 size={15} />} onClick={() => (close(), p.onTeamSettings())}>
                  Team settings
                </Item>
              )}
              {team && chat.channel?.joined && chat.channel.name !== "general" && (
                <Item sub icon={<LogOut size={15} />} onClick={() => (close(), p.onLeave())}>
                  Leave team
                </Item>
              )}
              <Item sub icon={<Copy size={15} />} onClick={() => (close(), void navigator.clipboard?.writeText(id).catch(() => {}))}>
                Copy ID
              </Item>
              {!p.guest && (
                <Item sub danger icon={<Trash2 size={15} />} onClick={() => (close(), p.onDelete())}>
                  Delete
                </Item>
              )}
            </div>
          )}
        </>
      )}
    </Pop>
  );
}

function Item({ icon, children, onClick, danger, more, hint, small, sub, muted, expanded, on }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; more?: ReactNode; hint?: string; small?: boolean; sub?: boolean; muted?: boolean; expanded?: boolean; on?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-expanded={expanded}
      onClick={onClick}
      className={cx("flex w-full items-center gap-2.5 rounded-[10px] px-[11px] text-left outline-none hover:bg-hover focus-visible:bg-hover", sub ? (small === false ? "h-[34px] text-[14.5px]" : "h-[30px] text-[13.5px]") : small ? "h-8 text-[13.5px]" : "h-[38px] text-[14.5px]", on && "bg-hover", danger ? "text-[#ff453a]" : muted ? "text-muted" : "text-ink")}
    >
      {icon && <span className="grid shrink-0 opacity-90">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="text-[13px] text-muted">{hint}</span>}
      {more}
    </button>
  );
}

/**
 * A floating menu at a point; opens to the left of it when `left` (a tile in the third column).
 * Phones (board 11): everything else blurs, the chat lifts into a card at the top and the menu sits under it.
 */
function Pop({ at, onClose, label, left, phone, preview, children }: { at: { x: number; y: number }; onClose: () => void; label: string; left?: boolean; phone?: boolean; preview?: { chat: Chat; line?: PreviewLine }; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: at.x, top: at.y, visibility: "hidden" });
  useLayoutEffect(() => {
    const el = ref.current;
    if (phone || !el) return;
    // placed again whenever it grows (Move to and More open inline), so it never runs off the window
    const place = () => {
      const r = el.getBoundingClientRect();
      const x = left ? at.x - r.width : at.x;
      setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [at.x, at.y, left, phone]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  const menu = (
    <div ref={ref} role="menu" aria-label={label} style={phone ? undefined : { position: "fixed", ...pos }} className={cx("side-menu flex flex-col p-[5px]", phone ? "w-[250px] max-w-full" : "max-h-[calc(100vh-16px)] w-[230px] overflow-y-auto")}>
      {children(onClose)}
    </div>
  );
  return createPortal(
    <div className={cx("fixed inset-0 z-[90]", phone && "bg-black/40 backdrop-blur-[8px]")} onMouseDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => (e.preventDefault(), onClose())} onTouchStart={(e) => e.target === e.currentTarget && onClose()}>
      {phone ? (
        <div className="absolute inset-x-[18px] top-[max(96px,calc(env(safe-area-inset-top)+52px))] flex max-h-[calc(100%-120px)] flex-col gap-3 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          {preview && (
            <div className="rounded-[20px] bg-[var(--r11-card)] p-3.5 shadow-[0_14px_40px_rgba(0,0,0,.4)]">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <ChatAvatar chat={preview.chat} size={28} />
                <span className="truncate">{preview.chat.name}</span>
              </div>
              {preview.line?.text && <div className="rounded-[20px] bg-side-active px-3.5 py-[9px] text-[14px] leading-[20px]">{preview.line.text}</div>}
            </div>
          )}
          {menu}
        </div>
      ) : (
        menu
      )}
    </div>,
    document.body,
  );
}

/** Press and hold (phones) opens the menu at the finger. */
function useLongPress(onPress: (key: string, x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => clearTimeout(timer.current);
  return (key: string) => ({
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => onPress(key, t.clientX, t.clientY), 480);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 8) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  });
}
