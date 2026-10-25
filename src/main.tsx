import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  BROWSER_SIGN_IN_FAILED, previewBrowserSignIn, readSessionBootstrap, SERVICE_TRUST_REASON, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applySkin, readSkin } from "./lib/skins";
import { applyChatWidth, readChatWidth } from "./lib/chat-width";
import { applyFont, readFont } from "./lib/fonts";
import { ensureCustomSkinStyles, readCustomSkinsCache } from "./lib/custom-skins";
import { settleAdvancedModeDefault } from "./lib/interface-mode";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage } from "./pair/PairPage";
import { HomeScreen, SignedOutAtHome } from "./components/HomeScreen";
import "./styles.css";

// Before first paint; settleAdvancedModeDefault must run before applySkin writes omb-skin.
settleAdvancedModeDefault();
// A custom skin's CSS block must exist before the attribute names it, or the
// first paint falls back to the default palette. The cache mirrors the
// server's collection from the last run; the store refreshes both moments later.
ensureCustomSkinStyles(readCustomSkinsCache());
applySkin(readSkin());
applyFont(readFont());
applyChatWidth(readChatWidth());

// Consume link secrets once, before rendering; keep them for Retry and StrictMode.
const signIn = location.pathname === "/pair" ? takeBrowserSignInFromLocation() : null;
const pairingCode = location.pathname === "/pair" && !signIn ? takePairingCodeFromLocation() : null;
const invitedEmail = location.pathname === "/pair" && !signIn ? takeInvitedEmailFromLocation() : null;

async function chooseRoot(): Promise<React.ReactNode> {
  const home = window.ogb?.home;
  if (location.pathname === "/home" && home) return <HomeScreen bridge={home} manage={window.ogb?.cloudPlan?.manage} />;
  if (location.pathname === "/pair") {
    if (signIn) {
      const preview = await previewBrowserSignIn(signIn);
      if (!preview) throw new Error(BROWSER_SIGN_IN_FAILED);
      return <BrowserSignInPage credential={signIn} owner={preview.owner} />;
    }
    return <PairPage initialCode={pairingCode} initialEmail={invitedEmail} />;
  }
  const { session, body } = await readSessionBootstrap();
  if (session.kind === "unreachable") throw new Error(session.error);
  if (session.kind === "unauthenticated") {
    const pair = <PairPage initialCode={null} reason={session.error} />;
    return home ? <SignedOutAtHome bridge={home} fallback={pair} /> : pair;
  }
  if (session.kind === "loopback" && session.trust === "service") return <PairPage initialCode={null} reason={SERVICE_TRUST_REASON} />;
  if (location.pathname === "/desktop-viewer") {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    return <DesktopViewer />;
  }
  return <App initialSession={body} />;
}

function Bootstrap() {
  const [root, setRoot] = useState<React.ReactNode>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<Promise<React.ReactNode> | null>(null);
  useEffect(() => {
    let active = true;
    // Reuse StrictMode's in-flight probe, including a single sign-in preview.
    pending.current ??= Promise.all([bootstrapBrand(), chooseRoot()]).then(([, chosen]) => chosen);
    void pending.current.then((chosen) => {
      if (active) setRoot(chosen);
    }, (cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [attempt]);
  if (root) return root;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-app p-6 text-ink">
      <div className="w-full max-w-sm text-center">
        <p role={error ? "alert" : "status"} className="text-[14px] text-ink-secondary">
          {error ? `Could not open the app. ${error}` : "Opening the app…"}
        </p>
        {error && <button className="mt-5 rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink" onClick={() => {
          pending.current = null;
          setError(null);
          setAttempt((value) => value + 1);
        }}>Retry</button>}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Bootstrap /></StrictMode>);
