import { SocialPlatform } from "../types.js";
import { SocialItem, SocialItemSource } from "../types.js";

export function resolveSocialUrl(
  item: SocialItem,
  useBrandKitSocials: boolean,
  brandKitSocials?: Partial<Record<string, string | null>> | null,
): string {
  if (useBrandKitSocials) {
    return brandKitSocials?.[item.platform] || "";
  }
  return item.url || "";
}

export function getFilteredSocialLinks(
  socialLinks: SocialItem[],
  useBrandKitSocials: boolean,
  brandKitSocials?: Partial<Record<string, string | null>> | null,
  includeHidden = true,
): SocialItem[] {
  if (useBrandKitSocials) {
    const allBrandKitSocials = Object.entries(brandKitSocials || {})
      .filter(([_, url]) => url?.trim() !== "")
      .map(([platform, url]) => {
        const metadata = socialLinks.find(
          (item) =>
            item.platform === platform &&
            item.source === SocialItemSource.BRAND_KIT,
        );
        return {
          id: `brandkit-${platform}`,
          platform: platform as SocialPlatform,
          url: url!,
          source: SocialItemSource.BRAND_KIT,
          hidden: metadata?.hidden || false,
        };
      });

    return includeHidden
      ? allBrandKitSocials
      : allBrandKitSocials.filter((item) => !item.hidden);
  }
  return socialLinks.filter(
    (item) => item.source !== SocialItemSource.BRAND_KIT,
  );
}
