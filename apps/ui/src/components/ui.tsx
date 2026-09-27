import type { ReactNode } from "react";

export const Badge = (props: {
  readonly tone: string;
  readonly children: ReactNode;
  readonly title?: string;
}) => (
  <span className={`badge badge-${props.tone}`} title={props.title}>
    {props.children}
  </span>
);
