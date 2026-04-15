/**
 * Minimal type definitions for the vendored Redo email renderer.
 *
 * These are hand-transcribed from redo/model/src/email-template.ts and
 * redo/model/src/email-builder.ts at the commit in ~/code/redoapp on 2026-04-11.
 * Only the 10 AI-supported block types are represented.
 *
 * If upstream Redo changes a block schema, update here.
 */

// ---------------------------- Enums ----------------------------

export enum EmailBlockType {
  BUTTON = "button",
  HEADER = "header",
  IMAGE = "image",
  TEXT = "text",
  SPACER = "spacer",
  LINE = "line",
  COLUMN = "column",
  MENU = "menu",
  SOCIALS = "socials",
  DISCOUNT = "discount",
  PRODUCTS = "interactive-cart",
}

export enum Size {
  SMALL = "small",
  MEDIUM = "medium",
  LARGE = "large",
  CUSTOM = "custom",
}

export enum ImageType {
  URL = "url",
  UPLOAD = "upload",
}

export const TRACKING_ATTRIBUTES_CLASS_PREFIX = "redo-track-";
export const TRACKING_ATTRIBUTES_DELIMITER = "|||";

export enum EmailFormat {
  STATIC = "static",
  AMP = "amp",
}

export enum EmailRenderEnvironment {
  REAL = "real",
  BUILDER = "builder",
  PREVIEW = "preview",
  SEED_LIST = "seed-list",
  VIEW_IN_BROWSER = "view-in-browser",
}

export enum Alignment {
  LEFT = "left",
  CENTER = "center",
  RIGHT = "right",
}

export enum VerticalAlignment {
  TOP = "top",
  CENTER = "center",
  BOTTOM = "bottom",
}

export enum EmailHeaderType {
  IMAGE = "image",
  LOGO = "logo",
  TEXT = "text",
}

export enum ButtonLinkType {
  WEB_PAGE = "web-page",
  DYNAMIC_VARIABLE = "dynamic-variable",
}

export enum EmailBuilderFontWeight {
  NORMAL = "normal",
  BOLD = "bold",
}

export enum SocialPlatform {
  FACEBOOK = "facebook",
  INSTAGRAM = "instagram",
  TWITTER = "twitter",
  X = "x",
  YOUTUBE = "youtube",
  TIKTOK = "tiktok",
  LINKEDIN = "linkedin",
  PINTEREST = "pinterest",
  SNAPCHAT = "snapchat",
  WHATSAPP = "whatsapp",
  TELEGRAM = "telegram",
  DISCORD = "discord",
  TWITCH = "twitch",
  REDDIT = "reddit",
  THREADS = "threads",
  BLUESKY = "bluesky",
  WEBSITE = "website",
  EMAIL = "email",
}

export enum SocialIconColor {
  BLACK = "black",
  WHITE = "white",
  GRAY = "gray",
}

export enum SocialItemSource {
  BRAND_KIT = "brand-kit",
  CUSTOM = "custom",
}

// ---------------------------- Primitives ----------------------------

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Percentage = number & { readonly __brand: "Percentage" };

// ---------------------------- Block base ----------------------------

interface BaseBlock {
  blockId: string;
  sectionPadding: Padding;
  sectionColor: string;
}

// ---------------------------- Concrete blocks ----------------------------

export interface SpacerBlock extends BaseBlock {
  type: EmailBlockType.SPACER;
  height: number;
}

export interface LineBlock extends BaseBlock {
  type: EmailBlockType.LINE;
  color: string;
  padding: Padding;
  horizontalPadding: Size;
  verticalPadding: Size;
}

export interface TextBlock extends BaseBlock {
  type: EmailBlockType.TEXT;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  linkColor: string;
  text: string;
  lineHeight?: string;
  textAlign?: string;
}

export interface ButtonBlock extends BaseBlock {
  type: EmailBlockType.BUTTON;
  alignment: Alignment;
  cornerRadius: number;
  buttonText: string;
  padding: Padding;
  buttonLink?: string;
  fillColor: string;
  strokeColor: string;
  textColor: string;
  strokeWeight: number;
  fontFamily: string;
  fontSize: number;
  fullWidth?: boolean;
  linkType: ButtonLinkType;
  buttonType?: "button" | "submit" | "reset";
  schemaFieldName?: string;
}

export interface CropConfigV1 {
  crop: { x: number; y: number; width: number; height: number };
  imageHeight: number;
  imageWidth: number;
  circularCrop: boolean;
  cropWidthRatio: number;
  cropHeightRatio: number;
}

export interface CropConfigV2 {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
  circularCrop: boolean;
  baseImage: { width: number; height: number };
}

export interface ImageBlock extends BaseBlock {
  type: EmailBlockType.IMAGE;
  imageUrl: string;
  croppedImageUrl?: string;
  showCaption: boolean;
  caption?: string;
  altText?: string;
  clickthroughUrl?: string;
  aspectRatio?: number;
  padding: Padding;
  horizontalPadding: Size;
  verticalPadding: Size;
  imageSourceType?: ImageType;
  cropConfig?: CropConfigV1;
  cropConfigV2?: CropConfigV2;
}

export interface HeaderBlock extends BaseBlock {
  type: EmailBlockType.HEADER;
  headerType: EmailHeaderType;
  layout: Alignment;
  imageUrl: string;
  text: string;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  logoHeight: number;
  imageHeight: number;
  altText?: string;
  clickthroughUrl?: string;
}

export interface MenuItem {
  id: string;
  label: string;
}

export interface MenuBlock extends BaseBlock {
  type: EmailBlockType.MENU;
  menuItems: MenuItem[];
  linkColor: string;
  alignment: Alignment;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  stackOnMobile: boolean;
  itemSpacing?: number;
  useCustomSpacing?: boolean;
}

export interface SocialItem {
  id: string;
  platform: SocialPlatform;
  url: string;
  hidden?: boolean;
  source?: SocialItemSource;
}

export interface SocialsBlock extends BaseBlock {
  type: EmailBlockType.SOCIALS;
  socialLinks: SocialItem[];
  iconColor: SocialIconColor;
  iconPadding: number;
  alignment: Alignment;
  useBrandKitSocials?: boolean;
}

export interface DiscountBlock extends BaseBlock {
  type: EmailBlockType.DISCOUNT;
  alignment: Alignment;
  fontFamily: string;
  fontWeight: EmailBuilderFontWeight;
  fontSize: number;
  textColor: string;
  blockBackgroundColor: string;
  discountId?: string;
}

// ---------------------------- Products block ----------------------------

export interface InlineButton {
  alignment: Alignment;
  cornerRadius: number;
  buttonText: string;
  padding: Padding;
  fillColor: string;
  strokeColor: string;
  textColor: string;
  strokeWeight: number;
  fontFamily: string;
  fontSize: number;
}

export type ProductImageSize = "small" | "medium" | "large";
export type ProductLayoutType = "rows" | "columns";
export type ProductObjectFit = "cover" | "contain";
export type ProductSelectionType = "dynamic" | "static";

export interface ManuallySelectedProduct {
  productId: string;
  variantId: string;
}

export interface ProductFilterDoc {
  name: string;
  provider: "shopify";
  additionalProductFilters: {
    type: "inventory";
    inventory: number;
    comparisonOperator: "greater_than";
  }[];
  productRecommendationType:
    | "best_sellers"
    | "products_added_to_cart"
    | "collection";
  sortBy?: "price_desc" | "price_asc";
  unit?: "day";
  value?: number;
  collectionId?: string;
}

export interface ProductsBlock extends BaseBlock {
  type: EmailBlockType.PRODUCTS;
  textColor: string;
  fontFamily: string;
  titleFontSize?: number;
  imageCornerRadius: number;
  checkoutButton: InlineButton;
  lineItemButtons: InlineButton;
  numberOfProducts: number;
  imageSize: ProductImageSize;
  productSelectionType: ProductSelectionType;
  showPrice?: boolean;
  showTitle?: boolean;
  showImage?: boolean;
  showButton?: boolean;
  showQuantity?: boolean;
  layoutType?: ProductLayoutType;
  alignment: Alignment;
  columns: number;
  stackOnMobile: boolean;
  manuallySelectedProducts: ManuallySelectedProduct[];
  imageAspectRatio?: number;
  imageObjectFit?: ProductObjectFit;
  schemaFieldName?: string;
  provider: "shopify";
  recommendedProductFilterId?: string;
  // Non-prod: executor reads this, POSTs to createProductFilter, then replaces
  // it with recommendedProductFilterId. Stripped before the template reaches prod.
  _pendingFilter?: ProductFilterDoc;
}

export type NonRecursiveBlock =
  | SpacerBlock
  | LineBlock
  | TextBlock
  | ButtonBlock
  | ImageBlock
  | HeaderBlock
  | MenuBlock
  | SocialsBlock
  | DiscountBlock;

export interface ColumnBlock extends BaseBlock {
  type: EmailBlockType.COLUMN;
  columns: (NonRecursiveBlock | null)[];
  columnCount: number;
  gap: number;
  stackOnMobile: boolean;
  alignment: VerticalAlignment;
  columnWidths?: number[] | null;
}

export type Section = NonRecursiveBlock | ColumnBlock | ProductsBlock;

// ---------------------------- Hydrated types ----------------------------

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Hydrated wraps a Section with runtime-computed extras.
 * For most blocks the hydrated form is identical to the base form.
 * IMAGE, HEADER, COLUMN, and DISCOUNT have extras.
 */
export type Hydrated<T extends Section = Section> = T extends ImageBlock
  ? T & { imageDimensions: ImageDimensions | null; containerWidth?: number; hydrated: true }
  : T extends HeaderBlock
  ? T & { processedImageUrl: string | null; hydrated: true }
  : T extends ColumnBlock
  ? T & { nestedHydratedSections?: Record<number, Hydrated<Section>>; hydrated: true }
  : T extends DiscountBlock
  ? T & { discountCode?: string; hydrated: true }
  : T & { hydrated?: true };

// Section namespace mirrors redo-model's EmailBlock namespace
export namespace Section {
  export type Text = TextBlock;
  export type Button = ButtonBlock;
  export type Image = ImageBlock;
  export type Header = HeaderBlock;
  export type Spacer = SpacerBlock;
  export type Line = LineBlock;
  export type Column = ColumnBlock;
  export type Menu = MenuBlock;
  export type Socials = SocialsBlock;
  export type Discount = DiscountBlock;
  export type Products = ProductsBlock;
}

export type HttpsUrl = `https://${string}`;

export enum ObjectFit {
  COVER = "cover",
  CONTAIN = "contain",
}

export enum SesClickTags {
  BLOCK_ID = "block_id",
  ELEMENT_ID = "element_id",
}

export const EMAIL_MOBILE_BREAKPOINT_WIDTH_PX = 450;

// ---------------------------- Misc helpers ----------------------------

export const EMAIL_MAX_WIDTH_PX = 600;

/**
 * widthPixelsToPercentage — matches redo-model's helper.
 * Returns an object with .rawNumber (0–100) and .formatted ("X.XX%").
 */
export function widthPixelsToPercentage(px: number): {
  rawNumber: Percentage;
  formatted: string;
} {
  const pct = (px / EMAIL_MAX_WIDTH_PX) * 100;
  return {
    rawNumber: pct as Percentage,
    formatted: `${pct.toFixed(2)}%`,
  };
}
