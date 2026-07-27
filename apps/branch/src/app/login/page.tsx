'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, apiClient } from '@foot-repose/contracts/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.login({ email, password });
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Invalid email or password'
          : 'Sign-in failed — please try again',
      );
      setBusy(false);
    }
  };

  return (
    <main className="page-center">
      <form
        className="card login-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="brand login-brand">
          <span className="brand-mark">FR</span>
          <div>
            <strong>Foot Repose</strong>
            <span className="brand-sub">Branch sign in</span>
          </div>
        </div>
        <label className="field">
          <span>Work email</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            placeholder="you@footrepose.example"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
