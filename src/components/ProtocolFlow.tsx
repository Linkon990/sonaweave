import { ChevronRight, FileCode2, PackageCheck, Radio, ShieldCheck, Shrink } from "lucide-react";
import type { ModemMode } from "../core/modem";
import type { Transmission } from "../core/protocol";

interface ProtocolFlowProps {
  transmission?: Transmission;
  mode: ModemMode;
}

export function ProtocolFlow({ transmission, mode }: ProtocolFlowProps) {
  const stages = [
    {
      icon: FileCode2,
      label: "UTF-8",
      value: transmission ? `${transmission.rawBytes.length} B` : "文本",
    },
    {
      icon: Shrink,
      label: transmission?.compressed ? "LZW12" : "自适应",
      value: transmission ? `${transmission.payload.length} B` : "压缩",
    },
    {
      icon: PackageCheck,
      label: "SWP-1",
      value: transmission ? `${transmission.frame.length} B` : "成帧",
    },
    {
      icon: ShieldCheck,
      label: "SECDED",
      value: transmission ? `${transmission.protectedBytes.length} B` : "纠错",
    },
    {
      icon: Radio,
      label: mode.toUpperCase(),
      value: transmission ? `${transmission.signal.durationSeconds.toFixed(2)} s` : "调制",
    },
  ];

  return (
    <div className="protocol-flow" aria-label="编码处理流水线">
      {stages.map((stage, index) => {
        const Icon = stage.icon;
        return (
          <div className="flow-fragment" key={stage.label}>
            <div className="flow-stage">
              <Icon size={16} aria-hidden="true" />
              <span>
                <strong>{stage.label}</strong>
                <small>{stage.value}</small>
              </span>
            </div>
            {index < stages.length - 1 && <ChevronRight className="flow-arrow" size={16} aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}
