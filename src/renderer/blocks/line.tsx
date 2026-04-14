import { MjmlColumn, MjmlDivider, MjmlSection } from "@faire/mjml-react";
import { Section } from "../types.js";
import { Hydrated } from "../types.js";
import { memo } from "react";

export const EmailLine = memo(function EmailLine(props: Hydrated<Section.Line>) {
  const sectionPadding = props.sectionPadding;
  const inner = props.padding;

  return (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={sectionPadding.bottom}
      paddingLeft={sectionPadding.left}
      paddingRight={sectionPadding.right}
      paddingTop={sectionPadding.top}
    >
      <MjmlColumn>
        <MjmlDivider
          borderColor={props.color}
          borderWidth={2}
          paddingTop={inner.top}
          paddingRight={inner.right}
          paddingBottom={inner.bottom}
          paddingLeft={inner.left}
        />
      </MjmlColumn>
    </MjmlSection>
  );
});
