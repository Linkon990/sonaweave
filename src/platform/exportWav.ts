import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read WAV data"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to encode WAV data"));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export async function exportWav(blob: Blob, filename: string, browserUrl?: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    if (!browserUrl) throw new Error("WAV download URL is unavailable");
    const anchor = document.createElement("a");
    anchor.href = browserUrl;
    anchor.download = filename;
    anchor.click();
    return;
  }

  const savedFile = await Filesystem.writeFile({
    path: `exports/${filename}`,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });

  await Share.share({
    title: "SonaWeave WAV",
    text: "SonaWeave 声波数据链路音频",
    url: savedFile.uri,
    dialogTitle: "导出 WAV",
  });
}
