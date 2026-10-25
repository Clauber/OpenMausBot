/**
 * Advanced fingerprint evasions.
 *
 * Extends the base fingerprint-suite (navigator/screen/UA) with:
 * - WebGL vendor/renderer spoofing matching the fingerprint's claimed OS
 * - Font list spoofing matching the fingerprint's claimed OS
 * - Deterministic canvas/audio noise seeded per-agent (consistent hash across sessions)
 *
 * Usage:
 *   const script = buildEvasionScript(fingerprint, agentName);
 *   attachEvasions(page, script);   // sets up route-based injection
 */

import type { Page } from "patchright";

// --- WebGL profiles per OS ---
const WEBGL_PROFILES: Record<string, { vendor: string; renderer: string }[]> = {
  macos: [
    { vendor: "Apple Inc.", renderer: "Apple M1" },
    { vendor: "Apple Inc.", renderer: "Apple M2" },
    { vendor: "Apple Inc.", renderer: "Apple M3" },
    { vendor: "Apple Inc.", renderer: "Apple GPU" },
    { vendor: "Intel Inc.", renderer: "Intel Iris OpenGL Engine" },
  ],
  windows: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x0000A780) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  ],
  linux: [
    { vendor: "Mesa", renderer: "Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2)" },
    { vendor: "Mesa", renderer: "Mesa Intel(R) UHD Graphics 770 (RPL-S)" },
    { vendor: "AMD", renderer: "AMD Radeon RX 6700 XT (navi22, LLVM 15.0.7)" },
  ],
};

// --- Font lists per OS ---
const FONT_LISTS: Record<string, string[]> = {
  macos: [
    "Arial", "Arial Black", "Arial Narrow", "Arial Rounded MT Bold",
    "Avenir", "Avenir Next", "Avenir Next Condensed",
    "Baskerville", "Big Caslon", "Bodoni 72",
    "Bradley Hand", "Brush Script MT",
    "Chalkboard", "Chalkduster", "Charter",
    "Cochin", "Comic Sans MS", "Copperplate",
    "Courier", "Courier New",
    "DIN Alternate", "DIN Condensed",
    "Futura", "Geneva", "Georgia",
    "Gill Sans", "Helvetica", "Helvetica Neue",
    "Herculanum", "Hoefler Text",
    "Impact", "Iowan Old Style", "Lucida Grande",
    "Luminari", "Marker Felt", "Menlo", "Monaco",
    "Noteworthy", "Optima", "Palatino",
    "Papyrus", "Phosphate", "Rockwell",
    "SF Pro Display", "SF Pro Text", "SF Mono",
    "Savoye LET", "SignPainter", "Skia",
    "Snell Roundhand", "Tahoma", "Times", "Times New Roman",
    "Trebuchet MS", "Verdana", "Zapfino",
  ],
  windows: [
    "Arial", "Arial Black", "Arial Narrow", "Arial Rounded MT Bold",
    "Bahnschrift", "Baskerville Old Face",
    "Batang", "BatangChe",
    "Calibri", "Calibri Light", "Cambria", "Cambria Math",
    "Candara", "Candara Light", "Century", "Century Gothic",
    "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Corbel Light",
    "Courier", "Courier New",
    "Ebrima", "Franklin Gothic Medium",
    "Gabriola", "Gadugi",
    "Georgia",
    "Impact",
    "Ink Free",
    "Javanese Text",
    "Leelawadee UI", "Leelawadee UI Semilight",
    "Lucida Console", "Lucida Handwriting", "Lucida Sans", "Lucida Sans Unicode",
    "Malgun Gothic", "Malgun Gothic Semilight",
    "Microsoft Sans Serif", "Microsoft YaHei", "Microsoft Yi Baiti",
    "MingLiU-ExtB",
    "Mongolian Baiti",
    "MS Gothic", "MS PGothic", "MS UI Gothic",
    "MV Boli",
    "Nirmala UI", "Nirmala UI Semilight",
    "Palatino Linotype",
    "Segoe MDL2 Assets", "Segoe Print", "Segoe Script",
    "Segoe UI", "Segoe UI Black", "Segoe UI Emoji", "Segoe UI Historic", "Segoe UI Semibold", "Segoe UI Semilight", "Segoe UI Symbol",
    "SimSun", "SimSun-ExtB",
    "Sitka Banner", "Sitka Display", "Sitka Heading", "Sitka Small", "Sitka Subheading", "Sitka Text",
    "Sylfaen",
    "Tahoma",
    "Times New Roman",
    "Trebuchet MS",
    "Verdana",
    "Webdings",
    "Wingdings", "Wingdings 2", "Wingdings 3",
    "Yu Gothic", "Yu Gothic UI", "Yu Gothic UI Semibold", "Yu Gothic UI Semilight", "Yu Mincho",
  ],
  linux: [
    "Arial", "Bitstream Charter", "Bitstream Vera Sans", "Bitstream Vera Sans Mono", "Bitstream Vera Serif",
    "Carlito", "Cantarell", "Courier", "Courier 10 Pitch", "Courier New",
    "DejaVu Sans", "DejaVu Sans Condensed", "DejaVu Sans Mono", "DejaVu Serif", "DejaVu Serif Condensed",
    "Droid Sans", "Droid Sans Mono",
    "FreeMono", "FreeSans", "FreeSerif",
    "GNU Unifat",
    "Khmer OS", "Khmer OS System",
    "Liberation Mono", "Liberation Sans", "Liberation Serif",
    "Linux Libertine",
    "Lohit Bengali", "Lohit Devanagari", "Lohit Tamil",
    "Noto Color Emoji", "Noto Mono", "Noto Sans", "Noto Sans Arabic", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans CJK SC", "Noto Sans CJK TC",
    "Noto Serif", "Noto Serif CJK JP", "Noto Serif CJK KR", "Noto Serif CJK SC", "Noto Serif CJK TC",
    "OpenSymbol",
    "Padauk",
    "Pothana 2000",
    "Sahadeva",
    "Sans", "Serif", "monospace",
    "Tibetan Machine Uni",
    "TlwgMono", "TlwgTypewriter", "Tlwg Typist", "Tlwg Typo",
    "URW Bookman", "URW Chancery", "URW Gothic", "URW Palladio",
    "Utopia",
    "Verdana",
    "Waree",
    "Z003",
  ],
};

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return Math.abs(hash);
}

function detectOS(fingerprint: any): string {
  const ua = (fingerprint?.navigator?.userAgent || "").toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "macos";
}

/**
 * Build a self-contained JS string with all fingerprint evasions.
 */
export function buildEvasionScript(fingerprint: any, agentName?: string): string {
  const os = detectOS(fingerprint);
  const profiles = WEBGL_PROFILES[os] || WEBGL_PROFILES.macos;
  const fonts = FONT_LISTS[os] || FONT_LISTS.macos;

  const seed = hashString(agentName || fingerprint?.navigator?.userAgent || "default");
  const rng = mulberry32(seed);
  const webglProfile = profiles[Math.floor(rng() * profiles.length)];

  const fontSet = JSON.stringify(fonts);
  const noiseSeed = hashString((agentName || "default") + ":canvas-audio");
  const webglVendor = JSON.stringify(webglProfile.vendor);
  const webglRenderer = JSON.stringify(webglProfile.renderer);

  return `(function(){var SEED=${noiseSeed};function seededRng(){SEED|=0;SEED=(SEED+0x6d2b79f5)|0;var t=Math.imul(SEED^(SEED>>>15),1|SEED);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}var canvasNoiseOffsets=[];for(var i=0;i<256;i++){canvasNoiseOffsets.push(seededRng())}var canvasNoiseIdx=0;var WEBGL_VENDOR=${webglVendor};var WEBGL_RENDERER=${webglRenderer};var UNMASKED_VENDOR_WEBGL=0x9245;var UNMASKED_RENDERER_WEBGL=0x9246;var VENDOR_WEBGL=0x1F00;var RENDERER_WEBGL=0x1F01;function spoofGetParameter(proto){if(!proto||!proto.getParameter)return;var orig=proto.getParameter;proto.getParameter=function(param){if(param===UNMASKED_VENDOR_WEBGL)return WEBGL_VENDOR;if(param===UNMASKED_RENDERER_WEBGL)return WEBGL_RENDERER;if(param===VENDOR_WEBGL)return WEBGL_VENDOR;if(param===RENDERER_WEBGL)return WEBGL_RENDERER;if(param===0x8872)return 16;if(param===0x8B4C)return 16;if(param===0x8B4D)return 32;return orig.apply(this,arguments)};if(proto.getExtension){var origGetExt=proto.getExtension;proto.getExtension=function(name){if(name==='WEBGL_debug_renderer_info'){return{UNMASKED_VENDOR_WEBGL:UNMASKED_VENDOR_WEBGL,UNMASKED_RENDERER_WEBGL:UNMASKED_RENDERER_WEBGL}}return origGetExt.apply(this,arguments)}}}if(typeof WebGLRenderingContext!=='undefined'){spoofGetParameter(WebGLRenderingContext.prototype)}if(typeof WebGL2RenderingContext!=='undefined'){spoofGetParameter(WebGL2RenderingContext.prototype)}var SPOOFED_FONTS=${fontSet};var fontCheckMap={};SPOOFED_FONTS.forEach(function(f){fontCheckMap[f.toLowerCase()]=true});if(window.FontFaceSet&&window.FontFaceSet.prototype){var origFontCheck=window.FontFaceSet.prototype.check;window.FontFaceSet.prototype.check=function(font,text){var fontFamily=(font||'').trim().toLowerCase();var tokens=fontFamily.split(/[\\s,]+/);var family=tokens.length>0?tokens[tokens.length-1]:'';var quoted=font.match(/["']([^"']+)["']/);if(quoted)family=quoted[1].toLowerCase();if(['serif','sans-serif','monospace','cursive','fantasy','system-ui'].indexOf(family)!==-1){return origFontCheck?origFontCheck.apply(this,arguments):true}return!!fontCheckMap[family]}}var origToDataURL=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(type,quality){var ctx=this.getContext("2d");if(ctx&&this.width>0&&this.height>0){try{var w=Math.min(this.width,16);var h=Math.min(this.height,16);var imageData=ctx.getImageData(0,0,w,h);var data=imageData.data;for(var i=0;i<data.length;i+=97){var noiseVal=canvasNoiseOffsets[canvasNoiseIdx%canvasNoiseOffsets.length];canvasNoiseIdx++;data[i]=data[i]^(noiseVal>0.5?1:0)}ctx.putImageData(imageData,0,0)}catch(e){}}return origToDataURL.call(this,type,quality)};var origToBlob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(cb,type,quality){var ctx=this.getContext("2d");if(ctx&&this.width>0&&this.height>0){try{var w=Math.min(this.width,16);var h=Math.min(this.height,16);var imageData=ctx.getImageData(0,0,w,h);var data=imageData.data;canvasNoiseIdx=0;for(var i=0;i<data.length;i+=97){var noiseVal=canvasNoiseOffsets[canvasNoiseIdx%canvasNoiseOffsets.length];canvasNoiseIdx++;data[i]=data[i]^(noiseVal>0.5?1:0)}ctx.putImageData(imageData,0,0)}catch(e){}}return origToBlob.call(this,cb,type,quality)};var origCreateOscillator=(window.AudioContext&&window.AudioContext.prototype&&window.AudioContext.prototype.createOscillator)||(window.webkitAudioContext&&window.webkitAudioContext.prototype&&window.webkitAudioContext.prototype.createOscillator);if(origCreateOscillator){var origGetFloatFreqData=AnalyserNode.prototype.getFloatFrequencyData;AnalyserNode.prototype.getFloatFrequencyData=function(array){origGetFloatFreqData.call(this,array);for(var i=0;i<array.length;i+=13){var noise=(seededRng()-0.5)*0.001;array[i]+=noise}}}var origRTC=window.RTCPeerConnection;if(origRTC){window.RTCPeerConnection=function(config){return new origRTC(Object.assign({},config,{iceServers:[]}))};window.RTCPeerConnection.prototype=origRTC.prototype}window.webkitRTCPeerConnection=undefined;window.mozRTCPeerConnection=undefined;var origPerfNow=performance.now.bind(performance);var lastNow=origPerfNow();performance.now=function(){var real=origPerfNow();var jitter=seededRng()*0.1;lastNow=real+jitter;return lastNow};Object.defineProperty(screen,"availWidth",{get:function(){return window.innerWidth}});Object.defineProperty(screen,"availHeight",{get:function(){return window.innerHeight}});try{Object.defineProperty(navigator,'deviceMemory',{get:function(){return 8}})}catch(e){}if('connection'in navigator){try{Object.defineProperty(navigator,'connection',{get:function(){return{effectiveType:'4g',rtt:50,downlink:10,saveData:false}}})}catch(e){}}if('Notification'in window){try{Object.defineProperty(Notification,'permission',{get:function(){return'default'}})}catch(e){}}var origAttachShadow=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){return origAttachShadow.call(this,Object.assign({},init,{mode:'open'}))};if(!window.chrome)window.chrome={};if(!window.chrome.csi){window.chrome.csi=function(){return{startE:Date.now(),onloadT:Date.now(),pageT:seededRng()*1000+200,tran:15}}}if(!window.chrome.loadTimes){window.chrome.loadTimes=function(){var now=Date.now()/1000;return{requestTime:now,startLoadTime:now,firstPaintTime:now+seededRng()*0.5,firstPaintAfterLoadTime:0,navigationType:'navigate',wasFetchedViaSpdy:true,wasNpnNegotiated:true,npnNegotiatedProtocol:'h2',wasAlternateProtocolAvailable:false,connectionInfo:'h2'}}}})();\n`;
}

/**
 * Attach evasion script to a page.
 *
 * Patchright's addInitScript and route.fulfill don't execute inline scripts.
 * Instead we use page.evaluate() to inject our overrides immediately after
 * each navigation, triggered by the 'framenavigated' event.
 *
 * This runs our script before DOMContentLoaded fires, which is when fingerprint
 * detection scripts typically run their checks.
 *
 * MUST be called BEFORE page.goto() so the listener catches the first navigation.
 */
export async function attachEvasions(page: Page, evasionScript: string): Promise<void> {
  // Inject on every main-frame navigation
  page.on("framenavigated", async (frame) => {
    // Only inject in main frame, skip about:blank
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === "about:blank" || url.startsWith("data:")) return;
    try {
      await frame.evaluate(evasionScript);
    } catch {
      // Frame may have been destroyed or navigation interrupted; ignore
    }
  });
}
