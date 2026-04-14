import { useRequiredContext } from "../../stubs/react-util.js";
import { EmailRenderContext } from "../email-render-context.js";

const WEB_SAFE_FALLBACKS: Record<string, string> = {
  Arial: "Arial, Helvetica, sans-serif",
  "Courier New": "'Courier New', Courier, monospace",
  Georgia: "Georgia, 'Times New Roman', Times, serif",
  "Lucida Sans Unicode": "'Lucida Sans Unicode', 'Lucida Grande', sans-serif",
  Tahoma: "Tahoma, Geneva, sans-serif",
  "Times New Roman": "'Times New Roman', Times, serif",
  "Trebuchet MS": "'Trebuchet MS', Helvetica, sans-serif",
  Verdana: "Verdana, Geneva, sans-serif",
};

function getFontFamilyWithFallback(
  fontFamily: string,
  customFontFamilies?: Array<{ fontFamily: string; fallbackFontFamily?: string }> | null,
): string {
  if (WEB_SAFE_FALLBACKS[fontFamily]) {
    return WEB_SAFE_FALLBACKS[fontFamily];
  }
  const customFont = customFontFamilies?.find((f) => f.fontFamily === fontFamily);
  if (customFont) {
    const fallback = customFont.fallbackFontFamily || "Arial, Helvetica, sans-serif";
    return `'${fontFamily}', ${fallback}`;
  }
  return fontFamily;
}

export function useEmailFontFamily(fontFamily: string): string {
  const emailRenderContext = useRequiredContext(EmailRenderContext);
  const customFontFamilies =
    emailRenderContext.team?.settings?.brandKit?.customFontFamilies;
  return getFontFamilyWithFallback(fontFamily, customFontFamilies);
}
