import { EmailBlockType } from "./types.js";
import { memo, NamedExoticComponent } from "react";
import { NestedEmailButton } from "./blocks/button.js";
import { NestedEmailDiscount } from "./blocks/discount.js";
import { NestedEmailImage } from "./blocks/image.js";
import { NestedEmailText } from "./blocks/text.js";

export const nestedEmailBlocks: Record<
  EmailBlockType,
  | { Component: NamedExoticComponent<any>; useMjmlTextWrapper: boolean }
  | undefined
> = {
  [EmailBlockType.TEXT]: {
    Component: NestedEmailText,
    useMjmlTextWrapper: true,
  },
  [EmailBlockType.BUTTON]: {
    Component: memo(function HtmlEmailButton(
      props: any & { renderMode?: "html" | "mjml" },
    ) {
      return (
        <NestedEmailButton {...props} renderMode={props.renderMode ?? "mjml"} />
      );
    }),
    useMjmlTextWrapper: false,
  },
  [EmailBlockType.HEADER]: undefined,
  [EmailBlockType.IMAGE]: {
    Component: NestedEmailImage,
    useMjmlTextWrapper: true,
  },
  [EmailBlockType.SPACER]: undefined,
  [EmailBlockType.LINE]: undefined,
  [EmailBlockType.COLUMN]: undefined,
  [EmailBlockType.MENU]: undefined,
  [EmailBlockType.SOCIALS]: undefined,
  [EmailBlockType.DISCOUNT]: {
    Component: NestedEmailDiscount,
    useMjmlTextWrapper: true,
  },
};
