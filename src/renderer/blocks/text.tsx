import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import { useRequiredContext } from "../stubs/react-util.js";
import {
  EmailFormat,
  Section,
  widthPixelsToPercentage,
} from "../types.js";
import { AnonymousElementId } from "../stubs/clickable-elements.js";
import { Hydrated } from "../types.js";
import htmlReactParser, {
  Element,
  HTMLReactParserOptions,
} from "html-react-parser";
import { memo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { useEmailFontFamily } from "../builder/inspectors/use-email-fonts.js";
import {
  generateSesTagsAttribute,
  trackingDataAttributes,
} from "../tracking-attributes.js";
import { allHrefsSanitized } from "./amp-utils/href-sanitization.js";

/**
 * Creates parser options that transform <a> tags with data-link-id attributes
 * into trackable links with ses:tags attributes and data attributes for builder
 */
export const createTrackableLinkParserOptions = ({
  blockId,
  renderContext,
}: {
  blockId: string;
  renderContext: EmailRenderContext;
}): HTMLReactParserOptions => ({
  replace: (domNode: any) => {
    if (domNode instanceof Element && domNode.name === "a") {
      // If this is an anchor tag with a data-link-id, add ses:tags
      if (domNode.attribs["data-link-id"]) {
        const linkId = domNode.attribs["data-link-id"];
        const isHttpHref = domNode.attribs.href?.startsWith("http"); // avoid mailto, tel, etc.
        // linkId already contains the "anonymous_" prefix from QuillLink
        const elementId = linkId as AnonymousElementId;

        if (isHttpHref) {
          domNode.attribs.href = renderContext.utm
            // @ts-expect-error TODO: noUncheckedIndexedAccess FIXME
            .applyToUrl(domNode.attribs.href)
            .toString();

          const sesTagsAttr = generateSesTagsAttribute({ blockId, elementId });
          if (sesTagsAttr["ses:tags"]) {
            domNode.attribs["ses:tags"] = sesTagsAttr["ses:tags"];
          }

          // Add data attributes for builder environment
          const dataAttrs = trackingDataAttributes({
            blockId,
            elementId,
            environment: renderContext.environment,
          });

          // Apply data attributes to the DOM node
          for (const [key, value] of Object.entries(dataAttrs)) {
            domNode.attribs[key] = value;
          }
        }

        // save email bytes
        delete domNode.attribs["data-link-id"];
      }
      // Return undefined to keep using the default parser behavior
      return undefined;
    }
  },
});

export const createParserOptions = ({
  blockId,
  format,
  renderContext,
}: {
  blockId: string;
  format?: EmailFormat;
  renderContext: EmailRenderContext;
}): HTMLReactParserOptions => ({
  replace: (domNode: any) => {
    // First try the link parser
    const linkParserOptions = createTrackableLinkParserOptions({
      blockId,
      renderContext,
    });
    const linkResult = linkParserOptions.replace?.(domNode);
    if (linkResult !== undefined) {
      return linkResult;
    }

    // If the link parser didn't handle it, try the image parser
    const imageParserOptions = createAmpImageParserOptions(format);
    return imageParserOptions.replace?.(domNode);
  },
});

/**
 * Creates parser options that transform <img> tags into amp-img tags
 */
export const createAmpImageParserOptions = (
  format?: EmailFormat,
): HTMLReactParserOptions => ({
  replace: (domNode: any) => {
    if (
      domNode instanceof Element &&
      domNode.name === "img" &&
      format === EmailFormat.AMP
    ) {
      return (
        <amp-img
          alt={domNode.attribs.alt}
          height={domNode.attribs.height || "200"}
          layout="fixed"
          src={domNode.attribs.src}
          style={{ width: "200px", height: "200px" }}
          width={domNode.attribs.width || "200"}
        />
      );
    }
    return undefined;
  },
});

export const processQuillHtml = (
  html: string,
  linkColor: string,
  skipUnderlineLinks = false,
) => {
  return html
    .replaceAll("\t", "&nbsp;&nbsp;&nbsp;&nbsp;")
    .replace(/<a([^>]*)>/g, (match: string, attributes: string) => {
      const styleMatch = attributes.match(/style="([^"]*)"/i);
      const textDecoration = skipUnderlineLinks
        ? "text-decoration: none; "
        : "";

      if (styleMatch) {
        // Style attribute exists
        const styleContent = styleMatch[1];
        // @ts-expect-error TODO: noUncheckedIndexedAccess FIXME
        if (/(?:^|;|\s)color\s*:/i.test(styleContent)) {
          if (
            skipUnderlineLinks &&
            // @ts-expect-error TODO: noUncheckedIndexedAccess FIXME
            !/(?:^|;|\s)text-decoration\s*:/i.test(styleContent)
          ) {
            // Style has color but no text-decoration - add text-decoration if needed
            const newAttributes = attributes.replace(
              /style="([^"]*)"/i,
              'style="$1; text-decoration: none"',
            );
            return `<a${newAttributes}>`;
          }
          // Style has color and possibly text-decoration, do nothing
          return match;
        } else {
          // Style exists, but no color - add color and possibly text-decoration
          const newAttributes = attributes.replace(
            /style="([^"]*)"/i,
            `style="$1; color: ${linkColor}${textDecoration ? "; " + textDecoration.trim() : ""}"`,
          );
          return `<a${newAttributes}>`;
        }
      } else {
        // Style attribute does not exist - add it with color and possibly text-decoration
        return `<a${attributes} style="color: ${linkColor}${textDecoration ? "; " + textDecoration.trim() : ""}">`;
      }
    })
    .replaceAll("<p></p>", "<br>")
    .replaceAll('<p style="text-align: center;"></p>', "<br>");
};

export const EmailText = memo(function EmailText(
  props: Hydrated<Section.Text>,
) {
  const fontFamilyWithFallback = useEmailFontFamily(props.fontFamily);
  const renderContext = useRequiredContext(EmailRenderContext);
  const quillHtml = processQuillHtml(
    allHrefsSanitized(props.text),
    props.linkColor,
  );

  const padding = props.sectionPadding;
  const parserOptions = createParserOptions({
    blockId: props.blockId,
    format: renderContext?.format,
    renderContext,
  });
  const parsedText = htmlReactParser(quillHtml, parserOptions);

  if (renderContext.template.isPlainText) {
    return <>{parsedText}</>;
  }

  return (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={padding.bottom}
      paddingLeft={widthPixelsToPercentage(padding.left).formatted}
      paddingRight={widthPixelsToPercentage(padding.right).formatted}
      paddingTop={padding.top}
    >
      <MjmlColumn>
        <MjmlText
          align={props.textAlign as any}
          color={props.textColor}
          fontFamily={fontFamilyWithFallback}
          fontSize={props.fontSize}
          lineHeight={props.lineHeight ?? "1.42"}
          padding="0"
        >
          {parsedText}
        </MjmlText>
      </MjmlColumn>
    </MjmlSection>
  );
});

export const NestedEmailText = memo(function NestedEmailText(
  props: Hydrated<Section.Text>,
) {
  const fontFamilyWithFallback = useEmailFontFamily(props.fontFamily);
  const renderContext = useRequiredContext(EmailRenderContext);
  const quillHtml = processQuillHtml(
    allHrefsSanitized(props.text),
    props.linkColor,
  );
  const padding = props.sectionPadding;
  const parserOptions = createParserOptions({
    blockId: props.blockId,
    format: renderContext?.format,
    renderContext,
  });

  return (
    <div
      style={{
        color: props.textColor,
        fontFamily: fontFamilyWithFallback,
        fontSize: props.fontSize,
        lineHeight: props.lineHeight ?? "1.42",
        textAlign: props.textAlign as any,
        backgroundColor: props.sectionColor,
        paddingBottom: padding.bottom,
        paddingLeft: padding.left,
        paddingRight: padding.right,
        paddingTop: padding.top,
      }}
    >
      {htmlReactParser(quillHtml, parserOptions)}
    </div>
  );
});
