import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import { useContext } from "react";
import { memo } from "react";
import { EmailRenderContext } from "../builder/email-render-context.js";
import { Hydrated, Section } from "../types.js";

/**
 * Preview-only counterpart to redo/email/content/src/blocks/footer.tsx.
 * Production pulls the address off the team record; mime has no team, so
 * the preview shows the address the template carries (if any) plus the
 * unsubscribe link from the schema instance.
 */
export const EmailFooter = memo(function EmailFooter(
  props: Hydrated<Section.Footer>,
) {
  const ctx = useContext(EmailRenderContext);
  const sectionPadding = props.sectionPadding;
  const inner = props.padding;
  const unsubscribeLink = props.schemaFieldName
    ? (ctx?.schemaInstance[props.schemaFieldName] as string | undefined)
    : undefined;

  return (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={sectionPadding.bottom}
      paddingLeft={sectionPadding.left}
      paddingRight={sectionPadding.right}
      paddingTop={sectionPadding.top}
    >
      <MjmlColumn>
        <MjmlText
          align={props.alignment}
          color={props.textColor}
          fontFamily={props.fontFamily}
          fontSize={props.fontSize ? `${props.fontSize}px` : undefined}
          paddingTop={inner.top}
          paddingRight={inner.right}
          paddingBottom={inner.bottom}
          paddingLeft={inner.left}
        >
          <a href={unsubscribeLink ?? "#"} style={{ color: props.textColor }}>
            Unsubscribe
          </a>
        </MjmlText>
      </MjmlColumn>
    </MjmlSection>
  );
});
