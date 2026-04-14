import { MjmlColumn, MjmlRaw, MjmlSection, MjmlText } from "@faire/mjml-react";
import { useRequiredContext } from "../stubs/react-util.js";
import {
  EmailRenderEnvironment,
  Section,
} from "../types.js";
import { Hydrated } from "../types.js";
import { memo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { useEmailFontFamily } from "../builder/inspectors/use-email-fonts.js";
import { DiscountOfferEmailMarkup } from "./gmail-markup/discount-offer-markup.js";

export const EmailDiscount = memo(function EmailDiscount(
  props: Hydrated<Section.Discount>,
) {
  const padding = props.sectionPadding;

  return (
    <>
      <MjmlSection
        backgroundColor={props.sectionColor}
        paddingBottom={padding.bottom}
        paddingLeft={padding.left}
        paddingRight={padding.right}
        paddingTop={padding.top}
      >
        <MjmlColumn backgroundColor={props.blockBackgroundColor}>
          <MjmlText>
            <InlineEmailDiscount {...props} />
          </MjmlText>
        </MjmlColumn>
      </MjmlSection>
      {props.discountCode && (
        <MjmlRaw>
          <NestedEmailDiscountOffer discountCode={props.discountCode} />
        </MjmlRaw>
      )}
    </>
  );
});

export const NestedEmailDiscount = memo(function NestedEmailDiscount(
  props: Hydrated<Section.Discount>,
) {
  const padding = props.sectionPadding;
  return (
    <div
      style={{
        backgroundColor: props.sectionColor,
        paddingBottom: padding.bottom,
        paddingLeft: padding.left,
        paddingRight: padding.right,
        paddingTop: padding.top,
      }}
    >
      <div style={{ backgroundColor: props.blockBackgroundColor }}>
        <InlineEmailDiscount {...props} />
      </div>
    </div>
  );
});

const InlineEmailDiscount = memo(function EmailDiscount(
  props: Hydrated<Section.Discount>,
) {
  const renderContext = useRequiredContext(EmailRenderContext);
  const fontFamilyWithFallback = useEmailFontFamily(props.fontFamily);

  return (
    <div
      style={{
        textAlign: props.alignment,
        color: props.textColor,
        fontFamily: fontFamilyWithFallback,
        fontSize: props.fontSize,
        fontWeight: props.fontWeight,
        padding: "8px",
      }}
    >
      {renderContext.environment !== EmailRenderEnvironment.BUILDER
        ? (props.discountCode ?? "XXXXXX")
        : "XXXXXX"}
    </div>
  );
});

const NestedEmailDiscountOffer = memo(function NestedEmailDiscountOffer(props: {
  discountCode?: string;
}) {
  return (
    props.discountCode && (
      <DiscountOfferEmailMarkup
        discountCode={props.discountCode}
      />
    )
  );
});
