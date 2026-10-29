import { useId, type ReactNode } from "react";

/**
 * Wisp's own line icons for the four places (Inbox, Chats, Agents, Computers), drawn like the
 * approved design: 24px grid, 1.8 stroke, round caps. Everything else uses lucide.
 */
function Line({ size = 22, children, className }: { size?: number; children: ReactNode; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      {children}
    </svg>
  );
}

export const InboxIcon = (p: { size?: number; className?: string }) => (
  <Line {...p}>
    <path d="M3 13l3-8h12l3 8v6H3z" />
    <path d="M3 13h5l1 2h6l1-2h5" />
  </Line>
);

export const ChatsIcon = (p: { size?: number; className?: string }) => (
  <Line {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
  </Line>
);

export const AgentsIcon = (p: { size?: number; className?: string }) => (
  <Line {...p}>
    <path d="M12 2.5a7.5 7.5 0 0 0-7.5 7.5v11l2.5-1.7 2.5 1.7 2.5-1.7 2.5 1.7 2.5-1.7 2.5 1.7V10A7.5 7.5 0 0 0 12 2.5z" />
    <circle cx="9.5" cy="10.5" r="0.6" fill="currentColor" />
    <circle cx="14.5" cy="10.5" r="0.6" fill="currentColor" />
  </Line>
);

export const ComputersIcon = (p: { size?: number; className?: string }) => (
  <Line {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Line>
);

/**
 * Wisp's logo, "Peek": a purple-to-blue gradient tile with a white dome ghost that runs off the
 * bottom edge (the tile clips it) and looks to the side. It's full colour, so a text colour class
 * has no effect on it; the rail button, sign-in hero and welcome/authorize screens all show it as is.
 */
export function WispGhost({ size = 34, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className={className}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#BF5AF2" />
          <stop offset="1" stopColor="#0A84FF" />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <rect width="100" height="100" rx="23" />
        </clipPath>
      </defs>
      <rect width="100" height="100" rx="23" fill={`url(#${id}g)`} />
      <g clipPath={`url(#${id}c)`}>
        <path fill="#FFFFFF" d="M18 101 L18 62 C18 40 32 28 50 28 C68 28 82 40 82 62 L82 101Z" />
      </g>
      <ellipse cx="53" cy="55" rx="4.2" ry="6.6" fill="#15131C" />
      <ellipse cx="70" cy="55" rx="4.2" ry="6.6" fill="#15131C" />
    </svg>
  );
}
