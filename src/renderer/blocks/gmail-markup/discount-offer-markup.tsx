export const DiscountOfferEmailMarkup = ({
  description,
  discountCode,
  availabilityStarts,
  availabilityEnds,
}: {
  description?: string;
  discountCode?: string;
  availabilityStarts?: Date;
  availabilityEnds?: Date;
}) => {
  return (
    <div itemScope itemType="http://schema.org/DiscountOffer">
      <meta content={description} itemProp="description" />
      <meta content={discountCode} itemProp="discountCode" />
      {availabilityStarts && (
        <meta
          content={availabilityStarts.toISOString()}
          itemProp="availabilityStarts"
        />
      )}
      {availabilityEnds && (
        <meta
          content={availabilityEnds.toISOString()}
          itemProp="availabilityEnds"
        />
      )}
    </div>
  );
};
