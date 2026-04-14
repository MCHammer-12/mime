import {
  EmailFormat,
  EmailRenderEnvironment,
} from "../types.js";
import { createContext } from "react";

export type EmailRenderContext = {
  team: {
    storeUrl: string;
    settings?: {
      brandKit?: {
        socialLinks?: Partial<Record<string, string | null>>;
        customFontFamilies?: Array<{ fontFamily: string; fallbackFontFamily?: string }> | null;
        font?: { headerFontFamily?: string; bodyFontFamily?: string };
      };
    };
  };
  template: {
    isPlainText?: boolean;
  };
  schemaInstance: Record<string, unknown>;
  utm: {
    applyToUrl(url: string): string;
  };
  externalFallbackUrl?: string;
  emailId: string;
  automationId?: string;
  campaignId?: string;
  recipient: {
    firstName?: string;
    lastName?: string;
    redoCustomerId?: string;
    email: string;
  };
  format: EmailFormat;
  forceFallback: boolean;
  forceClickMapDataAttributes?: boolean;
  renderWidth?: number;
  environment: EmailRenderEnvironment;
  logger?: { warn: (message: string, context?: object) => void };
};

export const EmailRenderContext = createContext<EmailRenderContext | undefined>(
  undefined,
);
