import { useMemo, useState } from 'react'

export type AuthMode = 'login' | 'signup'

export function AuthPage(props: {
  mode: AuthMode
  busy: boolean
  error: string | null
  message: string | null
  onSubmit: (email: string, password: string) => void
  onModeChange: (mode: AuthMode) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const title = useMemo(() => (props.mode === 'login' ? 'Log in' : 'Sign up'), [props.mode])
  const actionLabel = useMemo(() => (props.mode === 'login' ? 'Log in' : 'Create account'), [props.mode])
  const switchLabel = useMemo(
    () => (props.mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'),
    [props.mode],
  )
  const isPasswordValid = password.length > 6
  const isEmailValid = /^\S+@\S+\.\S+$/.test(email.trim())

  return (
    <div className="authShell">
      <div className="authCard">
        <div className="authIconRow">
          <img className="authIcon" src="/favicon.png" alt="DrillScout" />
        </div>
        <div className="authAppName">DrillScout</div>
        <div className="authTitle">{title}</div>
        <div className="authFields">
          <label>
            <div className="label">Email</div>
            <input
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              inputMode="email"
              type="email"
            />
          </label>
          <label>
            <div className="label">Password</div>
            <input
              autoComplete={props.mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              type="password"
            />
          </label>
        </div>
        {password && !isPasswordValid ? <div className="hint">Password must be more than 6 characters.</div> : null}
        {props.message ? <div className="success">{props.message}</div> : null}
        {props.error ? <div className="error">{props.error}</div> : null}
        <div className="buttons">
          <button
            className="btn primary"
            disabled={props.busy || !isEmailValid || !isPasswordValid}
            onClick={() => props.onSubmit(email.trim(), password)}
          >
            {props.busy ? 'Please wait…' : actionLabel}
          </button>
          <button
            className="btn"
            disabled={props.busy}
            onClick={() => props.onModeChange(props.mode === 'login' ? 'signup' : 'login')}
          >
            {switchLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
