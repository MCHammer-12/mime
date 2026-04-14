import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import { useRequiredContext } from "../stubs/react-util.js";
import {
  Section,
  widthPixelsToPercentage,
} from "../types.js";
import { Hydrated } from "../types.js";
import htmlReactParser from "html-react-parser";
import { memo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { useEmailFontFamily } from "../builder/inspectors/use-email-fonts.js";
import { allHrefsSanitized } from "./amp-utils/href-sanitization.js";
import { MaybeMjmlGroup } from "./products/static-cart.js";
import { createTrackableLinkParserOptions, processQuillHtml } from "./text.js";

export const CUSTOM_SPACING_ROW_GAP = 8;

export const EmailMenu = memo(function EmailMenu(
  props: Hydrated<Section.Menu>,
) {
  const fontFamilyWithFallback = useEmailFontFamily(props.fontFamily);
  const renderContext = useRequiredContext(EmailRenderContext);
  const padding = props.sectionPadding;
  const parserOptions = createTrackableLinkParserOptions({
    blockId: props.blockId,
    renderContext,
  });

  const leftPaddingConverted = widthPixelsToPercentage(padding.left);
  const rightPaddingConverted = widthPixelsToPercentage(padding.right);

  const sectionProps = {
    backgroundColor: props.sectionColor,
    paddingBottom: padding.bottom,
    paddingLeft: leftPaddingConverted.formatted,
    paddingRight: rightPaddingConverted.formatted,
    paddingTop: padding.top,
  };

  if (props.useCustomSpacing) {
    const horizontalPadding = (props.itemSpacing ?? 0) / 2;

    const menuItemElements = props.menuItems.map((item, index) => {
      const quillHtml = processQuillHtml(
        allHrefsSanitized(item.label),
        props.linkColor,
        true,
      );

      return (
        <span
          key={index}
          style={{
            display: "inline-block",
            paddingLeft: `${horizontalPadding}px`,
            paddingRight: `${horizontalPadding}px`,
            paddingBottom: `${CUSTOM_SPACING_ROW_GAP}px`,
            fontSize: `${props.fontSize}px`,
          }}
        >
          {htmlReactParser(quillHtml, parserOptions)}
        </span>
      );
    });

    return (
      <MjmlSection
        {...sectionProps}
        paddingBottom={Math.max(0, padding.bottom - CUSTOM_SPACING_ROW_GAP)}
        paddingLeft={
          widthPixelsToPercentage(Math.max(padding.left - horizontalPadding, 0))
            .formatted
        }
        paddingRight={
          widthPixelsToPercentage(
            Math.max(padding.right - horizontalPadding, 0),
          ).formatted
        }
        paddingTop={padding.top}
      >
        <MjmlColumn>
          <MjmlText
            align="center"
            color={props.textColor}
            fontFamily={fontFamilyWithFallback}
            fontSize={0}
          >
            {menuItemElements}
          </MjmlText>
        </MjmlColumn>
      </MjmlSection>
    );
  }

  const columnWidthPercent =
    Math.round((100 / props.menuItems.length) * 10_000) / 10_000;

  const shouldEnableResponsive = props.stackOnMobile;

  const noStackClass = !props.stackOnMobile ? "menu-no-stack" : undefined;

  return (
    <MjmlSection {...sectionProps} cssClass={noStackClass}>
      <MaybeMjmlGroup responsive={shouldEnableResponsive}>
        {props.menuItems.map((item, index) => {
          const quillHtml = processQuillHtml(
            allHrefsSanitized(item.label),
            props.linkColor,
            true,
          );

          return (
            <MjmlColumn key={index} width={`${columnWidthPercent}%`}>
              <MjmlText
                color={props.textColor}
                fontFamily={fontFamilyWithFallback}
                fontSize={props.fontSize}
              >
                {htmlReactParser(quillHtml, parserOptions)}
              </MjmlText>
            </MjmlColumn>
          );
        })}
      </MaybeMjmlGroup>
    </MjmlSection>
  );
});
