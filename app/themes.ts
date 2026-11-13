// Add future preconfigured themes here and their styles under [data-theme="…"].
export const themes = [{ id: "default", name: "Default" }, { id: "jade", name: "Jade" }, { id: "foundry", name: "Light - alternate" }] as const;
export type ThemeId = (typeof themes)[number]["id"];
export const defaultTheme: ThemeId = "jade";
export function isThemeId(value: unknown): value is ThemeId {
  return themes.some(theme => theme.id === value);
}
