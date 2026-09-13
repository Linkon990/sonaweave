import type { GgWaveModule } from "ggwave";

export interface BalancedGgWaveModule extends GgWaveModule {
  /** Call once before init; sets custom 5/4-frame slots and clears RX toggles. */
  configureBalancedProtocols(): void;
}

export default function createGgWave(options?: {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}): Promise<BalancedGgWaveModule>;
