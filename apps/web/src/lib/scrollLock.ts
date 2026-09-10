import { useEffect } from "react";

let activeLocks = 0;
let restoreDocument: (() => void) | null = null;

function acquireDocumentScrollLock(): () => void {
  if (activeLocks === 0) {
    const body = document.body;
    const root = document.documentElement;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previous = {
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
      bodyOverflow: body.style.overflow,
      rootOverflow: root.style.overflow,
      rootOverscrollBehavior: root.style.overscrollBehavior,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = `-${scrollX}px`;
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    restoreDocument = () => {
      body.style.position = previous.bodyPosition;
      body.style.top = previous.bodyTop;
      body.style.left = previous.bodyLeft;
      body.style.right = previous.bodyRight;
      body.style.width = previous.bodyWidth;
      body.style.overflow = previous.bodyOverflow;
      root.style.overflow = previous.rootOverflow;
      root.style.overscrollBehavior = previous.rootOverscrollBehavior;
      window.scrollTo(scrollX, scrollY);
    };
  }
  activeLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLocks = Math.max(0, activeLocks - 1);
    if (activeLocks !== 0) return;
    restoreDocument?.();
    restoreDocument = null;
  };
}

export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return undefined;
    return acquireDocumentScrollLock();
  }, [locked]);
}

export function useSelectPopupScrollGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;

    let previousTouchY: number | null = null;
    const popupScroller = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const popup = target.closest(".ant-select-dropdown");
      if (!popup) return null;
      return (
        target.closest<HTMLElement>(".rc-virtual-list-holder") ??
        popup.querySelector<HTMLElement>(".rc-virtual-list-holder") ??
        (popup as HTMLElement)
      );
    };
    const onTouchStart = (event: TouchEvent) => {
      if (!popupScroller(event.target)) return;
      previousTouchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const scroller = popupScroller(event.target);
      const currentTouchY = event.touches[0]?.clientY;
      if (!scroller || currentTouchY == null || previousTouchY == null) return;

      const movingDown = currentTouchY > previousTouchY;
      const movingUp = currentTouchY < previousTouchY;
      const atTop = scroller.scrollTop <= 0;
      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (
        scroller.scrollHeight <= scroller.clientHeight ||
        (movingDown && atTop) ||
        (movingUp && atBottom)
      ) {
        event.preventDefault();
      }
      event.stopPropagation();
      previousTouchY = currentTouchY;
    };
    const clearTouch = () => {
      previousTouchY = null;
    };

    document.addEventListener("touchstart", onTouchStart, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchmove", onTouchMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchend", clearTouch, true);
    document.addEventListener("touchcancel", clearTouch, true);
    return () => {
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      document.removeEventListener("touchend", clearTouch, true);
      document.removeEventListener("touchcancel", clearTouch, true);
    };
  }, [active]);
}
