import { AudioLines } from "lucide-react";

export type MobileView = "encode" | "signal" | "receive" | "inspect";
export type ProtocolPage = "main" | "ggwave";
export interface WorkspaceProps {
  text: string;
  onTextChange: (text: string) => void;
  mobileView: MobileView;
  onViewChange: (view: MobileView) => void;
  onPageChange: (page: ProtocolPage) => void;
}

export const DEFAULT_MESSAGE = "你好，声织已就绪。";
const examples = [
  { label: "节点心跳", value: "NODE-A3|READY|7K2M" },
  { label: "设备配网", value: "SSID=FIELD_KIT;CHANNEL=6;PAIR=7K2M" },
  { label: "应急短讯", value: "位置已确认，补给点在 GRID-C4，收到请回复。" },
];

export function PageHeader({ page, disabled, onPageChange }: {
  page: ProtocolPage;
  disabled: boolean;
  onPageChange: (page: ProtocolPage) => void;
}) {
  return <header className="app-header workspace-header">
    <div className="brand-block">
      <span className="brand-mark" aria-hidden="true"><AudioLines size={25}/></span>
      <h1>SonaWeave</h1>
    </div>
    <div className="format-picker">
    <span className="format-label" aria-hidden="true">传输格式</span>
    <nav className="page-switch" aria-label="传输格式">
      <button type="button" data-testid="page-main" aria-current={page === "main" ? "page" : undefined}
        className={page === "main" ? "active" : ""} disabled={disabled} onClick={() => onPageChange("main")}>
        <span>FSK / DTMF</span>
      </button>
      <button type="button" data-testid="page-ggwave" aria-current={page === "ggwave" ? "page" : undefined}
        className={page === "ggwave" ? "active" : ""} disabled={disabled} onClick={() => onPageChange("ggwave")}>
        <span>ggwave</span>
      </button>
    </nav>
    </div>
  </header>;
}

export function QuickExamples({ disabled, onSelect }: { disabled: boolean; onSelect: (text: string) => void }) {
  return <label className="select-field quick-examples">
    <span>快速样例</span>
    <select data-testid="quick-examples" value="" disabled={disabled} onChange={event => {
      const example = examples.find(item => item.label === event.target.value);
      if (example) onSelect(example.value);
    }}>
      <option value="" disabled>选择消息</option>
      {examples.map(example => <option key={example.label} value={example.label}>{example.label}</option>)}
    </select>
  </label>;
}
