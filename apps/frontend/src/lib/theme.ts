export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "spendlog-theme";

/**
 * Applies the choice by stamping the root element. "system" removes the
 * stamp entirely so the `prefers-color-scheme` rules in index.css take
 * over — that's the difference between "follow the OS" and "pin light".
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function storedTheme(): ThemeChoice {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function setStoredTheme(choice: ThemeChoice): void {
  localStorage.setItem(STORAGE_KEY, choice);
  applyTheme(choice);
}

/** What the user is actually looking at right now. */
export function resolvedTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
