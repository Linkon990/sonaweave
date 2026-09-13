import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export async function exportDiagnostic(data: object, filename: string) {
  const content = JSON.stringify(data, null, 2);
  if (Capacitor.isNativePlatform()) {
    const bytes = new TextEncoder().encode(content);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const file = await Filesystem.writeFile({ path: `exports/${filename}`, directory: Directory.Cache, data: btoa(binary), recursive: true });
    await Share.share({ title: "SonaWeave 接收诊断", url: file.uri, dialogTitle: "导出诊断" });
  } else {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    try {
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1_000); }
  }
}
