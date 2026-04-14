import { MjmlGroup } from "@faire/mjml-react";
import React from "react";

export const MaybeMjmlGroup = ({
  responsive,
  children,
}: {
  responsive: boolean;
  children: React.ReactNode;
}) => (responsive ? children : <MjmlGroup>{children}</MjmlGroup>);
