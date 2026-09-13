import { lazy, Suspense, useState } from "react";
import { flushSync } from "react-dom";
import LegacyApp from "./LegacyApp";
import { DEFAULT_MESSAGE, type MobileView, type ProtocolPage } from "./components/Workspace";
import { useWorkspaceViewport } from "./hooks/useWorkspaceViewport";
const GgWaveApp = lazy(() => import("./GgWaveApp"));
export default function App() {
  useWorkspaceViewport();
  const [page, setPage] = useState<ProtocolPage>("main");
  const [text, setText] = useState(DEFAULT_MESSAGE);
  const [mobileView, setMobileView] = useState<MobileView>("encode");
  const shared = { text, onTextChange: setText, mobileView, onViewChange: setMobileView,
    onPageChange: (next: ProtocolPage) => {
      if (next === page) return;
      const change = () => { flushSync(() => setPage(next)); window.scrollTo({ top: 0, behavior: "instant" }); };
      if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        document.startViewTransition(change);
      } else change();
    } };
  return <Suspense fallback={<p className="app-loading">正在打开…</p>}>
    {page === "main" ? <LegacyApp {...shared}/> : <GgWaveApp {...shared}/>}
  </Suspense>;
}
