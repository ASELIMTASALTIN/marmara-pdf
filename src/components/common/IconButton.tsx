import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { commandById } from "../../actions/commands";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  /** Command id whose shortcut is shown in the tooltip. */
  command?: string;
  active?: boolean;
  showLabel?: boolean;
  size?: number;
}

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon: Icon, label, command, active, showLabel, size = 18, className, ...rest },
  ref,
) {
  const shortcut = command ? commandById.get(command)?.shortcut : undefined;
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn${active ? " active" : ""}${showLabel ? " with-label" : ""}${className ? ` ${className}` : ""}`}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} />
      {showLabel && <span>{label}</span>}
    </button>
  );
});
