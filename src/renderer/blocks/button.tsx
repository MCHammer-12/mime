import { MjmlButton, MjmlColumn, MjmlSection } from "@faire/mjml-react";
import { escapeHtml } from "../stubs/html-util.js";
import { useRequiredContext } from "../stubs/react-util.js";
import {
  ButtonLinkType,
  EmailRenderEnvironment,
  Section,
  widthPixelsToPercentage,
} from "../types.js";
import {
  ClickableElement,
  ClickableElementIdentifiability,
  ClickableElementInteractionType,
  elementId,
} from "../stubs/clickable-elements.js";
import { Hydrated } from "../types.js";
import { memo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { useEmailFontFamily } from "../builder/inspectors/use-email-fonts.js";
import { TrackableLink, useMjmlTrackingClassName } from "../trackable-link.js";
import { Abbrv } from "../utils/compression.js";
import { sanitizedHref } from "./amp-utils/href-sanitization.js";

/**
 * An email button block (i.e., an entire section to itself)
 */
export const EmailButton = memo(function EmailButton(
  state: Hydrated<Section.Button>,
) {
  const sectionPadding = state.sectionPadding ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  return (
    <MjmlSection
      backgroundColor={state.sectionColor}
      paddingBottom={sectionPadding.bottom}
      paddingLeft={widthPixelsToPercentage(sectionPadding.left).formatted}
      paddingRight={widthPixelsToPercentage(sectionPadding.right).formatted}
      paddingTop={sectionPadding.top}
    >
      <MjmlColumn>
        <NestedEmailButton renderMode="mjml" {...state} />
      </MjmlColumn>
    </MjmlSection>
  );
});

type NestedEmailButtonProps = Omit<
  Hydrated<Section.Button>,
  | "type"
  | "hydrated"
  | "fontSize"
  | "linkType"
  | "sectionPadding"
  | "sectionColor"
> & {
  clickableElement?: ClickableElement | null;
  fontSize?: number | string;
  linkType?: ButtonLinkType;
  sectionPadding?: { top: number; right: number; bottom: number; left: number };
  sectionColor?: string;
};

export const NestedEmailButton = memo(function NestedEmailButton(
  props: NestedEmailButtonProps & { renderMode: "html" | "mjml" },
) {
  return props.renderMode === "html" ? (
    <NestedEmailButtonHtml {...props} />
  ) : (
    <NestedEmailButtonMjml {...props} />
  );
});

export const NestedEmailButtonHtml = memo(function EmailButton(
  state: NestedEmailButtonProps,
) {
  const { href, hideBlock, clickableElement, buttonPadding, fontFamily } =
    useEmailButton(state);

  if (hideBlock) {
    return null;
  }

  const linkProps = {
    href,
    style: {
      backgroundColor: state.fillColor,
      borderRadius: `${state.cornerRadius}px`,
      border: `${state.strokeWeight}px solid ${state.strokeColor}`,
      width: state.fullWidth ? "100%" : undefined,
      display: state.fullWidth ? "block" : "inline-block",
      lineHeight: "1",
      fontWeight: "bold",
      padding: `${buttonPadding.top}px ${buttonPadding.right}px ${buttonPadding.bottom}px ${buttonPadding.left}px`,
      color: state.textColor,
      fontFamily,
      fontSize:
        typeof state.fontSize === "number"
          ? `${state.fontSize}px`
          : state.fontSize,
      textAlign: "center",
      textDecoration: "none",
      boxSizing: "border-box",
      cursor: "pointer",
      "mso-padding-alt": "0",
    },
    type: state.buttonType,
  } as const;

  const alignmentStyle = { textAlign: state.alignment };

  const topPadding = Math.round(buttonPadding.top * 0.75);
  const buttonTextWithMso = `<!--[if mso]>
    <i style="mso-font-width:100%;mso-text-raise:${topPadding * 2}pt" hidden>&emsp;</i>
    <span style="mso-text-raise:50%;">
  <![endif]-->
  <span style="mso-text-raise: ${topPadding}pt;">
    ${escapeHtml(state.buttonText)}
  </span>
  <!--[if mso]>
    </span>
    <i style="mso-font-width:100%;" hidden>&emsp;&#8203;</i>
  <![endif]-->`;

  const sectionPadding = state.sectionPadding ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  return (
    <div
      style={{
        backgroundColor: state.sectionColor,
        paddingTop: sectionPadding.top,
        paddingBottom: sectionPadding.bottom,
        paddingLeft: sectionPadding.left,
        paddingRight: sectionPadding.right,
      }}
    >
      <div
        style={
          state.fullWidth
            ? { width: "100%", textAlign: "center" }
            : alignmentStyle
        }
      >
        <TrackableLink
          blockId={state.blockId}
          linkId={elementId(clickableElement)}
          {...linkProps}
          dangerouslySetInnerHTML={{ __html: buttonTextWithMso }}
        />
      </div>
    </div>
  );
});

const NestedEmailButtonMjml = memo(function EmailButton(
  state: NestedEmailButtonProps,
) {
  const { href, hideBlock, clickableElement, buttonPadding, fontFamily } =
    useEmailButton(state);

  const trackingAttributes = useMjmlTrackingClassName({
    blockId: state.blockId,
    linkId: elementId(clickableElement),
    href,
  });

  const classes = [trackingAttributes];

  if (state.fullWidth) {
    classes.push(Abbrv.FULL_WIDTH_BUTTON);
  }

  if (hideBlock) {
    return null;
  }

  if (!href) {
    classes.push("cursor-pointer");
  }

  const sectionPadding = state.sectionPadding ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  return (
    <MjmlButton
      align={state.fullWidth ? "center" : state.alignment}
      backgroundColor={state.fillColor}
      border={`${state.strokeWeight}px solid ${state.strokeColor}`}
      borderRadius={`${state.cornerRadius}px`}
      className={classes.join(" ")}
      color={state.textColor}
      containerBackgroundColor={state.sectionColor}
      fontFamily={fontFamily}
      fontSize={
        typeof state.fontSize === "number"
          ? `${state.fontSize}px`
          : state.fontSize
      }
      fontWeight="bold"
      href={href}
      innerPadding={`${buttonPadding.top}px ${buttonPadding.right}px ${buttonPadding.bottom}px ${buttonPadding.left}px`}
      paddingBottom={sectionPadding.bottom}
      paddingLeft={sectionPadding.left}
      paddingRight={sectionPadding.right}
      paddingTop={sectionPadding.top}
      textAlign="center"
      width={state.fullWidth ? "100%" : undefined}
    >
      {state.buttonText}
    </MjmlButton>
  );
});

function useEmailButton(state: NestedEmailButtonProps) {
  const renderContext = useRequiredContext(EmailRenderContext);
  const fontFamilyWithFallback = useEmailFontFamily(state.fontFamily);

  const linkType = state.linkType ?? ButtonLinkType.WEB_PAGE;
  const clickableElement = state.clickableElement ?? {
    idSuffix:
      linkType === ButtonLinkType.WEB_PAGE
        ? `btn-static-${state.buttonLink || "missing"}`
        : `btn-dynamic-${state.schemaFieldName || "missing"}`,
    interactionType: ClickableElementInteractionType.LINK,
    identifiability: ClickableElementIdentifiability.ANONYMOUS,
  };

  const dynamicButtonLink = state.schemaFieldName
    ? (renderContext.schemaInstance[state.schemaFieldName] as
        | string
        | undefined)
    : undefined;

  const originalButtonLink =
    linkType === ButtonLinkType.WEB_PAGE ? state.buttonLink : dynamicButtonLink;

  const buttonPadding = state.padding ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  const actualHref = sanitizedHref(
    originalButtonLink
      ? renderContext.utm.applyToUrl(originalButtonLink)
      : undefined,
  );

  const omitHref = renderContext.environment === EmailRenderEnvironment.BUILDER;
  const hideBlock = !actualHref && !omitHref;
  const maybeHref = omitHref ? undefined : actualHref;

  return {
    href: maybeHref,
    buttonPadding,
    clickableElement,
    fontFamily: fontFamilyWithFallback,
    hideBlock,
  };
}
