import { EmailBlockType } from "../types.js";

export enum ClickableElementInteractionType {
  INTERACTIVE = "interactive",
  LINK = "link",
}

export enum ClickableElementIdentifiability {
  NAMED = "named",
  ANONYMOUS = "anonymous",
}

export interface NamedClickableElement {
  idSuffix: string;
  interactionType: ClickableElementInteractionType;
  identifiability: ClickableElementIdentifiability.NAMED;
}

export interface AnonymousClickableElement {
  idSuffix: string;
  interactionType: ClickableElementInteractionType;
  identifiability: ClickableElementIdentifiability.ANONYMOUS;
}

export type ClickableElement = NamedClickableElement | AnonymousClickableElement;

export type NamedElementId = `${ClickableElementIdentifiability.NAMED}_${string}`;
export type AnonymousElementId = `${ClickableElementIdentifiability.ANONYMOUS}_${string}`;
export type ElementId = NamedElementId | AnonymousElementId;

export function namedElementId(element: NamedClickableElement): NamedElementId {
  return `${ClickableElementIdentifiability.NAMED}_${element.idSuffix}`;
}

export function anonymousElementId(element: AnonymousClickableElement): AnonymousElementId {
  return `${ClickableElementIdentifiability.ANONYMOUS}_${element.idSuffix}`;
}

export function elementId(element: ClickableElement): ElementId {
  if (element.identifiability === ClickableElementIdentifiability.NAMED) {
    return namedElementId(element);
  } else {
    return anonymousElementId(element);
  }
}

export const namedClickableElements = {
  [EmailBlockType.BUTTON]: {},
  [EmailBlockType.HEADER]: {
    HEADER_LINK: {
      idSuffix: "header-link",
      interactionType: ClickableElementInteractionType.LINK,
      identifiability: ClickableElementIdentifiability.NAMED,
    },
  } as const,
  [EmailBlockType.IMAGE]: {
    CLICKTHROUGH_LINK: {
      idSuffix: "clickthrough-link",
      interactionType: ClickableElementInteractionType.LINK,
      identifiability: ClickableElementIdentifiability.NAMED,
    },
  } as const,
  [EmailBlockType.TEXT]: {},
  [EmailBlockType.SPACER]: {},
  [EmailBlockType.LINE]: {},
  [EmailBlockType.COLUMN]: {},
  [EmailBlockType.MENU]: {},
  [EmailBlockType.SOCIALS]: {},
  [EmailBlockType.DISCOUNT]: {},
} as const satisfies Record<string, Record<string, NamedClickableElement>>;
