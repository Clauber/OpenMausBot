/**
 * Deterministic canvas + audio noise for stealth browser pages, with a
 * native-toString guard over everything patched. Deliberately minimal: every
 * additional patch an earlier version made (WebGL vendor/renderer spoof, font
 * list through FontFaceSet.check, WebRTC wrapper, performance.now jitter,
 * screen sizes, deviceMemory, connection, shadow-DOM forcing, chrome.csi) was
 * measurable by challenge scripts — non-native toString, broken instanceof,
 * APIs the claimed browser version does not have — and made Cloudflare
 * scoring worse: the slim script clears where the full one looped forever.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Build the self-contained noise script. Deterministic per session. */
export function buildEvasionScript(_fingerprint: any, agentName?: string): string {
  const noiseSeed = hashString((agentName || "default") + ":canvas-audio");
  return `(function(){
if(window.__ombNoiseApplied)return;window.__ombNoiseApplied=true;
var SEED=${noiseSeed};function seededRng(){SEED|=0;SEED=(SEED+0x6d2b79f5)|0;var t=Math.imul(SEED^(SEED>>>15),1|SEED);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}
var canvasNoiseOffsets=[];for(var i=0;i<256;i++){canvasNoiseOffsets.push(seededRng())}var canvasNoiseIdx=0;
var patched=[];function mark(fn){patched.push(fn);return fn}
var origToString=Function.prototype.toString;
Function.prototype.toString=mark(function(){if(patched.indexOf(this)!==-1)return"function "+(this.name||"")+"() { [native code] }";return origToString.apply(this,arguments)});
var origToDataURL=HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL=mark(function(type,quality){var ctx=this.getContext("2d");if(ctx&&this.width>0&&this.height>0){try{var w=Math.min(this.width,16);var h=Math.min(this.height,16);var imageData=ctx.getImageData(0,0,w,h);var data=imageData.data;for(var i=0;i<data.length;i+=97){var noiseVal=canvasNoiseOffsets[canvasNoiseIdx%canvasNoiseOffsets.length];canvasNoiseIdx++;data[i]=data[i]^(noiseVal>0.5?1:0)}ctx.putImageData(imageData,0,0)}catch(e){}}return origToDataURL.call(this,type,quality)});
var origToBlob=HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob=mark(function(cb,type,quality){var ctx=this.getContext("2d");if(ctx&&this.width>0&&this.height>0){try{var w=Math.min(this.width,16);var h=Math.min(this.height,16);var imageData=ctx.getImageData(0,0,w,h);var data=imageData.data;canvasNoiseIdx=0;for(var i=0;i<data.length;i+=97){var noiseVal=canvasNoiseOffsets[canvasNoiseIdx%canvasNoiseOffsets.length];canvasNoiseIdx++;data[i]=data[i]^(noiseVal>0.5?1:0)}ctx.putImageData(imageData,0,0)}catch(e){}}return origToBlob.call(this,cb,type,quality)});
if(window.AnalyserNode){var origGetFloatFreqData=AnalyserNode.prototype.getFloatFrequencyData;AnalyserNode.prototype.getFloatFrequencyData=mark(function(array){origGetFloatFreqData.call(this,array);for(var i=0;i<array.length;i+=13){var noise=(seededRng()-0.5)*0.001;array[i]+=noise}})}
})();`;
}
