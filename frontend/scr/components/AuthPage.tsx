import { useMemo, useState } from 'react'

export type AuthMode = 'login' | 'signup'

export function AuthPage(props: {
  mode: AuthMode
  busy: boolean
  error: string | null
  onSubmit: (username: string, password: string) => void
  onModeChange: (mode: AuthMode) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const title = useMemo(() => (props.mode === 'login' ? 'Log in' : 'Sign up'), [props.mode])
  const actionLabel = useMemo(() => (props.mode === 'login' ? 'Log in' : 'Create account'), [props.mode])
  const switchLabel = useMemo(
    () => (props.mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'),
    [props.mode],
  )

  return (
    <div className="authShell">
      <div className="authCard">
        <div className="authIconRow">
          <img className="authIcon" src="/favicon.png" alt="DrillScout" />
        </div>
        <div className="authTitle">{title}</div>
        <div className="authFields">
          <label>
            <div className="label">Username</div>
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              inputMode="text"
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
        {props.error ? <div className="error">{props.error}</div> : null}
        <div className="buttons">
          <button
            className="btn primary"
            disabled={props.busy || !username.trim() || !password}
            onClick={() => props.onSubmit(username.trim(), password)}
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

