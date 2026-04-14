import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import { useRequiredContext } from "../stubs/react-util.js";
import {
  EmailBlockType,
  EmailFormat,
  EmailHeaderType,
  EmailRenderEnvironment,
  Section,
} from "../types.js";
import {
  namedClickableElements,
  namedElementId,
} from "../stubs/clickable-elements.js";
import { Hydrated } from "../types.js";
import { memo, useEffect, useState } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { useEmailFontFamily } from "../builder/inspectors/use-email-fonts.js";
import { GlobalEmailClass } from "../email-wrapper.js";
import { TrackableLink } from "../trackable-link.js";
import { sanitizedHref } from "./amp-utils/href-sanitization.js";

export const EmailHeader = memo(function EmailHeader(
  props: Hydrated<Section.Header>,
) {
  const renderContext = useRequiredContext(EmailRenderContext);
  const fontFamilyWithFallback = useEmailFontFamily(props.fontFamily);
  const height =
    props.headerType === EmailHeaderType.LOGO
      ? props.logoHeight
      : props.imageHeight || 49;
  const marginLeft = props.layout !== "left" ? "auto" : "0";
  const marginRight = props.layout !== "right" ? "auto" : "0";
  const isBuilder =
    renderContext.environment === EmailRenderEnvironment.BUILDER;

  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (renderContext.format !== EmailFormat.AMP) return;
    setRefreshKey(refreshKey + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);

  const imageUrl = props.processedImageUrl ?? props.imageUrl ?? undefined;

  if (!imageUrl && props.headerType !== EmailHeaderType.TEXT && !isBuilder) {
    return null;
  }

  const imageContent =
    renderContext.format === EmailFormat.AMP ? (
      <div
        className={props.layout}
        style={{
          height: `${height}px`,
          position: "relative",
          marginLeft,
          marginRight,
        }}
      >
        <amp-img
          alt={props.altText}
          class={GlobalEmailClass.OBJECT_FIT_CONTAIN}
          height={height}
          layout="fill"
          src={imageUrl}
        />
      </div>
    ) : (
      <img
        alt={props.altText}
        height={height}
        src={imageUrl}
        style={{
          height: `${height}px`,
          width: "auto",
          maxWidth: "100%",
          marginLeft,
          marginRight,
        }}
      />
    );

  const padding = props.sectionPadding;

  return (
    <MjmlSection
      backgroundColor={props.sectionColor || "#ffffff"}
      key={refreshKey}
      paddingBottom={padding.bottom}
      paddingLeft={padding.left}
      paddingRight={padding.right}
      paddingTop={padding.top}
      textAlign={props.layout || "center"}
    >
      <MjmlColumn>
        <MjmlText
          align={props.layout || "center"}
          fontSize={0} // without this, weird tiny space below image
        >
          {[EmailHeaderType.LOGO, EmailHeaderType.IMAGE].includes(
            props.headerType,
          ) &&
            (!isBuilder ? (
              <TrackableLink
                blockId={props.blockId}
                href={sanitizedHref(
                  props.clickthroughUrl
                    ? renderContext.utm.applyToUrl(props.clickthroughUrl)
                    : renderContext.utm.applyToUrl(renderContext.team.storeUrl),
                )}
                linkId={namedElementId(
                  namedClickableElements[EmailBlockType.HEADER].HEADER_LINK,
                )}
              >
                {imageContent}
              </TrackableLink>
            ) : (
              imageContent
            ))}
          {props.headerType === EmailHeaderType.TEXT && (
            <p
              style={{
                fontSize: `${props.fontSize}px`,
                fontFamily: fontFamilyWithFallback,
                color: props.textColor,
              }}
            >
              {props.text}
            </p>
          )}
        </MjmlText>
      </MjmlColumn>
    </MjmlSection>
  );
});
