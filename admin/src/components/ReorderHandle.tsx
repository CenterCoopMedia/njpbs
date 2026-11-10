import { forwardRef } from "react";
import { Button, type ButtonProps } from "./ui/Primitives";
import { Icon } from "./ui/Icon";
import "./reorder-handle.css";

export const ReorderHandle = forwardRef<HTMLButtonElement, ButtonProps>(function ReorderHandle({ className = "", ...props }, ref) {
  return <Button variant="ghost" className={`reorder-handle ${className}`} {...props} ref={ref}><Icon name="grip" /></Button>;
});
