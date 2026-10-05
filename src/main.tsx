import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  BROWSER_SIGN_IN_FAILED, previewBrowserSignIn, readSessionBootstrap, SERVICE_TRUST_REASON, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applySkin, readSkin } from "./lib/skins";
import { applyFont, readFont } from "./lib/fonts";
import { settleAdvancedModeDefault } from "./lib/interface-mode";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage } from "./pair/PairPage";
import "katex/dist/katex.min.css";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first. Brand and session
// requests start after the bootstrap surface mounts.
// Simple vs Advanced is decided first: applySkin below writes omb-skin, which
// would otherwise make every fresh install look like an existing one.
settleAdvancedModeDefault();
applySkin(readSkin());
applyFont(readFont());

/** A pairing link lands on /pair. A remote browser without a session lands
 * there too, because every API call would otherwise fail with "pair this
 * device"; on the owner's own machine the server trusts loopback and this
 * check is a single fast request. */
// Consume link secrets once, before rendering; keep them for Retry and StrictMode.
const signIn = location.pathname === "/pair" ? takeBrowserSignInFromLocation() : null;
const pairingCode = location.pathname === "/pair" && !signIn ? takePairingCodeFromLocation() : null;
const invitedEmail = location.pathname === "/pair" && !signIn ? takeInvitedEmailFromLocation() : null;

async function chooseRoot(): Promise<React.ReactNode> {
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
  if (session.kind === "unauthenticated") return <PairPage initialCode={null} reason={session.error} />;
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
