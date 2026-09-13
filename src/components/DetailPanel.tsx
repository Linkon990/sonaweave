import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, X } from "lucide-react";

export const COMPACT_VIEW = "(max-width: 760px), (max-width: 1100px) and (max-height: 550px)";

function useCompactView() {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_VIEW).matches);
  useEffect(() => {
    const query = window.matchMedia(COMPACT_VIEW);
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

/** Details remain inline on desktop; small screens open a bounded, focus-trapped sheet. */
export function DetailPanel({ title, children, className = "help-details", mobileOnly = false }: {
  title: string;
  children: ReactNode;
  className?: string;
  mobileOnly?: boolean;
}) {
  const compact = useCompactView();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (open && compact) element?.showModal();
    return () => {
      element?.querySelectorAll("audio").forEach(audio => audio.pause());
    };
  }, [open, compact]);
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);
  const close = () => dialog.current?.close();

  if (!compact) return mobileOnly ? <>{children}</> :
    <details className={className}><summary>{title}</summary>{children}</details>;
  return <>
    <button type="button" className={`detail-trigger ${mobileOnly ? "detail-prominent" : ""}`}
      aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span>{title}</span><ChevronRight size={16} aria-hidden="true"/>
    </button>
    {open && createPortal(<dialog ref={dialog} className="detail-dialog" aria-labelledby={titleId}
      onClose={() => {
        dialog.current?.querySelectorAll("audio").forEach(audio => audio.pause());
        setOpen(false);
      }} onClick={event => { if (event.target === dialog.current) close(); }}>
      <div className="detail-surface">
        <div className="detail-heading"><h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={close} autoFocus><X size={19}/></button>
        </div>
        <div className={`detail-content ${className}`} tabIndex={0}>{children}</div>
      </div>
    </dialog>, document.body)}
  </>;
}
