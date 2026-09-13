// Runs on the audio render thread. The output stays silent: received audio must
// never be played back into the microphone. Messages contain uncompressed PCM.
class SonaWeavePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.offset = 0;
    this.selectedChannel = null;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush") return;
      this.flush();
      this.stopped = true;
      this.port.postMessage({ type: "flushed" });
    };
  }

  flush() {
    if (!this.offset) return;
    // Never average microphone channels: a stereo array can have opposite
    // polarities. Lock once audible input arrives, avoiding phase jumps later.
    if (this.selectedChannel === null || this.selectedChannel >= this.buffers.length) {
      let strongest = 0;
      let strongestEnergy = 0;
      for (let channel = 0; channel < this.buffers.length; channel += 1) {
        let energy = 0;
        for (let index = 0; index < this.offset; index += 1) energy += this.buffers[channel][index] ** 2;
        if (energy > strongestEnergy) { strongest = channel; strongestEnergy = energy; }
      }
      this.selectedChannel = strongestEnergy > this.offset * 1e-10 ? strongest : null;
    }
    const selectedChannel = this.selectedChannel ?? 0;
    const samples = this.buffers[selectedChannel].slice(0, this.offset);
    this.port.postMessage({ samples, selectedChannel, observedChannels: this.buffers.length }, [samples.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (channels?.length) {
      if (channels.length !== this.buffers.length) {
        this.flush();
        this.buffers = channels.map(() => new Float32Array(2048));
      }
      for (let index = 0; index < channels[0].length; index += 1) {
        for (let channel = 0; channel < channels.length; channel += 1) {
          this.buffers[channel][this.offset] = channels[channel][index];
        }
        this.offset += 1;
        if (this.offset === 2048) this.flush();
      }
    }
    return true;
  }
}

registerProcessor("sonaweave-pcm", SonaWeavePcmProcessor);
