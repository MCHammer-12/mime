import { MjmlColumn, MjmlSection, MjmlSpacer } from "@faire/mjml-react";
import { Section } from "../types.js";
import { Hydrated } from "../types.js";
import { memo } from "react";

export const EmailSpacer = memo(function EmailSpacer(
  state: Hydrated<Section.Spacer>,
) {
  return (
    <MjmlSection backgroundColor={state.sectionColor} padding="0">
      <MjmlColumn padding="0">
        <MjmlSpacer height={state.height} padding="0" />
      </MjmlColumn>
    </MjmlSection>
  );
});
