# Element Deep Dive Plan

Goal: Get every Redo email block type pixel-perfect by going through each element individually in parallel terminal sessions.

## Architecture

Each element gets its own parser file (`src/parser/blocks/<element>.ts`) and renderer file (`src/renderer/blocks/<element>.tsx`). The dispatcher (`src/parser/index.ts`) and shared files (`types.ts`, `style-utils.ts`, `helpers.ts`) are frozen during parallel work.

## Shared files (DO NOT EDIT during parallel work)

- `src/parser/index.ts` — dispatcher (walks rows, delegates to block parsers)
- `src/parser/helpers.ts` — sel(), hasClass(), findCls(), nextId(), wrapInParagraphs()
- `src/parser/style-utils.ts` — CSS parsing utilities
- `src/renderer/types.ts` — block type definitions
- `src/renderer/index.tsx` — renderer entry point

If you need a new shared utility or type change, note it in a `TODO-SHARED.md` in your block's directory and we'll merge after.

## How to work on an element

1. Read this plan + the Zod schema section for your element
2. Open your parser file and renderer file
3. Pick 2-3 templates from `migrations/` that heavily use your block type
4. Run viewer to see current state: `npx tsx src/viewer.ts --compare <original.html> <sections.json>`
5. Compare parser output fields against the Zod schema — find missing/wrong fields
6. Fix parser extraction, fix renderer output
7. Re-run viewer, iterate until the block looks right
8. Commit just your block's files

## Elements

### 1. Email Settings (template-level)
**Files:** `src/export-template.ts`
**No parser/renderer block** — this is about template-level metadata.

Zod schema (`emailTemplateSchema`):
```
_id: ObjectId
name: string
subject: string
templateType: "transactional" | "marketing" | "default" | "recover"
category: Category enum
schemaType: SchemaType enum
emailPreview: string | null        ← preview text
emailBackgroundColor: string       ← body bg color
contentBackgroundColor: string     ← content area bg color
address: { businessAddress?, legalAddress, cityStateZip, country } | null
sections: EmailBlock[]
linkColor: string | null           ← global link color
team: ObjectId?
```

Sources in Klaviyo:
- `name` → template API JSON `.attributes.name`
- `subject` → Klaviyo doesn't store subject on template (only on campaign/flow action)
- `emailPreview` → look for `<span class="preheader">` or hidden preview text
- `emailBackgroundColor` → root-container / body background-color (parser already extracts this)
- `contentBackgroundColor` → inner content table background
- `linkColor` → default link color from global styles
- `address` → footer area text (Klaviyo has `{{ organization.name }}`, etc.)

### 2. Text
**Files:** `src/parser/blocks/text.ts`, `src/renderer/blocks/text.tsx`

Zod schema:
```
type: "text"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
textColor: string
fontSize: number
fontFamily: string
linkColor: string
text: string                       ← HTML content (paragraphs, links, bold, italic, etc.)
```

Deep-dive checklist:
- [ ] HTML content preservation (bold, italic, underline, links, alignment)
- [ ] Nested `<p>` tags and `<br>` handling
- [ ] Per-paragraph font overrides (some Klaviyo templates have mixed fonts in one text block)
- [ ] Link colors (both inline `<a style="color:...">` and block-level linkColor)
- [ ] Text alignment (left, center, right) via inline styles
- [ ] Line height
- [ ] Font weight extraction (bold text)
- [ ] Section background color from outer TD
- [ ] Padding from outer TD

### 3. Image
**Files:** `src/parser/blocks/image.ts`, `src/renderer/blocks/image.tsx`

Zod schema:
```
type: "image"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
imageUrl: string
croppedImageUrl?: string
padding: Padding
horizontalPadding: Size            ← MISSING from our types
verticalPadding: Size              ← MISSING from our types
showCaption: boolean               ← MISSING from our types
caption?: string
altText?: string
clickthroughUrl?: string
aspectRatio?: number
cropConfig?: CropConfigV1
cropConfigV2?: CropConfigV2
imageSourceType?: ImageType        ← MISSING from our types
```

Deep-dive checklist:
- [ ] Image URL extraction (src attr)
- [ ] Alt text extraction
- [ ] Clickthrough URL from wrapping `<a>` (kl-img-link)
- [ ] Padding (inner padding around image)
- [ ] Section padding (outer wrapper)
- [ ] Aspect ratio calculation from img dimensions
- [ ] showCaption: default false for Klaviyo imports
- [ ] horizontalPadding / verticalPadding: compute Size enum from pixel values
- [ ] Full-width vs constrained images

### 4. Button
**Files:** `src/parser/blocks/button.ts`, `src/renderer/blocks/button.tsx`
**Session wrap-up & followups:** `src/parser/blocks/TODO-SHARED-button.md`

Zod schema:
```
type: "button"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
alignment: Alignment
cornerRadius: number
buttonText: string
padding: Padding
buttonLink?: string
fillColor: string
strokeColor: string
textColor: string
strokeWeight: number
fontFamily: string
fontSize: number
fullWidth?: boolean
linkType: ButtonLinkType           ← "web-page" | "dynamic-variable"
schemaFieldName?: string
```

Deep-dive checklist:
- [ ] Button text extraction
- [ ] Link URL extraction
- [ ] Fill color (background) from td[bgcolor] or a[style]
- [ ] Text color from a[style]
- [ ] Corner radius from border-radius
- [ ] Stroke color and weight from border styles
- [ ] Font family and size
- [ ] Alignment (left/center/right)
- [ ] Full-width detection (width: 100%)
- [ ] Padding (inner button padding)
- [ ] Section background color

### 5. Line
**Files:** `src/parser/blocks/line.ts`, `src/renderer/blocks/line.tsx`

Zod schema:
```
type: "line"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
color: string
padding: Padding
horizontalPadding: Size            ← MISSING from our types
verticalPadding: Size              ← MISSING from our types
```

Deep-dive checklist:
- [ ] Border color from border-top style
- [ ] Border width/thickness
- [ ] Horizontal and vertical padding (Size enum)
- [ ] Section background color
- [ ] Dashed vs solid line style

### 6. Spacer
**Files:** `src/parser/blocks/spacer.ts`, `src/renderer/blocks/spacer.tsx`

Zod schema:
```
type: "spacer"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
height: number
```

Deep-dive checklist:
- [ ] Height calculation from padding-top + padding-bottom
- [ ] Background color
- [ ] Distinguish spacer from empty wrapper with no content

### 7. Header
**Files:** `src/parser/blocks/header.ts`, `src/renderer/blocks/header.tsx`

Zod schema:
```
type: "header"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
headerType: "image" | "logo" | "text"
layout: Alignment
imageUrl: string
text: string
textColor: string
fontSize: number
fontFamily: string
logoHeight: number
imageHeight: number
altText?: string
clickthroughUrl?: string
```

Deep-dive checklist:
- [ ] Logo image URL and dimensions
- [ ] Logo height calculation (Klaviyo constrains by width, Redo by height)
- [ ] Alt text
- [ ] Clickthrough URL on logo
- [ ] Header type detection (logo vs image vs text)
- [ ] Layout/alignment
- [ ] Section background and padding

### 8. Menu
**Files:** `src/parser/blocks/menu.ts`, `src/renderer/blocks/menu.tsx`

Zod schema:
```
type: "menu"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
menuItems: { id: string, label: string }[]
linkColor: string
alignment: Alignment
fontFamily: string
fontSize: number
textColor: string
stackOnMobile: boolean
itemSpacing?: number               ← MISSING from parser
useCustomSpacing?: boolean         ← MISSING from parser
```

Deep-dive checklist:
- [ ] Menu item extraction (label text + link URL)
- [ ] Label format: HTML with `<p>` and `<a>` tags (Redo expects this)
- [ ] Link color and text color
- [ ] Font family and size
- [ ] Item spacing between menu links
- [ ] Stack on mobile behavior
- [ ] Alignment

### 9. Socials
**Files:** `src/parser/blocks/socials.ts`, `src/renderer/blocks/socials.tsx`

Zod schema:
```
type: "socials"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
socialLinks: { id: string, platform: SocialPlatform, url: string, hidden?: boolean, source?: SocialItemSource }[]
iconColor: SocialIconColor         ← "black" | "white" | "gray" (NO "original" in prod schema!)
iconPadding: number
alignment: Alignment
useBrandKitSocials?: boolean
```

Deep-dive checklist:
- [ ] Platform detection from URL patterns
- [ ] Icon color detection from Klaviyo CDN path (/subtle/, /solid/, /white/)
- [ ] Note: prod SocialIconColor enum is black/white/gray — our types have "original" which doesn't exist in prod
- [ ] Icon padding between social links
- [ ] Alignment
- [ ] Section background and padding

### 10. Column
**Files:** `src/parser/blocks/column.ts`, `src/renderer/blocks/column.tsx`

Zod schema:
```
type: "column"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
columns: (NonRecursiveBlock | null)[]
columnCount: number
gap: number                        ← default COLUMN_GAP = 24
stackOnMobile: boolean
alignment: VerticalAlignment
columnWidths?: number[] | null     ← percentages (0-100)
```

Deep-dive checklist:
- [ ] Column width extraction from inline styles
- [ ] Multi-column row parsing (2, 3, 4 columns)
- [ ] Split block (kl-split) → 2-column
- [ ] Nested block content per column
- [ ] Gap calculation between columns
- [ ] Vertical alignment of content within columns
- [ ] Stack on mobile behavior
- [ ] Section background color

### 11. Products
**Files:** `src/parser/blocks/product.ts`, `src/renderer/blocks/product.tsx` (new)

Zod schema (PRODUCTS / "interactive-cart"):
```
type: "interactive-cart"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
textColor: string
fontFamily: string
titleFontSize?: number
imageCornerRadius: number
checkoutButton: InlineButton
lineItemButtons: InlineButton
numberOfProducts: number
imageSize: Size
productSelectionType: ProductSelectionType
showPrice?: boolean
showTitle?: boolean
showImage?: boolean
showButton?: boolean
showQuantity?: boolean
layoutType?: CartLayoutType
alignment: Alignment
columns: number
stackOnMobile: boolean
manuallySelectedProducts: { productId, variantId }[]
imageAspectRatio?: number
imageObjectFit?: ObjectFit
schemaFieldName?: string
```

Deep-dive checklist:
- [ ] Product image extraction per cell
- [ ] Product title text
- [ ] Product price
- [ ] Product link/clickthrough
- [ ] Button per product
- [ ] Grid layout (columns count)
- [ ] This is complex — Klaviyo product blocks may not map cleanly to Redo's cart schema

### 12. Discount
**Files:** `src/parser/blocks/discount.ts` (new), `src/renderer/blocks/discount.tsx`

Zod schema:
```
type: "discount"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
discountId?: ObjectId
alignment: Alignment
fontFamily: string
fontWeight: "normal" | "bold"
fontSize: number
textColor: string
blockBackgroundColor: string
```

Deep-dive checklist:
- [ ] Detect Klaviyo discount code blocks (look for `{{ coupon_code }}` or similar)
- [ ] Font styling
- [ ] Background color
- [ ] Alignment
- [ ] discountId will be empty for imports (Redo discount must be created separately)

### 13. Footer
**Files:** `src/parser/blocks/footer.ts` (new), `src/renderer/blocks/footer.tsx` (new)

Zod schema:
```
type: "footer"
blockId: ObjectId
sectionPadding: Padding
sectionColor: string
horizontalPadding: Size
verticalPadding: Size
padding: Padding
textColor: string
alignment: Alignment
fontSize?: number
fontFamily?: string
schemaFieldName?: string           ← "unsubscribeLink"
useTemplateAddress?: boolean
```

Deep-dive checklist:
- [ ] Detect Klaviyo footer area (unsubscribe link, company address, view in browser)
- [ ] Extract unsubscribe link pattern
- [ ] Address text → template-level `address` field
- [ ] Font styling
- [ ] This maps to both the Footer block AND the template `address` field

### 14. Shoppable Products (Redo-native)
**Files:** `src/renderer/blocks/shoppable-products.tsx` (new if needed)

No Klaviyo source. This is a Redo-specific interactive block (AMP + Apple Mail).
Work here is renderer-only: ensure the block renders correctly from existing Redo data.

### 15. Scratch Off Discount (Redo-native)
**Files:** `src/renderer/blocks/scratch-to-reveal.tsx` (new if needed)

No Klaviyo source. Redo-specific interactive scratch-to-reveal element.
Work here is renderer-only.

## Type changes needed (coordinate after parallel work)

1. Add `horizontalPadding: Size` and `verticalPadding: Size` to ImageBlock and LineBlock
2. Add `showCaption: boolean` to ImageBlock (required in Zod, currently optional in our types)
3. Add `imageSourceType?: ImageType` to ImageBlock
4. Fix SocialIconColor enum — prod has black/white/gray only, no "original"
5. Add `itemSpacing?: number` and `useCustomSpacing?: boolean` to MenuBlock
6. Add FooterBlock type
7. Add ProductsBlock type (complex — checkoutButton, lineItemButtons, etc.)
8. Add ShoppableProductsBlock type
9. Add ScratchToRevealBlock type
