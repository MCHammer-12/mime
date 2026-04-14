import { MjmlColumn, MjmlSection, MjmlText } from "@faire/mjml-react";
import {
  Section,
  VerticalAlignment,
  widthPixelsToPercentage,
  EMAIL_MAX_WIDTH_PX,
  Percentage,
} from "../types.js";
import { Hydrated } from "../types.js";
import { Fragment, memo } from "react";
import { nestedEmailBlocks } from "../nested-email-blocks.js";
import { MaybeMjmlGroup } from "./products/static-cart.js";

export const NUM_DECIMAL_PLACES = 2;
const REPEATING_DECIMAL_DECIMAL_PLACES = 8;

export const EmailColumn = memo(function EmailColumn(
  props: Hydrated<Section.Column>,
) {
  const padding = props.sectionPadding;

  const relativeGapWidth = widthPixelsToPercentage(props.gap).rawNumber;

  const getColumnWidth = (index: number): Percentage => {
    if (props.columnWidths && props.columnWidths.length === props.columnCount) {
      const totalGapWidth = relativeGapWidth * (props.columnCount - 1);
      const availableWidth = 100 - totalGapWidth;
      const columnWidths = withExtraPrecisionForRepeatingDecimals(
        props.columnWidths as Percentage[],
      );
      // @ts-expect-error TODO: noUncheckedIndexedAccess FIXME
      return ((columnWidths[index] / 100) * availableWidth) as Percentage;
    } else {
      return ((100 - relativeGapWidth * (props.columnCount - 1)) /
        props.columnCount) as Percentage;
    }
  };

  return (
    <MjmlSection
      backgroundColor={props.sectionColor}
      paddingBottom={padding.bottom}
      paddingLeft={widthPixelsToPercentage(padding.left).formatted}
      paddingRight={widthPixelsToPercentage(padding.right).formatted}
      paddingTop={padding.top}
    >
      <MaybeMjmlGroup responsive={props.stackOnMobile}>
        {Array.from({ length: props.columnCount }).map((_, index) => {
          const column = props.columns[index];
          if (!column) return <MjmlColumn key={index} />;
          const NestedBlock = nestedEmailBlocks[column.type];
          const nestedHydratedSection = props.nestedHydratedSections?.[index];

          const columnWidthPercent = getColumnWidth(index);
          const availableEmailWidth =
            EMAIL_MAX_WIDTH_PX - padding.left - padding.right;
          const totalGapWidthPx = props.gap * (props.columnCount - 1);
          const availableContentWidth = Math.max(
            availableEmailWidth - totalGapWidthPx,
            0,
          );
          const containerWidthPx = Math.floor(
            (columnWidthPercent / 100) * availableContentWidth,
          );

          const columnContext = { containerWidth: containerWidthPx };
          const isLast = index === props.columnCount - 1;
          const columnWidth = getColumnWidth(index);
          const MaybeMjmlText = NestedBlock?.useMjmlTextWrapper
            ? ({ children }: { children: React.ReactNode }) => (
                <MjmlText>{children}</MjmlText>
              )
            : ({ children }: { children: React.ReactNode }) => <>{children}</>;

          return (
            <Fragment key={index}>
              <MjmlColumn
                verticalAlign={
                  verticalAlignmentToCssVerticalAlign[props.alignment]
                }
                width={`${columnWidth}%`}
              >
                {NestedBlock ? (
                  <MaybeMjmlText>
                    <NestedBlock.Component
                      {...column}
                      {...nestedHydratedSection}
                      {...columnContext}
                    />
                  </MaybeMjmlText>
                ) : null}
              </MjmlColumn>
              {!isLast && props.gap > 0 && (
                <MjmlColumn width={`${relativeGapWidth}%`} />
              )}
            </Fragment>
          );
        })}
      </MaybeMjmlGroup>
    </MjmlSection>
  );
});

const WIDTH_EQUALITY_TOLERANCE_PERCENTAGE = 1 / 10 ** NUM_DECIMAL_PLACES;
const BIAS = 0.000_000_000_001;

function areWidthsIntendedToBeEqual(widths: Percentage[]) {
  const firstWidth = widths[0];
  const result = widths.every(
    (w) =>
      // @ts-expect-error TODO: noUncheckedIndexedAccess FIXME
      Math.abs(w - firstWidth) <= WIDTH_EQUALITY_TOLERANCE_PERCENTAGE + BIAS,
  );
  return result;
}

function withExtraPrecisionForRepeatingDecimals(
  probabilities: Percentage[],
): Percentage[] {
  if (areWidthsIntendedToBeEqual(probabilities)) {
    const result = probabilities
      .map(() => 100 / probabilities.length)
      .map((p) => p.toFixed(REPEATING_DECIMAL_DECIMAL_PLACES))
      .map((p) => parseFloat(p) as Percentage);
    return result;
  }
  return probabilities;
}

const verticalAlignmentToCssVerticalAlign: Record<
  VerticalAlignment,
  "top" | "bottom" | "middle"
> = {
  [VerticalAlignment.TOP]: "top",
  [VerticalAlignment.CENTER]: "middle",
  [VerticalAlignment.BOTTOM]: "bottom",
};
