import { useEffect, useState } from "react";
import { ThemeChoice, resolvedTheme, setStoredTheme, storedTheme } from "../lib/theme";
import { Icon } from "./Icon";

/**
 * Cycles light → dark → system. Three states rather than two, because
 * "follow the OS" is different from "pinned to light" once the user has
 * expressed a preference.
 */
const ORDER: ThemeChoice[] = ["light", "dark", "system"];

const LABEL: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);

  // Keep up with the OS while the choice is "system".
  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setChoice("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    setStoredTheme(next);
    setChoice(next);
  }

  const showing = resolvedTheme(choice);

  return (
    <button
      className="theme-toggle"
      onClick={cycle}
      title={`Theme: ${LABEL[choice]}${choice === "system" ? ` (${showing})` : ""}. Click to change.`}
    >
      <Icon name={showing === "dark" ? "ic-moon" : "ic-sun"} />
      <span>{LABEL[choice]}</span>
    </button>
  );
}
