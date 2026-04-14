import React, { memo } from "react";

export function useRequiredContext<T>(context: React.Context<T | undefined>): T {
  const value = React.useContext(context);
  if (value === undefined) {
    throw new Error("Context value is undefined — missing Provider?");
  }
  return value;
}

export const genericMemo = memo;
