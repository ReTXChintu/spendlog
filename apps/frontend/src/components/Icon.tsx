// The SpendLog icon set (docs/design-assets/icons): 24 grid, stroke
// currentColor at 1.75, round caps and joins. Generated from icons.json and
// mounted once at the app root; <Icon name="ic-bank" /> resolves through
// <use href="#ic-bank">.
//
// Older names from before the redesign still work: ALIASES maps each one to
// its design equivalent, so a stored category icon or an old call site
// keeps rendering. Glyphs the design set has no equivalent for (category
// icons such as ic-food, ic-car) are kept, redrawn on the same grid.

/** Pre-redesign icon names, mapped to the design set's. */
const ALIASES: Record<string, string> = {
  "ic-receipt": "ic-list",
  "ic-trend": "ic-trending-up",
  "ic-people": "ic-users",
  "ic-spark": "ic-sparkles",
  "ic-sync": "ic-refresh",
  "ic-alert": "ic-alert-triangle",
  "ic-updown": "ic-transfer",
  "ic-dots": "ic-more-vertical",
  "ic-settings": "ic-sliders",
};

export function IconSprite() {
  return (
    <svg style={{ display: "none" }} aria-hidden="true">
      <defs>
      <symbol id="ic-search" viewBox="0 0 24 24"><path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4" /></symbol>
      <symbol id="ic-home" viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /></symbol>
      <symbol id="ic-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></symbol>
      <symbol id="ic-bar-chart" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></symbol>
      <symbol id="ic-bank" viewBox="0 0 24 24"><path d="M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z" /></symbol>
      <symbol id="ic-credit-card" viewBox="0 0 24 24"><path d="M3 6h18v12H3zM3 10h18M7 15h4" /></symbol>
      <symbol id="ic-trending-up" viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8M14 7h7v7" /></symbol>
      <symbol id="ic-target" viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" /></symbol>
      <symbol id="ic-list-checks" viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></symbol>
      <symbol id="ic-repeat" viewBox="0 0 24 24"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4" /></symbol>
      <symbol id="ic-banknote" viewBox="0 0 24 24"><path d="M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v4M18 10v4" /></symbol>
      <symbol id="ic-piggy-bank" viewBox="0 0 24 24"><path d="M5 11a7 6 0 0 1 13-2h2v4l-2 1v3h-3v-2h-5v2H7v-3a6 6 0 0 1-2-3zM15 9.5h.01" /></symbol>
      <symbol id="ic-users" viewBox="0 0 24 24"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6" /></symbol>
      <symbol id="ic-briefcase" viewBox="0 0 24 24"><path d="M4 8h16v11H4zM9 8V5h6v3M4 13h16" /></symbol>
      <symbol id="ic-shield" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></symbol>
      <symbol id="ic-calendar" viewBox="0 0 24 24"><path d="M4 6h16v15H4zM4 10h16M8 3v5M16 3v5" /></symbol>
      <symbol id="ic-tag" viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8zM7.5 8h.01" /></symbol>
      <symbol id="ic-sparkles" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></symbol>
      <symbol id="ic-sliders" viewBox="0 0 24 24"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4" /></symbol>
      <symbol id="ic-chevron-left" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></symbol>
      <symbol id="ic-chevron-right" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></symbol>
      <symbol id="ic-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" /></symbol>
      <symbol id="ic-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="ic-alert-triangle" viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17h.01" /></symbol>
      <symbol id="ic-arrow-down-left" viewBox="0 0 24 24"><path d="M17 7 7 17M16 17H7V8" /></symbol>
      <symbol id="ic-info" viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01" /></symbol>
      <symbol id="ic-mail" viewBox="0 0 24 24"><path d="M3 6h18v12H3zM3 7l9 6 9-6" /></symbol>
      <symbol id="ic-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /></symbol>
      <symbol id="ic-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4" /></symbol>
      <symbol id="ic-message" viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" /></symbol>
      <symbol id="ic-chevron-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></symbol>
      <symbol id="ic-transfer" viewBox="0 0 24 24"><path d="M4 8h14l-3-3M20 16H6l3 3" /></symbol>
      <symbol id="ic-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></symbol>
      <symbol id="ic-more-vertical" viewBox="0 0 24 24"><path d="M12 5h.01M12 12h.01M12 19h.01" strokeWidth={3} /></symbol>
      <symbol id="ic-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></symbol>
      <symbol id="ic-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></symbol>
      <symbol id="ic-arrow-up-right" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9" /></symbol>
      <symbol id="ic-chevron-up" viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6" /></symbol>
      <symbol id="ic-undo" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></symbol>
      <symbol id="ic-pencil" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" /></symbol>
      <symbol id="ic-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" /></symbol>
      <symbol id="ic-lock" viewBox="0 0 24 24"><path d="M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" /></symbol>
      <symbol id="ic-upload" viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></symbol>
      <symbol id="ic-trophy" viewBox="0 0 24 24"><path d="M6 3v6a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3M12 15v6" /></symbol>
      <symbol id="ic-bell" viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" /></symbol>
      <symbol id="ic-eye-off" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2" /></symbol>
      <symbol id="ic-food" viewBox="0 0 24 24"><path d="M7 2v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2M8 2v20M16 2c-1.5 0-2.5 1.5-2.5 4s1 4 2.5 5v9" /></symbol>
      <symbol id="ic-basket" viewBox="0 0 24 24"><path d="M4 9h16l-1.5 10a2 2 0 0 1-2 1.7H7.5a2 2 0 0 1-2-1.7L4 9Z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></symbol>
      <symbol id="ic-car" viewBox="0 0 24 24"><path d="M3 13l1.5-5A2 2 0 0 1 6.4 6.5h11.2A2 2 0 0 1 19.5 8l1.5 5" /><path d="M3 13h18v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4Z" /><circle cx="7.5" cy="17.5" r="1.5" /><circle cx="16.5" cy="17.5" r="1.5" /></symbol>
      <symbol id="ic-bag" viewBox="0 0 24 24"><path d="M6 8h12l1 12.5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20.5L6 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></symbol>
      <symbol id="ic-bolt" viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></symbol>
      <symbol id="ic-play" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M10 8.5 16 12l-6 3.5v-7Z" /></symbol>
      <symbol id="ic-health" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 7v10M7 12h10" /></symbol>
      <symbol id="ic-percent" viewBox="0 0 24 24"><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /><path d="M19 5 5 19" /></symbol>
      <symbol id="ic-wallet" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3" /><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-5a2.5 2.5 0 0 0 0 5h6" /></symbol>
      <symbol id="ic-question" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9.3 9.2a2.7 2.7 0 1 1 3.8 2.4c-1 .5-1.1 1.1-1.1 2.1M12 17h.01" /></symbol>
      <symbol id="ic-download" viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 20h16" /></symbol>
      <symbol id="ic-phone" viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></symbol>
      <symbol id="ic-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></symbol>
      <symbol id="ic-wifioff" viewBox="0 0 24 24"><path d="M2 8.5a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 15.5a6 6 0 0 1 7 0M12 19h.01M3 3l18 18" /></symbol>
      <symbol id="ic-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></symbol>
      <symbol id="ic-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></symbol>
      <symbol id="ic-google" viewBox="0 0 24 24"><path fill="#4285F4" stroke="none" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.2c-.3 1.4-1.1 2.6-2.4 3.4v2.8h3.9c2.3-2.1 3.3-5.2 3.3-8.3Z" /><path fill="#34A853" stroke="none" d="M12 24c3.2 0 5.9-1.1 7.8-2.9l-3.9-2.8c-1.1.7-2.4 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.6v2.9C3.5 21.3 7.4 24 12 24Z" /><path fill="#FBBC05" stroke="none" d="M5.6 14.7c-.2-.7-.4-1.4-.4-2.2s.1-1.5.4-2.2V7.4H1.6C.8 9 .3 10.9.3 12.9s.5 3.9 1.3 5.5l4-3.7Z" /><path fill="#EA4335" stroke="none" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.4 0 3.5 2.7 1.6 6.6l4 3.1c.9-2.7 3.4-4.9 6.4-4.9Z" /></symbol>
      </defs>
    </svg>
  );
}

/** The design id for a name, old or new. */
export function iconId(name: string): string {
  return ALIASES[name] ?? name;
}

export function Icon({
  name,
  className = "",
  size,
}: {
  name: string;
  className?: string;
  /** Pixel size; defaults to the CSS (1em, or whatever the context sets). */
  size?: number;
}) {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg className={`icon ${className}`.trim()} style={style} aria-hidden="true" focusable="false">
      <use href={`#${iconId(name)}`} />
    </svg>
  );
}

/** The SpendLog mark: a 28 px accent square with ledger lines and a cursor. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="8" fill="var(--ac)" />
      <path d="M7 10.5h14M7 17.5h8M18.5 14v7" stroke="var(--ac-tx)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
