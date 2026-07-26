import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import axios from "axios";
import { ensureBackendLink } from "./link";
import { BACKEND } from "./novaApi";

const IconEye = (props: any) => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...props}>
    <path fill="currentColor" d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z" />
  </svg>
);

const IconEyeOff = (props: any) => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...props}>
    <path
      fill="currentColor"
      d="M2 5.27 3.28 4 20 20.72 18.73 22l-3.2-3.2A11.58 11.58 0 0 1 12 19C5 19 2 12 2 12a18.85 18.85 0 0 1 4.1-5.57L2 5.27Zm8.83 3.54a4 4 0 0 1 4.36 4.36l-4.36-4.36ZM12 7c7 0 10 7 10 7a18.92 18.92 0 0 1-4.54 5.72l-1.42-1.42A11.83 11.83 0 0 0 20 12s-3-7-8-7a11.83 11.83 0 0 0-4.3.8l-1.5-1.5A13.68 13.68 0 0 1 12 7Z"
    />
  </svg>
);

interface Credentials {
  email: string;
  password: string;
}

export default function Login() {
  const navigate = useNavigate();
  const [form, setForm] = useState<Credentials>({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [link, setLink] = useState<"connecting" | "ready" | "failed">("connecting");
  const [linkDetail, setLinkDetail] = useState("Connecting to the game server…");

  // Bring the backend link up as soon as the login screen appears. Nothing here works until
  // 127.0.0.1:3551 is served — in P2P mode that means starting the local proxy first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const state = await ensureBackendLink();
      if (cancelled) return;
      setLink(state.ok ? "ready" : "failed");
      setLinkDetail(state.ok ? "Connected to the game server." : state.detail);
    })();
    return () => { cancelled = true; };
  }, []);

  const retryLink = async () => {
    setLink("connecting");
    setLinkDetail("Connecting to the game server…");
    const state = await ensureBackendLink();
    setLink(state.ok ? "ready" : "failed");
    setLinkDetail(state.ok ? "Connected to the game server." : state.detail);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const emailOk = /\S+@\S+\.\S+/.test(form.email);
    if (!emailOk) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);
    try {
      // The link may not be up yet (first launch, or the user hit Sign In quickly). Bring it up
      // rather than failing with a misleading credentials error.
      const state = await ensureBackendLink();
      if (!state.ok) {
        setLink("failed");
        setLinkDetail(state.detail);
        setError(state.detail);
        setLoading(false);
        return;
      }
      setLink("ready");

      // Authenticate with Project Nova backend
      const response = await axios.post(`${BACKEND}/account/api/oauth/token`,
        `grant_type=password&username=${encodeURIComponent(form.email)}&password=${encodeURIComponent(form.password)}`,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          }
        }
      );

      const data = response.data;
      if (!data.access_token || !data.account_id) {
        throw new Error("Invalid response from backend");
      }

      // Persist the SESSION (token + account) — never the plaintext password. The token is what
      // the launcher and game auth use; the backend's private-server oauth doesn't need the password.
      localStorage.setItem("user", JSON.stringify({
        email: form.email,
        accountId: data.account_id,
        token: data.access_token,
        displayName: data.displayName || form.email.split('@')[0],
      }));
      navigate("/onboard");
    } catch (err: any) {
      console.error("Login failed:", err);
      // Distinguish "the server said no" from "we never reached the server". Telling someone their
      // password is wrong when the real problem is connectivity sends them hunting for the wrong
      // thing — which is exactly what happened before this was split out.
      const status = err?.response?.status;
      if (status === 400 || status === 401 || status === 403) {
        setError("Wrong email or password.");
      } else if (status) {
        setError(`The game server rejected the sign-in (HTTP ${status}). Try again in a moment.`);
      } else {
        setLink("failed");
        setLinkDetail("Lost the connection to the game server.");
        setError("Couldn't reach the game server. Check your internet, then press Retry.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-screen h-screen relative overflow-hidden text-gray-100 bg-[#0b0c10] select-none">
      {/* BACKGROUND */}
      <div className="absolute inset-0">
        <img
          src="https://i.ibb.co/hx42Ndqt/fn.jpg"
          alt="Launcher Background"
          className="w-full h-full object-cover opacity-30 pointer-events-none"
          draggable={false}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-transparent pointer-events-none" />
      </div>

      {/* CENTERED LOGIN CARD */}
      <div className="relative flex flex-col items-center justify-center h-full pointer-events-auto">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-md bg-black/60 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl p-8"
        >
          <div className="flex flex-col items-center space-y-4 mb-6">
            {/* Custom Logo */}
            <img
              src="https://i.ibb.co/1GVGmGPh/logo.png"
              alt="Custom Logo"
              className="h-10"
              draggable={false}
            />
            <h1 className="text-2xl font-semibold tracking-wide">Sign In</h1>
            <p className="text-gray-400 text-sm">to continue to the launcher</p>

            {/* Connection state, so a connectivity problem never looks like a bad password. */}
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  link === "ready" ? "bg-emerald-400" : link === "failed" ? "bg-red-400" : "bg-amber-400 animate-pulse"
                }`}
              />
              <span className={link === "failed" ? "text-red-300" : "text-gray-400"}>{linkDetail}</span>
              {link === "failed" && (
                <button type="button" onClick={retryLink} className="ml-1 underline text-blue-300 hover:text-blue-200">
                  Retry
                </button>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="text-sm text-gray-300">Email</label>
              <input
                type="email"
                name="email"
                autoComplete="email"
                value={form.email}
                onChange={handleChange}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-lg bg-[#141414] border border-white/10 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-all"
              />
            </div>

            <div>
              <label className="text-sm text-gray-300">Password</label>
              <div className="relative mt-1">
                <input
                  type={showPw ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  value={form.password}
                  onChange={handleChange}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-[#141414] border border-white/10 px-4 py-3 pr-10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute inset-y-0 right-2 flex items-center px-2 rounded-lg hover:bg-white/5 transition"
                >
                  {showPw ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-500/10 border border-red-400/30 rounded-lg p-2">
                {error}
              </p>
            )}

            <motion.button
              type="submit"
              disabled={loading}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="w-full rounded-lg px-6 py-3 font-semibold text-white bg-gradient-to-r from-blue-700 to-blue-500 shadow-lg hover:from-blue-600 hover:to-blue-400 transition-all disabled:opacity-60"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                  >
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M4 12a8 8 0 018-8" />
                  </svg>
                  Logging in...
                </span>
              ) : (
                "Sign In"
              )}
            </motion.button>
          </form>

          <div className="mt-6 flex justify-between text-sm text-gray-400">
          </div>
        </motion.div>
      </div>
    </div>
  );
}
