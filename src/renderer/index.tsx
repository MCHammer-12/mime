import { Mjml, MjmlAttributes, MjmlBody, MjmlHead, MjmlStyle } from "@faire/mjml-react";
import { renderToMjml } from "@faire/mjml-react/utils/renderToMjml";
import mjml2html from "mjml";
import React from "react";
import { EmailButton } from "./blocks/button.js";
import { EmailColumn } from "./blocks/column.js";
import { EmailDiscount } from "./blocks/discount.js";
import { EmailHeader } from "./blocks/header.js";
import { EmailImage } from "./blocks/image.js";
import { EmailLine } from "./blocks/line.js";
import { EmailMenu } from "./blocks/menu.js";
import { EmailProducts } from "./blocks/product.js";
import { EmailSocials } from "./blocks/socials.js";
import { EmailSpacer } from "./blocks/spacer.js";
import { EmailText } from "./blocks/text.js";
import { EmailRenderContext } from "./builder/email-render-context.js";
import type { EmailRenderContext as EmailRenderContextType } from "./builder/email-render-context.js";
import {
  EmailBlockType,
  EmailFormat,
  EmailRenderEnvironment,
  Section,
} from "./types.js";

// "interactive-cart" is the PRODUCTS block type. Not in EmailBlockType enum
// yet — see src/parser/blocks/TODO-SHARED-product.md.
const componentMap: Record<string, React.NamedExoticComponent<any>> = {
  [EmailBlockType.SPACER]: EmailSpacer,
  [EmailBlockType.LINE]: EmailLine,
  [EmailBlockType.TEXT]: EmailText,
  [EmailBlockType.IMAGE]: EmailImage,
  [EmailBlockType.BUTTON]: EmailButton,
  [EmailBlockType.HEADER]: EmailHeader,
  [EmailBlockType.COLUMN]: EmailColumn,
  [EmailBlockType.MENU]: EmailMenu,
  [EmailBlockType.SOCIALS]: EmailSocials,
  [EmailBlockType.DISCOUNT]: EmailDiscount,
  "interactive-cart": EmailProducts,
};

const defaultRenderContext: EmailRenderContextType = {
  team: {
    storeUrl: "https://example.com",
  },
  template: {},
  schemaInstance: {},
  utm: {
    applyToUrl(url: string) {
      return url;
    },
  },
  emailId: "preview",
  recipient: {
    email: "preview@example.com",
  },
  format: EmailFormat.STATIC,
  forceFallback: false,
  environment: EmailRenderEnvironment.PREVIEW,
};

/**
 * Render a list of Sections to an email HTML string.
 *
 * This is the mime-local analogue of renderEmail from
 * redo/email/ssr/src/render-pipeline.ts, minus click tracking, UTM,
 * minification, feature flags, and team context.
 */
export function renderSections(
  sections: Section[],
  options?: {
    context?: Partial<EmailRenderContextType>;
    bodyBackgroundColor?: string;
    contentBackgroundColor?: string;
  },
): string {
  const renderContext: EmailRenderContextType = {
    ...defaultRenderContext,
    ...options?.context,
  };
  const bgColor = options?.bodyBackgroundColor || "#ffffff";
  const contentBgColor = options?.contentBackgroundColor || "#ffffff";

  const children = sections.map((section, i) => {
    const Component = componentMap[section.type];
    if (!Component) {
      throw new Error(
        `No email block component for type "${section.type}" — not yet vendored in.`,
      );
    }
    return <Component key={i} {...(section as any)} />;
  });

  const tree = (
    <EmailRenderContext.Provider value={renderContext}>
      <Mjml>
        <MjmlHead>
          <MjmlStyle>{PRODUCTION_GLOBAL_STYLES}</MjmlStyle>
        </MjmlHead>
        <MjmlBody width={600} backgroundColor={bgColor} cssClass="redo-body">
          {children}
        </MjmlBody>
      </Mjml>
    </EmailRenderContext.Provider>
  );

  const mjml = renderToMjml(tree);
  const result = mjml2html(mjml);
  if (result.errors.length > 0) {
    console.error("MJML parse errors:", result.errors);
  }
  return result.html;
}

/**
 * Production global styles from redo/email/content/src/email-wrapper.tsx
 * (MERCHANT_TEMPLATED_EMAIL_GLOBAL_STYLES with template literals resolved)
 */
const PRODUCTION_GLOBAL_STYLES = `
  * { margin: 0; }
  html, body { width: 100%; margin: 0; padding: 0; }
  p { margin: 0; }
  body { padding-top: 76px; padding-bottom: 76px; }
  @media screen and (max-width: 600px) {
    body { padding: 0; }
    .redo-body { width: 100%; }
  }
  @media only screen and (max-width: 419px) {
    .menu-no-stack .mj-column-per-100 div[class*=mj-column-per-] {
      display: inline-block !important;
      vertical-align: top !important;
    }
    .menu-no-stack div.mj-column-per-50 {
      display: inline-block !important;
      vertical-align: top !important;
      width: 50% !important;
    }
    .menu-no-stack div[class^=mj-column-per-] {
      display: inline-block !important;
      vertical-align: top !important;
    }
  }
  .ql-align-right { text-align: right; }
  .ql-align-center { text-align: center; }
  .ql-size-small { font-size: 0.75em; }
  .ql-size-large { font-size: 1.5em; }
  .ql-size-huge { font-size: 2.5em; }
  .ql-blank { padding: unset !important; }
  .ql-blank::before { left: unset !important; right: unset !important; }
`;
