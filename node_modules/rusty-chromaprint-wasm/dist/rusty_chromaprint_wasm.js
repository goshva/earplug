/* @ts-self-types="./rusty_chromaprint_wasm.d.ts" */

import * as wasm from "./rusty_chromaprint_wasm_bg.wasm";
import { __wbg_set_wasm } from "./rusty_chromaprint_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    FingerprintFromSamplesResult, Fingerprinter, MatchFingerprintsResult, MatchSegment, fingerprintFromSamples, matchFingerprints
} from "./rusty_chromaprint_wasm_bg.js";
