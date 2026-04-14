import {
  MjmlColumn,
  MjmlSection,
  MjmlSocial,
  MjmlSocialElement,
} from "@faire/mjml-react";
import { useRequiredContext } from "../stubs/react-util.js";
import { SocialPlatform } from "../stubs/brand-kit.js";
import {
  EmailRenderEnvironment,
  Section,
  SocialIconColor,
  SocialItem,
  widthPixelsToPercentage,
} from "../types.js";
import {
  anonymousElementId,
  ClickableElementIdentifiability,
  ClickableElementInteractionType,
} from "../stubs/clickable-elements.js";
import { Hydrated } from "../types.js";
import { memo, useMemo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { SocialsIconSource } from "../socials-image-source.js";
import { useMjmlTrackingClassName } from "../trackable-link.js";
import {
  getFilteredSocialLinks,
  resolveSocialUrl,
} from "../utils/social-links-utils.js";
import { sanitizedHref } from "./amp-utils/href-sanitization.js";

export const EmailSocials = memo(function EmailSocials(
  props: Hydrated<Section.Socials>,
) {
  const renderContext = useRequiredContext(EmailRenderContext);
  const padding = props.sectionPadding;

  const visibleSocialLinks = useMemo(
    () =>
      getFilteredSocialLinks(
        props.socialLinks,
        props.useBrandKitSocials ?? false,
        renderContext.team?.settings?.brandKit?.socialLinks,
        false,
      ),
    [
      props.socialLinks,
      props.useBrandKitSocials,
      renderContext.team?.settings?.brandKit?.socialLinks,
    ],
  );

  const resolveUrl = (item: SocialItem) =>
    resolveSocialUrl(
      item,
      props.useBrandKitSocials ?? false,
      renderContext.team?.settings?.brandKit?.socialLinks,
    );

  return (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={Math.max(padding.bottom - props.iconPadding, 0)}
      paddingLeft={widthPixelsToPercentage(padding.left).formatted}
      paddingRight={widthPixelsToPercentage(padding.right).formatted}
      paddingTop={Math.max(padding.top - props.iconPadding, 0)}
    >
      <MjmlColumn>
        <MjmlSocial
          align={props.alignment}
          iconSize="24px"
          innerPadding={`${props.iconPadding}px`}
          mode="horizontal"
        >
          {visibleSocialLinks.map((item, index) => {
            const resolvedUrl = resolveUrl(item);
            if (
              !resolvedUrl &&
              renderContext.environment !== EmailRenderEnvironment.BUILDER
            ) {
              return null;
            }

            return (
              <SocialsIconEmail
                blockId={props.blockId}
                color={props.iconColor}
                key={index}
                platform={item.platform}
                resolvedUrl={resolvedUrl}
              />
            );
          })}
        </MjmlSocial>
      </MjmlColumn>
    </MjmlSection>
  );
});

interface SocialsIconProps {
  color: SocialIconColor;
  platform: SocialPlatform;
}

export const SocialsIconEmail = memo(function SocialsIconEmail({
  blockId,
  platform,
  resolvedUrl,
  color,
}: SocialsIconProps & { blockId: string; resolvedUrl: string }) {
  const socialLinkId = anonymousElementId({
    idSuffix: `social-${platform}`,
    identifiability: ClickableElementIdentifiability.ANONYMOUS,
    interactionType: ClickableElementInteractionType.LINK,
  });

  const trackingClassName = useMjmlTrackingClassName({
    blockId,
    linkId: socialLinkId,
    href: resolvedUrl,
  });

  const iconSrc = SocialsIconSource[color][platform];

  return (
    <MjmlSocialElement
      alt={platform}
      cssClass={trackingClassName}
      href={sanitizedHref(resolvedUrl)}
      rel="noreferrer"
      src={iconSrc}
      target="_blank"
    />
  );
});
