// src/screens/SignIn.tsx
// One screen, two modes. Signing in and signing up are the same shape, so switching between them
// moves a field rather than replacing the page — the eye keeps its place.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button, Field } from "../ui/primitives";
import { Mark } from "../ui/Mark";
import { tween, tweenExit } from "../motion";
import { useToast } from "../ui/toast";
import { register, login, checkAvailability, saveSession, type AuthError } from "../auth";

type Mode = "signin" | "signup";

export default function SignIn() {
  const navigate = useNavigate();
  const { notify } = useToast();

  const [mode, setMode] = useState<Mode>("signin");
  const [busy, setBusy] = useState(false);

  const [loginId, setLoginId] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [errors, setErrors] = useState<Partial<Record<AuthError["field"], string>>>({});
  const [free, setFree] = useState<{ username?: boolean; email?: boolean }>({});

  // `| null` in the type parameter, not just the initial value — otherwise TS hands back a
  // RefObject whose `current` is readonly, and the callback refs below can't write to it.
  const firstField = useRef<HTMLInputElement | null>(null);
  // Keeps a handle on each input so a rejected submit can put the cursor in the box that was wrong,
  // instead of leaving someone to hunt for the red text themselves.
  const fields = useRef<Partial<Record<AuthError["field"], HTMLInputElement | null>>>({});
  useEffect(() => { firstField.current?.focus(); }, [mode]);

  const clearError = (field: AuthError["field"]) =>
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));

  /* Live uniqueness check on blur.
     On blur rather than on every keystroke: telling someone their username is taken while they are
     still halfway through typing it is noise, and it fires a request per character. */
  const checkField = useCallback(async (which: "username" | "email", value: string) => {
    if (mode !== "signup" || !value.trim()) return;
    const res = await checkAvailability({ [which]: value.trim() });
    const r = res[which];
    if (!r) return;
    setFree((f) => ({ ...f, [which]: r.available }));
    if (!r.available) {
      setErrors((e) => ({
        ...e,
        [which]: r.message ?? (which === "username"
          ? "This username is already in use."
          : "This email is already registered."),
      }));
    }
  }, [mode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErrors({});
    setBusy(true);

    const result = mode === "signin"
      ? await login(loginId.trim(), password)
      : await register(username.trim(), email.trim(), password);

    setBusy(false);

    if (!result.ok) {
      // Mark the field that's actually wrong. A network failure has no field, so it becomes a
      // notification instead of hanging an error off an input the player typed correctly.
      if (result.error.field === "network") {
        notify({ kind: "error", title: "Can’t reach Project Nova", body: result.error.message });
      } else {
        setErrors({ [result.error.field]: result.error.message });
        // Move the cursor to the offending field. The error is announced by role="alert" either
        // way, but landing in the box you have to change is what actually saves the next step.
        fields.current[result.error.field]?.focus();
      }
      return;
    }

    saveSession(result.session);
    notify({
      kind: "success",
      title: mode === "signup" ? `Welcome to Nova, ${result.session.username}` : `Welcome back, ${result.session.username}`,
      body: mode === "signup" ? "Your Fortnite account is linked and ready." : undefined,
    });
    navigate("/play");
  };

  const swap = (next: Mode) => {
    setMode(next);
    setErrors({});
    setFree({});
    setPassword("");
  };

  return (
    <div className="ambient h-full w-full grid place-items-center px-6 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={tween}
        className="relative z-10 w-full max-w-[22rem] py-10"
      >
        {/* Identity is the PRODUCT, not the content it currently launches. No season, no chapter,
            no game — a build number belongs on the Play screen next to the build it describes, and
            the tagline describes what Nova is rather than what version of Fortnite it runs. */}
        <div className="flex flex-col items-center text-center mb-9">
          <div className="size-12 rounded-[var(--radius-md)] bg-accent/10 border border-accent/20 grid place-items-center text-accent mb-5">
            <Mark size={24} />
          </div>
          <h1 className="font-display text-2xl text-text">Project Nova</h1>
          <p className="text-sm text-text-2 mt-2">Player-hosted matches. No servers, no queues.</p>
        </div>

        <form onSubmit={submit} noValidate className="space-y-4">
          <AnimatePresence mode="popLayout" initial={false}>
            {mode === "signin" ? (
              <motion.div
                key="signin"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: tweenExit }}
                transition={tween}
              >
                <Field
                  ref={(el) => { firstField.current = el; fields.current.login = el; }}
                  label="Username or email"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  value={loginId}
                  onChange={(e) => { setLoginId(e.target.value); clearError("login"); }}
                  error={errors.login}
                />
              </motion.div>
            ) : (
              <motion.div
                key="signup"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: tweenExit }}
                transition={tween}
                className="space-y-4"
              >
                <Field
                  ref={(el) => { firstField.current = el; fields.current.username = el; }}
                  label="Username"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); clearError("username"); setFree((f) => ({ ...f, username: undefined })); }}
                  onBlur={(e) => checkField("username", e.target.value)}
                  error={errors.username}
                  valid={free.username === true}
                  hint="This becomes your name in game."
                />
                <Field
                  ref={(el) => { fields.current.email = el; }}
                  label="Email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  autoCapitalize="none"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); clearError("email"); setFree((f) => ({ ...f, email: undefined })); }}
                  onBlur={(e) => checkField("email", e.target.value)}
                  error={errors.email}
                  valid={free.email === true}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div layout>
            <Field
              ref={(el) => { fields.current.password = el; }}
              label="Password"
              reveal
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearError("password"); }}
              error={errors.password}
              hint={mode === "signup" ? "At least 8 characters." : undefined}
            />
          </motion.div>

          <motion.div layout className="pt-1">
            <Button type="submit" size="lg" loading={busy} className="w-full">
              {busy
                ? (mode === "signin" ? "Signing in…" : "Creating your account…")
                : (mode === "signin" ? "Sign in" : "Create account")}
              {!busy && <ArrowRight aria-hidden size={17} />}
            </Button>
          </motion.div>
        </form>

        <motion.p layout className="text-center text-sm text-text-2 mt-6">
          {mode === "signin" ? "New to Nova?" : "Already have an account?"}{" "}
          <button
            type="button"
            onClick={() => swap(mode === "signin" ? "signup" : "signin")}
            // inline-block + padding so the hit area clears the 24px minimum. It sits inside a
            // sentence, which exempts it from that rule — but it is the only route to sign-up, and
            // a 20px-tall primary action is mean regardless of what the rule permits.
            className="inline-block py-1 px-0.5 font-semibold text-accent hover:text-accent-hi cursor-pointer"
          >
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </motion.p>
      </motion.div>
    </div>
  );
}
