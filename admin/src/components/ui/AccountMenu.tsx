import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "./Icon";
import { AuthorAvatar } from "./AuthorAvatar";
import type { AuthorPhoto } from "../../lib/functions";
import { isMenuNavigationKey, nextMenuIndex } from "../../lib/menu-navigation";

// The signed-in person's own menu: profile, settings, sign out.
//
// This is the WAI-ARIA menu button pattern, not a div that reveals links on click. The
// avatar used to be inert markup, so a keyboard user had no way to reach these actions
// from one place. The pattern's obligations are all met here: the control says it opens a
// menu and whether it is open, opening moves focus into the menu, the arrow keys move
// between items with wrapping, Escape closes and puts focus back where it started, a
// pointer down outside closes without stealing focus, and Tab leaves rather than trapping.
//
// The open state is controlled by the caller because the shell already closes its popovers
// on navigation; one owner of "is it open" is better than a second, competing one.

export interface AccountMenuItem {
  key: string;
  label: string;
  icon?: IconName;
  /** A destination item. Mutually exclusive with onSelect. */
  to?: string;
  /** An action item, run before the menu closes. */
  onSelect?: () => void;
}

export interface AccountMenuProps {
  displayName: string;
  email: string;
  /** The signed-in person's stored photograph, with its crop. */
  photo?: Pick<AuthorPhoto, "url" | "focalX" | "focalY"> | null;
  /** Escape hatch for a resolved URL with no stored crop. */
  photoUrl?: string | null;
  items: AccountMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}

export function AccountMenu({
  displayName,
  email,
  photo = null,
  photoUrl = null,
  items,
  open,
  onOpenChange,
  className,
}: AccountMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const generatedId = useId();
  const toggleId = `${generatedId}-account-menu-button`;
  const menuId = `${generatedId}-account-menu`;

  // Focus follows the active item while the menu is open. Running it on every open and
  // every move keeps one rule for entry and movement, so a menu opened by ArrowUp lands on
  // the last item without a second code path.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;

    function closeWhenOutside(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || !event.composedPath().includes(root)) {
        // No focus return here on purpose: the pointer has already chosen where
        // attention goes, and pulling focus back to the avatar would fight it.
        onOpenChange(false);
      }
    }

    document.addEventListener("pointerdown", closeWhenOutside);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
    };
  }, [open, onOpenChange]);

  function closeAndReturnFocus() {
    onOpenChange(false);
    toggleRef.current?.focus();
  }

  function openAt(index: number) {
    setActiveIndex(index);
    onOpenChange(true);
  }

  function onToggleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    openAt(event.key === "ArrowDown" ? 0 : items.length - 1);
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndReturnFocus();
      return;
    }
    // Tab is a deliberate exit, not a trap: close and let the browser move on.
    if (event.key === "Tab") {
      onOpenChange(false);
      return;
    }
    if (!isMenuNavigationKey(event.key)) return;
    const next = nextMenuIndex(event.key, activeIndex, items.length);
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
  }

  return (
    <div className={className ? `account-menu ${className}` : "account-menu"} ref={rootRef}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${displayName}`}
        className="account-menu-toggle"
        id={toggleId}
        onClick={() => (open ? onOpenChange(false) : openAt(0))}
        onKeyDown={onToggleKeyDown}
        ref={toggleRef}
        type="button"
      >
        <AuthorAvatar displayName={displayName} photo={photo} photoUrl={photoUrl} />
        <span className="account-copy">
          <strong>{displayName}</strong>
          <span>{email}</span>
        </span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      <div
        aria-labelledby={toggleId}
        className="account-menu-panel"
        hidden={!open}
        id={menuId}
        onKeyDown={onMenuKeyDown}
        role="menu"
      >
        {/* The person's own name and address head the menu. In the rail the toggle is an avatar
            alone, so without this the answer to "which account am I in?" is nowhere on screen.
            It is not a menu item: the items keep their roving focus and count, but the text stays
            in the accessibility tree because a screen-reader user needs the address too. */}
        <div className="account-menu-identity" role="presentation">
          <strong>{displayName}</strong>
          <span>{email}</span>
        </div>
        {items.map((item, index) => {
          const shared = {
            className: "account-menu-item",
            role: "menuitem",
            tabIndex: index === activeIndex ? 0 : -1,
            onFocus: () => setActiveIndex(index),
          } as const;
          const contents = (
            <>
              {item.icon ? <Icon name={item.icon} /> : null}
              <span>{item.label}</span>
            </>
          );

          return item.to ? (
            <Link
              {...shared}
              key={item.key}
              onClick={() => onOpenChange(false)}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              to={item.to}
            >
              {contents}
            </Link>
          ) : (
            <button
              {...shared}
              key={item.key}
              onClick={() => {
                item.onSelect?.();
                closeAndReturnFocus();
              }}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
            >
              {contents}
            </button>
          );
        })}
      </div>
    </div>
  );
}
