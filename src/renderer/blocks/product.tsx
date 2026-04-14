import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import { memo } from "react";
import type { Alignment, Padding } from "../types.js";

// ─── Local type shim ─────────────────────────────────────────────
//
// Mirrors the ProductsBlock interface defined in
// src/parser/blocks/product.ts. Not yet in src/renderer/types.ts —
// see src/parser/blocks/TODO-SHARED-product.md.

interface InlineButton {
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

interface ProductsBlockState {
  type: "interactive-cart";
  blockId: string;
  sectionPadding: Padding;
  sectionColor: string;
  textColor: string;
  fontFamily: string;
  titleFontSize?: number;
  imageCornerRadius: number;
  checkoutButton: InlineButton;
  lineItemButtons: InlineButton;
  numberOfProducts: number;
  imageSize: "small" | "medium" | "large";
  productSelectionType: "dynamic" | "manual";
  showPrice?: boolean;
  showTitle?: boolean;
  showImage?: boolean;
  showButton?: boolean;
  layoutType?: "rows" | "grid";
  alignment: Alignment;
  columns: number;
  stackOnMobile: boolean;
}

const IMAGE_HEIGHT_PX: Record<"small" | "medium" | "large", number> = {
  small: 90,
  medium: 140,
  large: 200,
};

/**
 * Placeholder renderer for the dynamic products (interactive-cart) block.
 *
 * Real product data is populated server-side by Redo's product filter at send
 * time. In the migration preview we draw a static grid of N placeholder cells
 * using the block's own styling so Michael can eyeball the layout.
 */
export const EmailProducts = memo(function EmailProducts(
  state: ProductsBlockState,
) {
  const padding = state.sectionPadding;
  const cols = Math.max(1, state.columns);
  const count = Math.max(1, state.numberOfProducts);
  const imageHeight = IMAGE_HEIGHT_PX[state.imageSize] ?? 140;

  const cells = Array.from({ length: count }, (_, i) => (
    <ProductCell key={i} state={state} imageHeight={imageHeight} index={i} />
  ));

  // One MjmlSection, one column per product (Redo lays them out horizontally).
  // Stacking on mobile is MJML default. For >1 column we just render each cell
  // inside its own MjmlColumn; for a single column all cells stack in one.
  return (
    <MjmlSection
      backgroundColor={state.sectionColor}
      paddingBottom={padding.bottom}
      paddingLeft={padding.left}
      paddingRight={padding.right}
      paddingTop={padding.top}
    >
      {cols === 1 ? (
        <MjmlColumn>{cells}</MjmlColumn>
      ) : (
        cells.map((cell, i) => <MjmlColumn key={i}>{cell}</MjmlColumn>)
      )}
    </MjmlSection>
  );
});

const ProductCell = ({
  state,
  imageHeight,
  index,
}: {
  state: ProductsBlockState;
  imageHeight: number;
  index: number;
}) => {
  const titleFontSize = state.titleFontSize ?? 14;
  const btn = state.lineItemButtons;

  return (
    <MjmlText padding="8px 8px 16px 8px">
      <div
        style={{
          textAlign: "center",
          fontFamily: state.fontFamily,
          color: state.textColor,
        }}
      >
        {state.showImage !== false && (
          <div
            style={{
              backgroundColor: "#e8e8e8",
              height: `${imageHeight}px`,
              borderRadius: `${state.imageCornerRadius}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#999",
              fontSize: "12px",
              marginBottom: "8px",
            }}
          >
            Product {index + 1}
          </div>
        )}
        {state.showTitle !== false && (
          <div
            style={{
              fontSize: `${titleFontSize}px`,
              fontWeight: 700,
              color: state.textColor,
              marginBottom: "4px",
            }}
          >
            Product Title
          </div>
        )}
        {state.showPrice && (
          <div
            style={{
              fontSize: `${titleFontSize}px`,
              color: state.textColor,
              marginBottom: "8px",
            }}
          >
            $XX.XX
          </div>
        )}
        {state.showButton !== false && (
          <div
            style={{
              display: "inline-block",
              backgroundColor: btn.fillColor,
              color: btn.textColor,
              border:
                btn.strokeWeight > 0
                  ? `${btn.strokeWeight}px solid ${btn.strokeColor}`
                  : "none",
              borderRadius: `${btn.cornerRadius}px`,
              padding: `${btn.padding.top}px ${btn.padding.right}px ${btn.padding.bottom}px ${btn.padding.left}px`,
              fontFamily: btn.fontFamily,
              fontSize: `${btn.fontSize}px`,
              fontWeight: 400,
            }}
          >
            {btn.buttonText}
          </div>
        )}
      </div>
    </MjmlText>
  );
};
