// Icon sprite from the approved mockup, mounted once at the app root.
// Icons are referenced with <Icon name="ic-food" />, which resolves through
// <use href="#ic-food"> against these symbols.
export function IconSprite() {
  return (
    <svg style={{ display: "none" }} aria-hidden="true">
    <defs>
    <symbol id="ic-food" viewBox="0 0 24 24"><path d="M7 2v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2M8 2v20M16 2c-1.5 0-2.5 1.5-2.5 4s1 4 2.5 5v9"/></symbol>
    <symbol id="ic-basket" viewBox="0 0 24 24"><path d="M4 9h16l-1.5 10a2 2 0 0 1-2 1.7H7.5a2 2 0 0 1-2-1.7L4 9Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/></symbol>
    <symbol id="ic-car" viewBox="0 0 24 24"><path d="M3 13l1.5-5A2 2 0 0 1 6.4 6.5h11.2A2 2 0 0 1 19.5 8l1.5 5"/><path d="M3 13h18v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4Z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></symbol>
    <symbol id="ic-bag" viewBox="0 0 24 24"><path d="M6 8h12l1 12.5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20.5L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></symbol>
    <symbol id="ic-bolt" viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></symbol>
    <symbol id="ic-play" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 8.5 16 12l-6 3.5v-7Z"/></symbol>
    <symbol id="ic-health" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 7v10M7 12h10"/></symbol>
    <symbol id="ic-home" viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/></symbol>
    <symbol id="ic-percent" viewBox="0 0 24 24"><circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M19 5 5 19"/></symbol>
    <symbol id="ic-trend" viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></symbol>
    <symbol id="ic-wallet" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-5a2.5 2.5 0 0 0 0 5h6"/></symbol>
    <symbol id="ic-dots" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></symbol>
    <symbol id="ic-question" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-dasharray="2.8 3"/><path d="M9.3 9.2a2.7 2.7 0 1 1 3.8 2.4c-1 .5-1.1 1.1-1.1 2.1"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/></symbol>
    <symbol id="ic-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></symbol>
    <symbol id="ic-filter" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="var(--surface)"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="var(--surface)"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2" fill="var(--surface)"/></symbol>
    <symbol id="ic-chevron-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
    <symbol id="ic-chevron-left" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></symbol>
    <symbol id="ic-chevron-right" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
    <symbol id="ic-sync" viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"/><path d="M4 20v-4h4"/></symbol>
    <symbol id="ic-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></symbol>
    <symbol id="ic-message" viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4V5Z"/></symbol>
    <symbol id="ic-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.4" r="0.9" fill="currentColor" stroke="none"/></symbol>
    <symbol id="ic-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
    <symbol id="ic-check" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></symbol>
    <symbol id="ic-alert" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/></symbol>
    <symbol id="ic-download" viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></symbol>
    <symbol id="ic-phone" viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></symbol>
    <symbol id="ic-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
    <symbol id="ic-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="ic-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></symbol>
    <symbol id="ic-bank" viewBox="0 0 24 24"><path d="M3 10l9-6 9 6"/><path d="M5 10v9M10 10v9M14 10v9M19 10v9"/><path d="M3 21h18"/></symbol>
    <symbol id="ic-updown" viewBox="0 0 24 24"><path d="M7 15l5 5 5-5"/><path d="M7 9l5-5 5 5"/></symbol>
    <symbol id="ic-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
    <symbol id="ic-wifioff" viewBox="0 0 24 24"><path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12a11 11 0 0 1 14 0"/><path d="M8.5 15.5a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="0.9" fill="currentColor" stroke="none"/><path d="M3 3l18 18"/></symbol>
    <symbol id="ic-receipt" viewBox="0 0 24 24"><path d="M6 2h12v19l-2-1.3L14 21l-2-1.3L10 21l-2-1.3L6 21V2Z"/><path d="M9 7h6M9 11h6M9 15h4"/></symbol>
    <symbol id="ic-pencil" viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1Z"/></symbol>
    <symbol id="ic-google" viewBox="0 0 24 24"><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.2c-.3 1.4-1.1 2.6-2.4 3.4v2.8h3.9c2.3-2.1 3.3-5.2 3.3-8.3Z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.8-2.9l-3.9-2.8c-1.1.7-2.4 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.6v2.9C3.5 21.3 7.4 24 12 24Z"/><path fill="#FBBC05" d="M5.6 14.7c-.2-.7-.4-1.4-.4-2.2s.1-1.5.4-2.2V7.4H1.6C.8 9 .3 10.9.3 12.9s.5 3.9 1.3 5.5l4-3.7Z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.4 0 3.5 2.7 1.6 6.6l4 3.1c.9-2.7 3.4-4.9 6.4-4.9Z"/></symbol>
    <symbol id="ic-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
    <symbol id="ic-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></symbol>
    </defs>
    </svg>
  );
}

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg className={`icon ${className}`.trim()} aria-hidden="true">
      <use href={`#${name}`} />
    </svg>
  );
}
