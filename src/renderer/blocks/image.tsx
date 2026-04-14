import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import { useRequiredContext } from "../stubs/react-util.js";
import {
  EmailBlockType,
  EmailFormat,
  EmailRenderEnvironment,
  Section,
  widthPixelsToPercentage,
  EMAIL_MAX_WIDTH_PX,
} from "../types.js";
import {
  NamedClickableElement,
  namedClickableElements,
  namedElementId,
} from "../stubs/clickable-elements.js";
import { Hydrated, ImageDimensions } from "../types.js";
import { memo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { TrackableLink } from "../trackable-link.js";
import { trackingDataAttributes } from "../tracking-attributes.js";
import { sanitizedHref } from "./amp-utils/href-sanitization.js";

const ImageHelper = ({
  props,
  imageDimensions,
  sectionPadding,
}: {
  props: Hydrated<Section.Image>;
  imageDimensions: ImageDimensions | null;
  sectionPadding: { left: number; right: number };
}) => {
  const renderContext = useRequiredContext(EmailRenderContext);
  if (
    renderContext.environment === EmailRenderEnvironment.BUILDER &&
    !props.imageUrl
  ) {
    return (
      <div
        style={{
          width: "100%",
          aspectRatio: 16 / 9,
          backgroundColor: "#E5E5E5",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        Image placeholder
      </div>
    );
  }

  // Use the croppedImageUrl if available, otherwise fall back to original imageUrl
  const url =
    props.croppedImageUrl ||
    props.imageUrl ||
    "https://placehold.co/600x300?text=Image+Placeholder";

  if (
    renderContext.environment === EmailRenderEnvironment.BUILDER &&
    props.cropConfigV2
  ) {
    const { xRatio, yRatio, widthRatio, heightRatio, circularCrop, baseImage } =
      props.cropConfigV2;

    const cropWidthPx = widthRatio * baseImage.width;
    const cropHeightPx = heightRatio * baseImage.height;
    const cropAspectRatio = cropWidthPx / cropHeightPx;

    const scaleX = 1 / widthRatio;
    const scaleY = 1 / heightRatio;

    const translateXPercent = -xRatio * 100;
    const translateYPercent = -yRatio * 100;

    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          aspectRatio: circularCrop ? "1" : cropAspectRatio,
          overflow: "hidden",
          position: "relative",
          borderRadius: circularCrop ? "50%" : "0",
        }}
      >
        <img
          alt={
            renderContext.environment === EmailRenderEnvironment.BUILDER
              ? "Image"
              : props.altText
          }
          src={url}
          style={{
            width: `${scaleX * 100}%`,
            height: `${scaleY * 100}%`,
            objectFit: "cover",
            transform: `translate(${translateXPercent}%, ${translateYPercent}%)`,
            position: "absolute",
            top: 0,
            left: 0,
          }}
          {...trackingDataAttributes({
            blockId: props.blockId,
            environment: renderContext.environment,
            elementId: namedElementId(
              namedClickableElements[EmailBlockType.IMAGE].CLICKTHROUGH_LINK,
            ),
          })}
        />
      </div>
    );
  } else if (
    renderContext.environment === EmailRenderEnvironment.BUILDER &&
    props.cropConfig
  ) {
    const {
      crop,
      imageHeight,
      imageWidth,
      circularCrop,
      cropWidthRatio,
      cropHeightRatio,
    } = props.cropConfig;

    const containerAspectRatio = crop.width / crop.height;

    const adjustedCropX = crop.x / cropWidthRatio;
    const adjustedCropY = crop.y / cropHeightRatio;
    const adjustedCropWidth = crop.width / cropWidthRatio;
    const adjustedCropHeight = crop.height / cropHeightRatio;

    const scaleX = imageWidth / adjustedCropWidth;
    const scaleY = imageHeight / adjustedCropHeight;

    const translateXPercent = -(adjustedCropX / imageWidth) * 100;
    const translateYPercent = -(adjustedCropY / imageHeight) * 100;

    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          aspectRatio: circularCrop ? "1" : containerAspectRatio,
          overflow: "hidden",
          position: "relative",
          borderRadius: circularCrop ? "50%" : "0",
        }}
      >
        <img
          alt={
            renderContext.environment === EmailRenderEnvironment.BUILDER
              ? "Image"
              : props.altText
          }
          src={url}
          style={{
            width: `${scaleX * 100}%`,
            height: `${scaleY * 100}%`,
            objectFit: "cover",
            transform: `translate(${translateXPercent}%, ${translateYPercent}%)`,
            position: "absolute",
            top: 0,
            left: 0,
          }}
          {...trackingDataAttributes({
            blockId: props.blockId,
            environment: renderContext.environment,
            elementId: namedElementId(
              namedClickableElements[EmailBlockType.IMAGE].CLICKTHROUGH_LINK,
            ),
          })}
        />
      </div>
    );
  } else {
    return renderContext.format === EmailFormat.AMP ? (
      <amp-img
        alt={props.altText}
        height={imageDimensions?.height ?? 1}
        layout="responsive"
        src={url}
        style={{ margin: "0 auto" }}
        width={imageDimensions?.width ?? 1}
      />
    ) : (
      <img
        alt={
          renderContext.environment === EmailRenderEnvironment.BUILDER
            ? "Image"
            : props.altText
        }
        loading="lazy"
        src={url}
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          margin: "0 auto",
        }}
        width={
          props.containerWidth?.toString() ??
          Math.floor(
            EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right,
          ).toString()
        }
        {...trackingDataAttributes({
          blockId: props.blockId,
          environment: renderContext.environment,
          elementId: namedElementId(
            namedClickableElements[EmailBlockType.IMAGE].CLICKTHROUGH_LINK,
          ),
        })}
      />
    );
  }
};

const WithLink = ({
  image,
  clickthroughUrl,
  blockId,
  clickableElement,
}: {
  image: React.ReactNode;
  clickthroughUrl?: string;
  blockId: string;
  clickableElement: NamedClickableElement;
}) => {
  const renderContext = useRequiredContext(EmailRenderContext);
  const finalUrl = clickthroughUrl || renderContext.team.storeUrl;

  if (
    !finalUrl ||
    renderContext?.environment === EmailRenderEnvironment.BUILDER
  ) {
    return image;
  }

  const urlWithUtm = renderContext.utm.applyToUrl(finalUrl);
  return (
    <TrackableLink
      blockId={blockId}
      href={sanitizedHref(urlWithUtm)}
      linkId={namedElementId(clickableElement)}
      rel="noreferrer"
      target="_blank"
    >
      {image}
    </TrackableLink>
  );
};

export const EmailImage = memo(function EmailImage(
  props: Hydrated<Section.Image>,
) {
  const padding = props.sectionPadding;
  const image = (
    <ImageHelper
      imageDimensions={props.imageDimensions}
      props={props}
      sectionPadding={padding}
    />
  );

  const innerPadding = props.padding || { top: 0, right: 0, bottom: 0, left: 0 };

  const Section = ({ children }: { children: React.ReactNode }) => (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={padding.bottom}
      paddingLeft={widthPixelsToPercentage(padding.left).formatted}
      paddingRight={widthPixelsToPercentage(padding.right).formatted}
      paddingTop={padding.top}
    >
      <MjmlColumn>
        <MjmlText
          paddingBottom={innerPadding.bottom}
          paddingLeft={innerPadding.left}
          paddingRight={innerPadding.right}
          paddingTop={innerPadding.top}
        >
          {children}
        </MjmlText>
      </MjmlColumn>
    </MjmlSection>
  );

  return (
    <Section>
      <WithLink
        blockId={props.blockId}
        clickableElement={
          namedClickableElements[EmailBlockType.IMAGE].CLICKTHROUGH_LINK
        }
        clickthroughUrl={props.clickthroughUrl}
        image={image}
      />
    </Section>
  );
});

export const NestedEmailImage = memo(function NestedEmailImage(
  props: Hydrated<Section.Image>,
) {
  const safePadding = props.sectionPadding || {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  const image = (
    <ImageHelper
      imageDimensions={props.imageDimensions}
      props={props}
      sectionPadding={safePadding}
    />
  );

  const innerPad = props.padding || { top: 0, right: 0, bottom: 0, left: 0 };

  return (
    <div
      style={{
        backgroundColor: props.sectionColor,
        paddingTop: safePadding.top,
        paddingBottom: safePadding.bottom,
        paddingLeft: widthPixelsToPercentage(safePadding.left).formatted,
        paddingRight: widthPixelsToPercentage(safePadding.right).formatted,
      }}
    >
      <div
        style={{
          paddingTop: innerPad.top,
          paddingBottom: innerPad.bottom,
          paddingLeft: innerPad.left,
          paddingRight: innerPad.right,
        }}
      >
        <WithLink
          blockId={props.blockId}
          clickableElement={
            namedClickableElements[EmailBlockType.IMAGE].CLICKTHROUGH_LINK
          }
          clickthroughUrl={props.clickthroughUrl}
          image={image}
        />
      </div>
    </div>
  );
});
