import {
  EmailRenderEnvironment,
  TRACKING_ATTRIBUTES_CLASS_PREFIX,
  TRACKING_ATTRIBUTES_DELIMITER,
} from "./types.js";
import {
  AnonymousElementId,
  NamedElementId,
} from "./stubs/clickable-elements.js";
import { ReactNode, useContext } from "react";
import { EmailRenderContext } from "./builder/email-render-context.js";
import {
  generateSesTagsAttribute,
  trackingDataAttributes,
} from "./tracking-attributes.js";

export function useTrackingAttributes({
  blockId,
  linkId,
  href,
}: {
  blockId: string;
  linkId: NamedElementId | AnonymousElementId;
  href: string | undefined;
}) {
  const renderContext = useContext(EmailRenderContext);
  const environment = renderContext?.environment || EmailRenderEnvironment.REAL;

  const dataAttributes = trackingDataAttributes({
    blockId,
    elementId: linkId,
    environment,
    forceClickMapDataAttributes: renderContext?.forceClickMapDataAttributes,
  });

  if (!blockId || !href) {
    return dataAttributes;
  }

  const sesTagsAttribute = generateSesTagsAttribute({
    blockId,
    elementId: linkId,
  });

  return { ...sesTagsAttribute, ...dataAttributes };
}

export function useMjmlTrackingClassName(props: {
  blockId: string;
  linkId: NamedElementId | AnonymousElementId;
  href: string | undefined;
}): string {
  const trackingAttributes = useTrackingAttributes(props);
  const kvPairs = Object.entries(trackingAttributes)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join(TRACKING_ATTRIBUTES_DELIMITER);
  return `${TRACKING_ATTRIBUTES_CLASS_PREFIX}${kvPairs}`;
}

export function TrackableLink({
  blockId,
  linkId,
  href,
  children,
  ...props
}: {
  blockId: string;
  linkId: NamedElementId | AnonymousElementId;
  href: string | undefined;
  children?: ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const trackingAttributes = useTrackingAttributes({ blockId, linkId, href });
  return (
    <a href={href} {...trackingAttributes} {...props}>
      {children}
    </a>
  );
}
