// src/screens/Account.tsx
// Your Nova account and the Fortnite account linked to it.
//
// Those two identities used to be invisible and easy to confuse — you signed into the launcher with
// one thing and the game quietly played as another. They're shown together here, plainly, because
// "which account am I actually playing as" is a real question this launcher has caused before.
import { useEffect, useState } from "react";
import { UserRound, Mail, Gamepad2, KeyRound, Copy, Check, ShieldAlert } from "lucide-react";
import { Button, Card, CardHeader, Field, Badge } from "../ui/primitives";
import { useToast } from "../ui/toast";
import { getProfile, changePassword, type Profile, type Session } from "../auth";
import { getAccountSummary, type AccountSummary } from "../novaApi";
import { formatDate, formatDateTime } from "../format";

export default function Account({ user }: { user: Session | null }) {
  const { notify } = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [copied, setCopied] = useState(false);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwError, setPwError] = useState<string | undefined>();

  useEffect(() => {
    if (!user?.accountId) return;
    getProfile(user.accountId).then(setProfile);
    if (user.token) {
      getAccountSummary(user.accountId, user.token, user.displayName).then(setSummary);
    }
  }, [user?.accountId, user?.token, user?.displayName]);

  const copyId = async () => {
    if (!user?.accountId) return;
    try {
      await navigator.clipboard.writeText(user.accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify({ kind: "error", title: "Couldn’t copy", body: "Clipboard access was refused." });
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(undefined);

    if (next.length < 8) { setPwError("Passwords need to be at least 8 characters."); return; }
    if (next !== confirm) { setPwError("These two don’t match."); return; }
    if (!user) return;

    setBusy(true);
    const res = await changePassword(user.username, current, next);
    setBusy(false);

    if (!res.ok) { setPwError(res.message || "Couldn’t change your password."); return; }
    setCurrent(""); setNext(""); setConfirm("");
    notify({ kind: "success", title: "Password changed", body: "Use it the next time you sign in." });
  };

  if (!user) return null;

  return (
    <div className="px-8 py-7 max-w-2xl">
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold text-text">Account</h1>
        <p className="text-[13px] text-muted mt-1">Your sign-in details and the game account they unlock.</p>
      </header>

      <div className="space-y-3.5">
        {/* ── Identity ──────────────────────────────────────────────────────────────────────── */}
        <Card>
          <div className="p-5 flex items-center gap-4">
            {/* Initial rather than an avatar upload — one less thing to host, and it's never empty. */}
            <div
              className="size-14 shrink-0 rounded-xl bg-frost/10 border border-frost/25 grid place-items-center text-frost font-display text-xl font-bold"
              aria-hidden
            >
              {user.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-display text-lg font-semibold text-text truncate">{user.displayName}</h2>
                {profile?.banned && <Badge tone="bad"><ShieldAlert aria-hidden size={11} />Banned</Badge>}
              </div>
              <p className="text-[13px] text-muted flex items-center gap-1.5 mt-0.5 truncate">
                <Mail aria-hidden size={13} className="shrink-0" />
                <span className="truncate selectable">{user.email}</span>
              </p>
            </div>
            {summary && (
              <div className="shrink-0 text-right">
                <div className="text-[10.5px] uppercase tracking-[0.08em] text-faint font-medium">V-Bucks</div>
                <div className="font-display text-lg font-bold text-beacon tabular-nums">{summary.vbucks.toLocaleString()}</div>
              </div>
            )}
          </div>

          <div className="px-5 pb-5 pt-0 grid sm:grid-cols-2 gap-3">
            <Detail icon={<UserRound aria-hidden size={14} />} label="Nova username" value={user.username} />
            <Detail
              icon={<Gamepad2 aria-hidden size={14} />}
              label="Linked Fortnite account"
              value={user.accountId}
              mono
              action={
                <button
                  onClick={copyId}
                  aria-label="Copy your Fortnite account id"
                  className="shrink-0 size-7 grid place-items-center rounded-md text-faint hover:text-text hover:bg-surface-3 cursor-pointer"
                >
                  {copied ? <Check aria-hidden size={13} className="text-good" /> : <Copy aria-hidden size={13} />}
                </button>
              }
            />
            {profile?.createdAt && (
              <Detail icon={<UserRound aria-hidden size={14} />} label="Joined" value={formatDate(profile.createdAt)} />
            )}
            {profile?.lastLogin && (
              <Detail icon={<KeyRound aria-hidden size={14} />} label="Last signed in" value={formatDateTime(profile.lastLogin)} />
            )}
          </div>
        </Card>

        {/* ── Password ──────────────────────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Change password" subtitle="You’ll use the new one next time you sign in." />
          <form onSubmit={savePassword} noValidate className="p-5 space-y-4">
            <Field
              label="Current password"
              reveal
              autoComplete="current-password"
              value={current}
              onChange={(e) => { setCurrent(e.target.value); setPwError(undefined); }}
            />
            <Field
              label="New password"
              reveal
              autoComplete="new-password"
              value={next}
              onChange={(e) => { setNext(e.target.value); setPwError(undefined); }}
              hint="At least 8 characters."
            />
            <Field
              label="Confirm new password"
              reveal
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setPwError(undefined); }}
              error={pwError}
            />
            <Button type="submit" loading={busy} disabled={!current || !next || !confirm}>
              {busy ? "Saving…" : "Change password"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function Detail({
  icon, label, value, mono, action,
}: {
  icon: React.ReactNode; label: string; value: string; mono?: boolean; action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-control)] bg-surface-2 border border-line px-3.5 py-2.5 flex items-center gap-2.5">
      <span className="text-faint shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] uppercase tracking-[0.08em] text-faint font-medium">{label}</div>
        <div className={`text-[13px] text-text truncate selectable ${mono ? "font-mono text-[12px]" : ""}`} title={value}>
          {value}
        </div>
      </div>
      {action}
    </div>
  );
}
