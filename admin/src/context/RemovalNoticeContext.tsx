import { createContext, useContext, type ReactNode } from "react";

// How a removal made deep inside a block's own surface reaches the editor that owns the history
// (#1035). A gallery image, a button, a card, and a chosen media asset are all removed by the
// inline editors, but the way back is the page-level undo stack, and the notice offering it
// belongs beside the page's other editing commands rather than inside whichever grid the item
// came from. The inline editor reports the name of what it removed; the block editor turns that
// into the visible notice and wires its Undo to the same stack the toolbar control uses.
//
// A context rather than a prop threaded through every inline surface: the surfaces are nested
// several deep (block card, surface, collection editor, image editor), the report is optional, and
// a component rendered on its own in a test or the design gallery must still work. The default is
// a no-op for exactly that reason.
export type RemovalReporter = (itemName: string) => void;

const ignoreRemoval: RemovalReporter = () => {};
const RemovalNoticeContext = createContext<RemovalReporter>(ignoreRemoval);

export function RemovalNoticeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: RemovalReporter;
}) {
  return (
    <RemovalNoticeContext.Provider value={value}>
      {children}
    </RemovalNoticeContext.Provider>
  );
}

// Report that an item was just removed, naming it the way `destructive-actions` names things
// ("image 2 “Newark skyline”"). Outside a provider this is a no-op, so an inline editor never has
// to know whether anything is listening.
export function useRemovalNotice(): RemovalReporter {
  return useContext(RemovalNoticeContext);
}

// An owning editor provides the shared undo action and claims removal focus.
// Standalone surfaces need their own adjacent-control fallback instead.
export function useRemovalNoticeAvailable(): boolean {
  return useContext(RemovalNoticeContext) !== ignoreRemoval;
}
