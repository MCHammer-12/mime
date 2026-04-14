import { MjmlColumn, MjmlDivider, MjmlSection } from "@faire/mjml-react";
import { Section } from "../types.js";
import { Hydrated } from "../types.js";
import { memo } from "react";

type LineWithExtras = Hydrated<Section.Line> & {
  thickness?: number;
  innerPadding?: { top: number; right: number; bottom: number; left: number };
};

export const EmailLine = memo(function EmailLine(props: Hydrated<Section.Line>) {
  const p = props as LineWithExtras;
  const padding = props.sectionPadding;
  const thickness = p.thickness ?? 2;
  const inner = p.innerPadding ?? { top: 0, right: 0, bottom: 0, left: 0 };

  return (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={padding.bottom}
      paddingLeft={padding.left}
      paddingRight={padding.right}
      paddingTop={padding.top}
    >
      <MjmlColumn>
        <MjmlDivider
          borderColor={props.color}
          borderWidth={thickness}
          paddingTop={inner.top}
          paddingRight={inner.right}
          paddingBottom={inner.bottom}
          paddingLeft={inner.left}
        />
      </MjmlColumn>
    </MjmlSection>
  );
});
