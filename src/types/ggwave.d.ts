declare module "ggwave" {
  export interface GgWaveEnumValue { readonly value: number }

  export interface GgWaveParameters {
    payloadLength: number;
    sampleRateInp: number;
    sampleRateOut: number;
    sampleRate: number;
    samplesPerFrame: number;
    soundMarkerThreshold: number;
    sampleFormatInp: GgWaveEnumValue;
    sampleFormatOut: GgWaveEnumValue;
    operatingMode: number;
  }

  export interface GgWaveModule {
    ProtocolId: Record<string, GgWaveEnumValue>;
    SampleFormat: Record<string, GgWaveEnumValue>;
    GGWAVE_OPERATING_MODE_RX: number;
    GGWAVE_OPERATING_MODE_TX: number;
    getDefaultParameters(): GgWaveParameters;
    init(parameters: GgWaveParameters): number;
    free(instance: number): void;
    encode(instance: number, data: string | Uint8Array, protocol: GgWaveEnumValue, volume: number): Int8Array;
    decode(instance: number, pcmBytes: Int8Array): Int8Array;
    disableLog(): void;
    rxToggleProtocol(protocol: GgWaveEnumValue, enabled: number): void;
  }

  export default function createGgWave(options?: {
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }): Promise<GgWaveModule>;
}

declare module "ggwave-balanced" {
  import type { GgWaveModule } from "ggwave";
  interface BalancedGgWaveModule extends GgWaveModule {
    configureBalancedProtocols(): void;
  }
  export default function createGgWave(options?: {
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }): Promise<BalancedGgWaveModule>;
}
