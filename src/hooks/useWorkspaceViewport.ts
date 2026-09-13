import { useEffect } from "react";

/** Follow the visible viewport, including Android resize and browser keyboard panning. */
export function useWorkspaceViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let fullHeight = window.innerHeight;
    let width = window.innerWidth;
    const update = () => {
      const editing = document.activeElement instanceof HTMLTextAreaElement ||
        (document.activeElement instanceof HTMLInputElement && !["range", "checkbox", "file"].includes(document.activeElement.type));
      const height = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
      if (Math.abs(width - window.innerWidth) > 80 || !editing) fullHeight = window.innerHeight;
      width = window.innerWidth;
      fullHeight = Math.max(fullHeight, window.innerHeight);
      root.style.setProperty("--workspace-height", `${height}px`);
      root.style.setProperty("--workspace-top", `${viewport?.offsetTop ?? 0}px`);
      root.dataset.keyboard = String(editing && navigator.maxTouchPoints > 0 && fullHeight - height > 120);
    };
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      root.style.removeProperty("--workspace-height");
      root.style.removeProperty("--workspace-top");
      delete root.dataset.keyboard;
    };
  }, []);
}
