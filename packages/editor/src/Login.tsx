import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [methods, setMethods] = useState<("password" | "magicLink")[]>(["password"]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  useEffect(() => {
    api
      .authMethods()
      .then((r) => setMethods(r.methods.length > 0 ? r.methods : ["password"]))
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendLink = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.requestLink(email);
      setLinkSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasPassword = methods.includes("password");
  const hasMagic = methods.includes("magicLink");

  if (linkSent) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="brand">editsy</div>
          <p className="login-sub">
            If <strong>{email}</strong> is an editor on this site, a login link is on its way.
            It's valid for 15 minutes, so you can close this tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">editsy</div>
        <p className="login-sub">Log in to edit this site's content.</p>
        <label className="field-label">Email</label>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        {hasPassword && (
          <>
            <label className="field-label">Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}
        {error && <p className="login-error">{error}</p>}
        {hasPassword && (
          <button className="primary-btn" disabled={busy || !email || !password}>
            {busy ? "…" : "Log in"}
          </button>
        )}
        {hasMagic && (
          <button
            type="button"
            className={hasPassword ? "ghost-btn" : "primary-btn"}
            disabled={busy || !email}
            onClick={sendLink}
          >
            {busy ? "…" : "Email me a login link"}
          </button>
        )}
      </form>
    </div>
  );
}
