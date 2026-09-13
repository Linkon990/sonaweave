#include "ggwave/ggwave.h"
#include <emscripten/bind.h>

// Configure once before creating any instance. Original protocol slots remain
// untouched, including the official three-frame Fastest waveform.
EMSCRIPTEN_BINDINGS(sonaweave_balanced_protocols) {
    emscripten::function("configureBalancedProtocols", emscripten::optional_override([]() {
        // Upstream's JS enum omits its mono-tone IDs. Start disabled so those
        // otherwise invisible receive protocols cannot remain enabled.
        GGWave::Protocols::rx().disableAll();
        auto normal = GGWave::Protocols::tx()[GGWAVE_PROTOCOL_AUDIBLE_NORMAL];
        normal.name = "SonaWeave 5 frames";
        normal.framesPerTx = 5;
        normal.freqStart = 41;
        auto fast = GGWave::Protocols::tx()[GGWAVE_PROTOCOL_AUDIBLE_FAST];
        fast.name = "SonaWeave 4 frames";
        fast.framesPerTx = 4;
        fast.freqStart = 45;
        GGWave::Protocols::tx()[GGWAVE_PROTOCOL_CUSTOM_0] = normal;
        GGWave::Protocols::rx()[GGWAVE_PROTOCOL_CUSTOM_0] = normal;
        GGWave::Protocols::tx()[GGWAVE_PROTOCOL_CUSTOM_1] = fast;
        GGWave::Protocols::rx()[GGWAVE_PROTOCOL_CUSTOM_1] = fast;
    }));
}
