import { useRequiredContext } from "./stubs/react-util.js";
import {
  EmailRenderEnvironment,
  SesClickTags,
} from "./types.js";
import {
  AnonymousElementId,
  ClickableElement,
  NamedElementId,
  elementId,
} from "./stubs/clickable-elements.js";
import { EmailRenderContext } from "./builder/email-render-context.js";

export function generateSesTagsAttribute({
  blockId,
  elementId,
}: {
  blockId: string;
  elementId?: NamedElementId | AnonymousElementId;
}): { "ses:tags"?: string } {
  if (!blockId || !elementId) {
    return {};
  }

  return {
    "ses:tags": `${SesClickTags.BLOCK_ID}:${blockId};${SesClickTags.ELEMENT_ID}:${elementId}`,
  };
}

interface BaseTrackingParams {
  blockId: string;
  environment: EmailRenderEnvironment;
  forceClickMapDataAttributes?: boolean;
}

type ElementTrackingParams = BaseTrackingParams & { element: ClickableElement };
type ElementIdTrackingParams = BaseTrackingParams & {
  elementId: NamedElementId | AnonymousElementId;
};
type TrackingDataParams = ElementTrackingParams | ElementIdTrackingParams;

export function trackingDataAttributes(
  params: TrackingDataParams,
): Record<string, string> {
  const { blockId, environment, forceClickMapDataAttributes } = params;

  if (
    (environment !== EmailRenderEnvironment.BUILDER &&
      !forceClickMapDataAttributes) ||
    !blockId
  ) {
    return {};
  }

  const finalElementId =
    "element" in params ? elementId(params.element) : params.elementId;

  if (!finalElementId) {
    return {};
  }

  return { "data-block-id": blockId, "data-element-id": finalElementId };
}

export function useTrackingDataAttributes({
  blockId,
  element,
  elementId: elemId,
}: { blockId: string } & (
  | { element: ClickableElement; elementId?: never }
  | { element?: never; elementId: NamedElementId | AnonymousElementId }
)): Record<string, string> {
  const renderContext = useRequiredContext(EmailRenderContext);

  return trackingDataAttributes({
    blockId,
    ...(element ? { element } : { elementId: elemId! }),
    environment: renderContext.environment,
    forceClickMapDataAttributes: renderContext.forceClickMapDataAttributes,
  } as TrackingDataParams);
}
